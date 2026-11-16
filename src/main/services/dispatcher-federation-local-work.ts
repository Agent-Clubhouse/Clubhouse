/** Durable, main-only lineage for local delegations and their bound results. */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { FEDERATED_REQUEST_LIMITS, type FederatedRequest } from '../../shared/dispatcher-federation-requests';
import { createSettingsStore } from './settings-store';
import { deliveryHash } from './annex-delivery-store';
import { captureFederationInputs, hasFederationInputScope, federationTurnInputs, withFederationInputs, onFederationTurnInput } from './dispatcher-federation-context';
import { appLog } from './log-service';

interface LocalWork {
  id: string;
  sender: string;
  receiver: string;
  taskId?: string;
  hash: string;
  expiresAt: number;
  inputs: FederatedRequest[];
}
export interface LocalWorkFile { version: 1; records: LocalWork[]; current: Record<string, string[]> }
const call = new AsyncLocalStorage<{ sender: string; args: Record<string, unknown>; active: boolean }>();
export function withLocalCausalCall<T>(sender: string, args: Record<string, unknown>, run: () => T): T {
  const scope = { sender, args, active: true };
  return call.run(scope, () => {
    try { const result = run(); if (result instanceof Promise) return result.finally(() => { scope.active = false; }) as T; scope.active = false; return result; }
    catch (err) { scope.active = false; throw err; }
  });
}
const callerNow = () => { const scope = call.getStore(); return scope?.active ? scope : undefined; };
export function hasLocalCausalCall(): boolean { return !!callerNow(); }
export function localCallInputs(): FederatedRequest[] { const caller = callerNow(); return caller ? federationTurnInputs(caller.sender) : []; }

export function createLocalWorkStore(filename = 'dispatcher-federation-local-work.json') {
  let unreadable = false;
  const settings = createSettingsStore<LocalWorkFile>(filename, { version: 1, records: [], current: {} }, (raw) => {
    if (raw.version !== 1 || !Array.isArray(raw.records) || raw.records.length > FEDERATED_REQUEST_LIMITS.records || !raw.current || typeof raw.current !== 'object' || Array.isArray(raw.current)
      || !Object.values(raw.current).every((ids) => Array.isArray(ids) && ids.length <= FEDERATED_REQUEST_LIMITS.records && ids.every((id) => typeof id === 'string'))
      || !raw.records.every((r: LocalWork) => r && typeof r.id === 'string' && typeof r.sender === 'string' && typeof r.receiver === 'string'
        && typeof r.hash === 'string' && Number.isFinite(r.expiresAt) && Array.isArray(r.inputs)
        && r.inputs.every((input) => input?.epoch && input?.origin && input?.cause && Number.isFinite(input.expiresAt) && Number.isSafeInteger(input.cause.depth) && input.cause.depth >= 0))) throw new Error('Invalid local causal work');
    return raw as unknown as LocalWorkFile;
  }, { atomic: true, mode: 0o600, rollBackFailedSaves: true, onLoad: (result) => { if ('error' in result && (result.error as NodeJS.ErrnoException)?.code !== 'ENOENT') unreadable = true; } });
  let serial = Promise.resolve();
  return {
    settled: () => serial,
    get: () => { const file = settings.get(); if (unreadable) throw new Error('Local causal work records are unreadable.'); return structuredClone(file); },
    update(change: (file: LocalWorkFile) => void) {
      const next = serial.catch(() => {}).then(async () => {
        const file = structuredClone(settings.get()); if (unreadable) throw new Error('Local causal work records are unreadable.'); change(file);
        if (file.records.length > FEDERATED_REQUEST_LIMITS.records || Buffer.byteLength(JSON.stringify(file)) > 16 * 1024 * 1024) throw new Error('Local causal work records are full.');
        await settings.save(file);
      });
      serial = next; return next;
    },
  };
}
let retained: ReturnType<typeof createLocalWorkStore> | undefined;
const store = () => retained ??= createLocalWorkStore();
const live = (r: FederatedRequest, now: number) => r.expiresAt > now;
const assignments = new Map<string, { ids: string[]; revision: number }>();
let saveError: unknown;
function currentIds(file: LocalWorkFile, target: string): readonly string[] {
  if (saveError) throw saveError;
  return assignments.get(target)?.ids ?? file.current[target] ?? [];
}

/** Called once at a local send/wake boundary; caller identity comes from authorized main tool dispatch. */
export async function localCausalInputs(target: string, taskId: string | undefined, payload: unknown, resume = false): Promise<readonly FederatedRequest[]> {
  const explicit = captureFederationInputs();
  if (hasFederationInputScope()) return explicit;
  const caller = callerNow();
  if (!caller && !retained && !resume) return [];
  await store().settled();
  const now = Date.now();
  const file = store().get();
  if (!caller) return resume ? file.records.filter((r) => r.receiver === target && r.expiresAt > now && currentIds(file, target).includes(r.id)).flatMap((r) => r.inputs.filter((input) => live(input, now))) : [];
  const task = taskId ?? (typeof caller.args.task_id === 'string' ? caller.args.task_id : undefined);
  const owned = file.records.filter((r) => r.expiresAt > now && r.receiver === caller.sender && r.sender === target
    && currentIds(file, caller.sender).includes(r.id) && (task === undefined || r.taskId === task));
  const active = federationTurnInputs(caller.sender).filter((r) => live(r, now));
  const restored = owned.flatMap((r) => r.inputs.filter((input) => live(input, now)));
  const inputs = [...active, ...restored];
  if (!inputs.length && resume) return file.records.filter((r) => r.receiver === target && r.expiresAt > now && currentIds(file, target).includes(r.id)).flatMap((r) => r.inputs.filter((input) => live(input, now)));
  if (!inputs.length) return [];
  return bindLocalCausalInputs(caller.sender, target, task, payload, inputs, owned.map((r) => r.id));
}

/** Main-owned delayed work binds its immutable snapshot before the initiating tool returns. */
export async function bindLocalCausalInputs(sender: string, target: string, task: string | undefined, payload: unknown, original: readonly FederatedRequest[], owned: string[] = []): Promise<readonly FederatedRequest[]> {
  const now = Date.now(); const inputs = original.filter((r) => live(r, now));
  if (!inputs.length) return [];
  await store().settled();
  const file = store().get();
  const hash = deliveryHash([sender, target, task, payload]);
  const previous = file.records.find((r) => r.sender === sender && r.receiver === target && r.taskId === task && r.hash === hash && r.expiresAt > now);
  if (previous) {
    const retainedInputs = previous.inputs.filter((r) => live(r, now));
    if (Math.max(...inputs.map((r) => r.cause.depth)) > Math.max(...retainedInputs.map((r) => r.cause.depth))) throw new Error('This local task result is already bound to earlier causation.');
    return retainedInputs;
  }
  const id = randomUUID();
  const ids = [...new Set([...inputs.flatMap((r) => r.localWorkIds ?? []), ...owned, id])];
  const expiresAt = Math.min(now + FEDERATED_REQUEST_LIMITS.ttl, Math.max(...inputs.map((r) => r.expiresAt)));
  const tagged = inputs.map((r) => ({ ...structuredClone(r), targetId: target, localWorkIds: ids }));
  await store().update((saved) => {
    saved.records = saved.records.filter((r) => r.expiresAt > now);
    const retainedIds = new Set(saved.records.map((r) => r.id));
    for (const [agent, current] of Object.entries(saved.current)) {
      const kept = current.filter((id) => retainedIds.has(id));
      if (kept.length) saved.current[agent] = kept; else delete saved.current[agent];
    }
    saved.records.push({ id, sender, receiver: target, taskId: task, hash, expiresAt, inputs: tagged });
  });
  return tagged;
}

export async function withLocalCausalInput<T>(target: string, task: string | undefined, payload: unknown, deliver: () => Promise<T>, resume = false): Promise<T> {
  if (hasFederationInputScope() || (!callerNow() && !resume)) return deliver();
  const inputs = await localCausalInputs(target, task, payload, resume);
  return withFederationInputs(inputs, deliver);
}
/** Persist the task(s) actually dispatched, not merely a queued input. Unrelated input clears association. */
export async function activateLocalCausalInput(target: string, inputs: readonly FederatedRequest[]): Promise<() => Promise<void>> {
  const ids = [...new Set(inputs.flatMap((r) => r.localWorkIds ?? []))];
  if (!retained && !ids.length) return async () => {};
  const previous = [...currentIds(store().get(), target)];
  const revision = (assignments.get(target)?.revision ?? 0) + 1;
  assignments.set(target, { ids, revision });
  if (JSON.stringify(previous) !== JSON.stringify(ids)) await store().update((file) => { if (ids.length) file.current[target] = ids; else delete file.current[target]; });
  else await store().settled();
  return async () => {
    // A synchronous provider hook already observed the input: acceptance is ambiguous.
    if (assignments.get(target)?.revision !== revision) return;
    await activateLocalCausalInput(target, previous.map((id) => ({ localWorkIds: [id] }) as FederatedRequest));
  };
}
onFederationTurnInput((target, inputs) => {
  // Raw terminal input bypasses runtime.sendMessage. Update the in-memory binding
  // synchronously before its first tool, then serialize the durable save.
  void activateLocalCausalInput(target, inputs).catch((error) => {
    saveError = error;
    appLog('core:dispatcher', 'error', 'Could not save local causal assignment', { meta: { error: String(error) } });
  });
});
export function savedLocalWorkInputs(sender: string, target: string, task: string, payload: unknown): FederatedRequest[] {
  const hash = deliveryHash([sender, target, task, payload]);
  return store().get().records.filter((r) => r.sender === sender && r.receiver === target && r.taskId === task && r.hash === hash && r.expiresAt > Date.now()).flatMap((r) => r.inputs.filter((input) => live(input, Date.now())));
}
/** A read_output result is linked to the specific work currently assigned to that worker. */
export function localOutputInputs(reader: string, worker: string): FederatedRequest[] {
  const file = store().get(); const now = Date.now();
  return file.records.filter((r) => r.sender === reader && r.receiver === worker && r.expiresAt > now && currentIds(file, worker).includes(r.id))
    .flatMap((r) => r.inputs.filter((input) => live(input, now)).map((input) => ({ ...input, targetId: reader })));
}
export function _setLocalWorkStoreForTesting(value?: ReturnType<typeof createLocalWorkStore>): void { retained = value; assignments.clear(); saveError = undefined; }
export async function _settleLocalWorkForTesting(): Promise<void> { await retained?.settled(); }
