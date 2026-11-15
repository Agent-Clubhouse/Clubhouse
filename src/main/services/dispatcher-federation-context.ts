/** Main-only provenance of input actually delivered into a controller turn. */
import { AsyncLocalStorage } from 'async_hooks';
import type { FederatedRequest } from '../../shared/dispatcher-federation-requests';
import type { MessageDelivery } from '../../shared/chat';
import { onChatEvent } from './agent-runtime/chat-event-bus';
import { onAppEvent } from './app-event-bus';

const input = new AsyncLocalStorage<{ request: FederatedRequest; active: boolean }>();
export function captureFederationInput(): FederatedRequest | undefined {
  const scope = input.getStore();
  return scope?.active ? scope.request : undefined;
}
export function withFederationInput<T>(request: FederatedRequest, deliver: () => T): T {
  const scope = { request, active: true };
  return input.run(scope, () => {
    try {
      const result = deliver();
      if (result instanceof Promise) return result.finally(() => { scope.active = false; }) as T;
      scope.active = false;
      return result;
    } catch (err) { scope.active = false; throw err; }
  });
}

/** Pending input is registered before I/O: a provider may start and call tools before send returns. */
export function createFederationTurnContext() {
  let open = false;
  let started = 0;
  const pending = new Map<symbol, FederatedRequest>();
  const active = new Map<symbol, FederatedRequest>();
  return {
    isOpen: () => open,
    inputs: () => [...active.values(), ...(!open ? pending.values() : [])],
    start() {
      open = true; started++;
      active.clear();
      for (const [key, value] of pending) active.set(key, value);
      pending.clear();
    },
    end() { open = false; active.clear(); },
    clear() { open = false; active.clear(); pending.clear(); },
    prepare(request: FederatedRequest, delivery: MessageDelivery = 'prompt') {
      const atStart = started;
      const key = Symbol();
      pending.set(key, structuredClone(request));
      if (open && delivery === 'steer') { active.set(key, structuredClone(request)); pending.delete(key); }
      return {
        accepted(delivery: MessageDelivery | 'woke' | undefined) {
          if (delivery === 'queued' && started === atStart) {
            active.delete(key);
            pending.set(key, structuredClone(request));
          } else if (delivery === 'steer' && open && pending.has(key)) {
            active.set(key, pending.get(key)!); pending.delete(key);
          }
        },
        refused() { pending.delete(key); if (started === atStart) active.delete(key); },
      };
    },
  };
}
const controllers = new Map<string, ReturnType<typeof createFederationTurnContext>>();
export function federationTurnOpen(agentId: string): boolean { return controllers.get(agentId)?.isOpen() ?? false; }
export function federationTurnInputs(agentId: string): FederatedRequest[] { return controllers.get(agentId)?.inputs() ?? []; }
export function startFederationTurnTracking(agentId: string): () => void {
  const context = createFederationTurnContext();
  controllers.set(agentId, context);
  const stopChat = onChatEvent((event) => {
    if (event.agentId !== agentId) return;
    if (event.type === 'turn_started') context.start();
    if (event.type === 'turn_ended') context.end();
    if ((event.type === 'notice' && event.data.code === 'context_cleared') || event.type === 'session_ended' || (event.type === 'session_state' && event.data.state === 'error')) context.clear();
  });
  const stopApp = onAppEvent((event) => {
    if (!('agentId' in event) || event.agentId !== agentId) return;
    // Chat has precise events above; hooks supply the terminal runtime's boundaries.
    if (event.type === 'turn.started' && event.via !== 'chat' && !event.continuation) context.start();
    if (event.type === 'turn.ended' && event.via !== 'chat') context.end();
    if (event.type === 'agent.asleep' || event.type === 'agent.deleted') context.clear();
  });
  return () => { stopChat(); stopApp(); context.clear(); if (controllers.get(agentId) === context) controllers.delete(agentId); };
}
/** Called at the runtime input boundary, after grants/readiness checks. */
export function prepareFederationInput(agentId: string, request = captureFederationInput(), delivery: MessageDelivery = 'prompt') {
  return request && controllers.get(agentId)?.prepare(request, delivery);
}
