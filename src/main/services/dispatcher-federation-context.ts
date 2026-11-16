/** Main-only provenance of input actually delivered into an agent turn. */
import { AsyncLocalStorage } from 'async_hooks';
import { FEDERATED_REQUEST_LIMITS, type FederatedRequest } from '../../shared/dispatcher-federation-requests';
import type { MessageDelivery } from '../../shared/chat';
import { onChatEvent } from './agent-runtime/chat-event-bus';
import { HOOK_TURN_STALE_MS, hookTurnActivity, onAppEvent } from './app-event-bus';

const input = new AsyncLocalStorage<{ requests: readonly FederatedRequest[]; active: boolean }>();
export function hasFederationInputScope(): boolean { return input.getStore()?.active === true; }
export function captureFederationInputs(): readonly FederatedRequest[] {
  const scope = input.getStore();
  return scope?.active ? scope.requests : [];
}
export function captureFederationInput(): FederatedRequest | undefined { return captureFederationInputs()[0]; }
export function withFederationInputs<T>(requests: readonly FederatedRequest[], deliver: () => T): T {
  const scope = { requests, active: true };
  return input.run(scope, () => {
    try {
      const result = deliver();
      if (result instanceof Promise) return result.finally(() => { scope.active = false; }) as T;
      scope.active = false; return result;
    } catch (err) { scope.active = false; throw err; }
  });
}
export function withFederationInput<T>(request: FederatedRequest, deliver: () => T): T { return withFederationInputs([request], deliver); }

/** Input is registered at dispatch, before a provider can synchronously call tools. */
export function createFederationTurnContext(now = () => Date.now()) {
  let open = false;
  let terminal = false;
  let activity = now();
  let started = 0;
  const pending = new Map<symbol, { request: FederatedRequest; at: number }>();
  const active = new Map<symbol, FederatedRequest>();
  const capPending = () => {
    while (pending.size > FEDERATED_REQUEST_LIMITS.queued) {
      // Coalesced messages can contain more parents than queue slots. Compact
      // shallow entries first; forgetting a deep parent would weaken the breaker.
      const shallowest = [...pending].sort(([, a], [, b]) => (a.request.cause?.depth ?? 0) - (b.request.cause?.depth ?? 0))[0][0];
      pending.delete(shallowest);
    }
  };
  const prune = () => {
    for (const [key, entry] of pending) if ((entry.request.expiresAt ?? entry.at + FEDERATED_REQUEST_LIMITS.ttl) <= now()) pending.delete(key);
    for (const [key, request] of active) if ((request.expiresAt ?? Infinity) <= now()) active.delete(key);
    if (terminal && now() - activity >= HOOK_TURN_STALE_MS) open = false;
  };
  return {
    promptDelivery() { prune(); if (!open) pending.clear(); },
    touch(at: number) { activity = Math.max(activity, at); },
    isOpen() { prune(); return open || [...pending.values()].some((entry) => now() - entry.at < HOOK_TURN_STALE_MS); },
    inputs() { prune(); return [...active.values(), ...(!open ? [...pending.values()].map((p) => p.request) : [])]; },
    start(prompt = true, via: 'chat' | 'hook' = 'chat') {
      prune(); open = true; terminal = via === 'hook'; activity = now(); started++;
      // A post-Stop tool hook is a continuation, not evidence of independent work.
      if (prompt || pending.size) {
        active.clear();
        for (const [key, value] of pending) active.set(key, value.request);
        pending.clear();
      }
    },
    end() { open = false; },
    clear() { open = false; active.clear(); pending.clear(); },
    prepare(request: FederatedRequest, delivery: MessageDelivery = 'prompt', append = false) {
      prune();
      if (!open && delivery === 'prompt' && !append) pending.clear();
      const atStart = started;
      const key = Symbol();
      pending.set(key, { request: structuredClone(request), at: now() });
      capPending();
      if (open && delivery === 'steer') { active.set(key, structuredClone(request)); pending.delete(key); }
      return {
        accepted(delivered: MessageDelivery | 'woke' | undefined) {
          if (delivered === 'queued' && started === atStart) { active.delete(key); pending.set(key, { request: structuredClone(request), at: now() }); }
          else if (delivered === 'steer' && open && pending.has(key)) { active.set(key, pending.get(key)!.request); pending.delete(key); }
          prune();
          capPending();
        },
        refused() { pending.delete(key); if (started === atStart) active.delete(key); },
      };
    },
  };
}
const agents = new Map<string, ReturnType<typeof createFederationTurnContext>>();
const turnInputListeners = new Set<(agentId: string, inputs: FederatedRequest[]) => void>();
export function onFederationTurnInput(listener: (agentId: string, inputs: FederatedRequest[]) => void): () => void {
  turnInputListeners.add(listener); return () => { turnInputListeners.delete(listener); };
}
function startedInput(agentId: string, context: ReturnType<typeof createFederationTurnContext>) {
  for (const listener of turnInputListeners) listener(agentId, context.inputs());
}
export function federationTurnOpen(agentId: string): boolean {
  const context = agents.get(agentId); const activity = hookTurnActivity(agentId);
  if (activity !== undefined) context?.touch(activity);
  return context?.isOpen() ?? false;
}
export function federationTurnInputs(agentId: string): FederatedRequest[] { return agents.get(agentId)?.inputs() ?? []; }
export function startFederationTurnTracking(agentId: string): () => void {
  const context = createFederationTurnContext(); agents.set(agentId, context);
  const stopChat = onChatEvent((event) => {
    if (event.agentId !== agentId) return;
    if (event.type === 'turn_started') { context.start(); startedInput(agentId, context); }
    if (event.type === 'turn_ended') context.end();
    if ((event.type === 'notice' && event.data.code === 'context_cleared') || event.type === 'session_ended' || (event.type === 'session_state' && event.data.state === 'error')) context.clear();
  });
  const stopApp = onAppEvent((event) => {
    if (!('agentId' in event) || event.agentId !== agentId) return;
    if (event.type === 'turn.started' && event.via !== 'chat') { context.start(!!event.prompt, 'hook'); startedInput(agentId, context); }
    if (event.type === 'turn.ended' && event.via !== 'chat') context.end();
    if (event.type === 'agent.asleep' || event.type === 'agent.deleted') context.clear();
  });
  return () => { stopChat(); stopApp(); context.clear(); if (agents.get(agentId) === context) agents.delete(agentId); };
}
export function prepareFederationInput(agentId: string, request = captureFederationInput(), delivery: MessageDelivery = 'prompt', append = false) {
  if (!request) return;
  if (!agents.has(agentId)) startFederationTurnTracking(agentId);
  return agents.get(agentId)!.prepare(request, delivery, append);
}
export function prepareFederationInputs(agentId: string, requests = captureFederationInputs(), delivery: MessageDelivery = 'prompt') {
  if (!requests.length && delivery === 'prompt') agents.get(agentId)?.promptDelivery();
  return requests.map((request, i) => prepareFederationInput(agentId, request, delivery, i > 0));
}
