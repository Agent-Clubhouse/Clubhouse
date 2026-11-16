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
export interface LocalWorkFile {
  version: 1;
  records: LocalWork[];
  current: Record<string, string[]>;
  /** Current input survives history eviction; it is never recovered by scanning unrelated records. */
  currentInputs?: Record<string, FederatedRequest[]>;
  currentBindings?: Record<string, Array<Omit<LocalWork, 'inputs'>>>;
}
export const LOCAL_WORK_MAX_BYTES = 16 * 1024 * 1024;
/** How long a record that no checkpoint followed waits before it is written alone. */
const LAZY_FLUSH_MS = 1000;

/** Keep only provenance. Task text and transitive work IDs must never enter this ledger. */
function slim(input: FederatedRequest): FederatedRequest {
  return {
    id: input.id, cause: structuredClone(input.cause), epoch: structuredClone(input.epoch), origin: structuredClone(input.origin),
    expiresAt: input.expiresAt, localRequestId: input.localRequestId,
    machineId: input.machineId, direction: input.direction, targetId: input.targetId,
    ...(input.localWorkIds?.length && { localWorkIds: [input.localWorkIds[input.localWorkIds.length - 1]] }),
  } as FederatedRequest;
}
function distinct(inputs: readonly FederatedRequest[], now = Date.now()): FederatedRequest[] {
  const causes = new Map<string, FederatedRequest>();
  for (const input of inputs) {
    if (input.expiresAt <= now) continue;
    const key = causeKey(input);
    const previous = causes.get(key);
    if (!previous || input.cause.depth >= previous.cause.depth) causes.set(key, slim(input));
  }
  return [...causes.values()];
}
const causeKey = (r: FederatedRequest) => JSON.stringify([r.id, r.machineId, r.origin?.machineId, r.origin?.agentId, r.epoch?.sender, r.epoch?.receiver]);
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
  let overflow: LocalWorkFile | undefined;
  const settings = createSettingsStore<LocalWorkFile>(filename, { version: 1, records: [], current: {} }, (raw) => {
    if (raw.version !== 1 || !Array.isArray(raw.records) || raw.records.length > FEDERATED_REQUEST_LIMITS.records || !raw.current || typeof raw.current !== 'object' || Array.isArray(raw.current)
      || !Object.values(raw.current).every((ids) => Array.isArray(ids) && ids.length <= FEDERATED_REQUEST_LIMITS.records && ids.every((id) => typeof id === 'string'))
      || !raw.records.every((r: LocalWork) => r && typeof r.id === 'string' && typeof r.sender === 'string' && typeof r.receiver === 'string'
        && typeof r.hash === 'string' && Number.isFinite(r.expiresAt) && Array.isArray(r.inputs)
        && r.inputs.every((input) => input?.epoch && input?.origin && input?.cause && Number.isFinite(input.expiresAt) && Number.isSafeInteger(input.cause.depth) && input.cause.depth >= 0))) throw new Error('Invalid local causal work');
    return raw as unknown as LocalWorkFile;
  }, { atomic: true, mode: 0o600, rollBackFailedSaves: true, onLoad: (result) => { if ('error' in result && (result.error as NodeJS.ErrnoException)?.code !== 'ENOENT') unreadable = true; } });
  let serial = Promise.resolve();
  // Changes made with `durable: false`: newest state, ahead of the file until the next save carries it.
  let pending: LocalWorkFile | undefined;
  let lazyFlush: ReturnType<typeof setTimeout> | undefined;
  const newest = () => overflow ?? pending ?? settings.get();
  /** Only `update` and `flush` call this, inside `serial`: one atomic write for everything pending. */
  async function persist(file: LocalWorkFile) {
    await settings.save(file);
    overflow = undefined; pending = undefined;
  }
  /** Writes anything a deferred update left behind. Idle when the file is already current. */
  function flush() {
    if (lazyFlush) { clearTimeout(lazyFlush); lazyFlush = undefined; }
    const next = serial.catch(() => {}).then(async () => { if (pending) await persist(pending); });
    serial = next; return next;
  }
  return {
    settled: () => serial,
    flush,
    get: () => { const file = newest(); if (unreadable) throw new Error('Local causal work records are unreadable.'); return structuredClone(file); },
    /**
     * Applies `change`, then by default writes the whole file before resolving. A `durable: false` change is applied
     * in memory at once and rides on the next durable write, or on a write a moment later if none comes, so a
     * record and the checkpoint that follows it cost one fsync together.
     */
    update(change: (file: LocalWorkFile) => void, { durable = true }: { durable?: boolean } = {}) {
      const next = serial.catch(() => {}).then(async () => {
        const file = structuredClone(newest()); if (unreadable) throw new Error('Local causal work records are unreadable.'); change(file);
        const now = Date.now();
        file.records = file.records.filter((r) => r.expiresAt > now).map((r) => ({ ...r, inputs: distinct(r.inputs, now) }));
        for (const [agent, inputs] of Object.entries(file.currentInputs ?? {})) {
          const live = distinct(inputs, now);
          if (live.length) file.currentInputs![agent] = live; else { delete file.currentInputs![agent]; delete file.current[agent]; if (file.currentBindings) delete file.currentBindings[agent]; }
        }
        // History is expendable. Current turn provenance also lives in its own
        // durable checkpoint, so eviction cannot turn a resumed task into a root.
        const current = new Set(Object.values(file.current).flat());
        while (file.records.length > FEDERATED_REQUEST_LIMITS.records || (file.records.length && Buffer.byteLength(JSON.stringify(file)) > LOCAL_WORK_MAX_BYTES)) {
          const inactive = file.records.findIndex((r) => !current.has(r.id));
          file.records.splice(inactive < 0 ? 0 : inactive, 1);
        }
        // If current checkpoints alone exceed disk capacity, retain their full
        // depth in main memory. Capacity never rejects a send or invents a root.
        if (Buffer.byteLength(JSON.stringify(file)) > LOCAL_WORK_MAX_BYTES) { overflow = file; pending = undefined; return; }
        if (!durable) {
          // The file fits again, so this supersedes any overflow copy instead of hiding behind it.
          overflow = undefined; pending = file;
          lazyFlush ??= setTimeout(() => { lazyFlush = undefined; void flush().catch((error) => appLog('core:dispatcher', 'error', 'Could not save local causal work', { meta: { error: String(error) } })); }, LAZY_FLUSH_MS);
          lazyFlush.unref?.();
          return;
        }
        // A failed write drops this change only; earlier deferred ones stay pending for the next write.
        const before = { overflow, pending };
        try { await persist(file); } catch (error) { ({ overflow, pending } = before); throw error; }
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
function assignedWork(file: LocalWorkFile, target: string): LocalWork[] {
  const ids = currentIds(file, target);
  const records = file.records.filter((r) => r.receiver === target && ids.includes(r.id));
  for (const binding of file.currentBindings?.[target] ?? []) {
    if (ids.includes(binding.id) && !records.some((r) => r.id === binding.id)) records.push({ ...binding, inputs: (file.currentInputs?.[target] ?? []).filter((r) => r.localWorkIds?.includes(binding.id)) });
  }
  return records;
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
  const resumed = () => distinct(file.currentInputs?.[target] ?? file.records.filter((r) => r.receiver === target && r.expiresAt > now && currentIds(file, target).includes(r.id)).flatMap((r) => r.inputs), now);
  if (!caller) return resume ? resumed() : [];
  const task = taskId ?? (typeof caller.args.task_id === 'string' ? caller.args.task_id : undefined);
  const owned = assignedWork(file, caller.sender).filter((r) => r.expiresAt > now && r.sender === target
    && currentIds(file, caller.sender).includes(r.id) && task !== undefined && r.taskId === task);
  const active = federationTurnInputs(caller.sender).filter((r) => live(r, now));
  const restored = owned.flatMap((r) => r.inputs.filter((input) => live(input, now)));
  // An omitted/different task id cannot recover another assignment. It still
  // inherits every active turn input, including a main-restored wake checkpoint.
  const inputs = distinct([...active, ...restored], now);
  if (!inputs.length && resume) return resumed();
  if (!inputs.length) return [];
  return bindLocalCausalInputs(caller.sender, target, task, payload, inputs);
}

/**
 * A record is history. What a restart needs is the checkpoint that `activateLocalCausalInput` writes before the
 * work is dispatched, and that checkpoint carries its own binding and inputs. A send acknowledged to an agent is
 * only ever acknowledged after that write, which saves the record too, so by default the record rides on it
 * instead of costing a write of its own. A caller whose acknowledgement comes before any checkpoint passes `durable`.
 */
const DEFERRED = { durable: false };
/** Main-owned delayed work binds its immutable snapshot before the initiating tool returns. `durable` writes it before that. */
export async function bindLocalCausalInputs(sender: string, target: string, task: string | undefined, payload: unknown, original: readonly FederatedRequest[], durable = false): Promise<readonly FederatedRequest[]> {
  const now = Date.now(); const inputs = distinct(original, now);
  if (!inputs.length) return [];
  await store().settled();
  const file = store().get();
  const hash = deliveryHash([sender, target, task, payload]);
  // Repeated prose or a recycled caller label is not proof of the same work.
  // Only a named task with an input still in this causal scope can reuse history.
  const previous = task === undefined ? undefined : file.records.find((r) => r.sender === sender && r.receiver === target && r.taskId === task && r.hash === hash && r.expiresAt > now
    && r.inputs.some((old) => inputs.some((input) => causeKey(input) === causeKey(old))));
  if (previous) {
    const merged = distinct([...previous.inputs, ...inputs], now).map((r) => ({ ...r, targetId: target, localWorkIds: [previous.id] }));
    await store().update((saved) => { const retained = saved.records.find((r) => r.id === previous.id); if (retained) { retained.inputs = merged; retained.expiresAt = Math.max(...merged.map((r) => r.expiresAt)); } }, durable ? undefined : DEFERRED);
    return merged;
  }
  const id = randomUUID();
  const expiresAt = Math.min(now + FEDERATED_REQUEST_LIMITS.ttl, Math.max(...inputs.map((r) => r.expiresAt)));
  const tagged = inputs.map((r) => ({ ...r, targetId: target, localWorkIds: [id] }));
  await store().update((saved) => {
    saved.records = saved.records.filter((r) => r.expiresAt > now);
    saved.records.push({ id, sender, receiver: target, taskId: task, hash, expiresAt, inputs: tagged });
  }, durable ? undefined : DEFERRED);
  return tagged;
}

export async function withLocalCausalInput<T>(target: string, task: string | undefined, payload: unknown, deliver: () => Promise<T>, resume = false): Promise<T> {
  if (hasFederationInputScope() || (!callerNow() && !resume)) return deliver();
  const inputs = await localCausalInputs(target, task, payload, resume);
  return withFederationInputs(inputs, deliver);
}
/** Persist the task(s) actually dispatched, not merely a queued input. Unrelated input clears association. */
export async function activateLocalCausalInput(target: string, inputs: readonly FederatedRequest[]): Promise<() => Promise<void>> {
  const projected = distinct(inputs);
  const ids = [...new Set(projected.flatMap((r) => r.localWorkIds ?? []))];
  if (!retained && !ids.length) return async () => {};
  const previousFile = store().get();
  const previous = [...currentIds(previousFile, target)];
  const previousInputs = previousFile.currentInputs?.[target] ?? [];
  const previousBindings = previousFile.currentBindings?.[target] ?? [];
  const revision = (assignments.get(target)?.revision ?? 0) + 1;
  assignments.set(target, { ids, revision });
  const changed = JSON.stringify(previous) !== JSON.stringify(ids) || JSON.stringify(previousInputs) !== JSON.stringify(projected);
  if (changed) {
    await store().update((file) => {
      const work = [...file.records, ...assignedWork(file, target)].filter((r, i, all) => ids.includes(r.id) && all.findIndex((other) => other.id === r.id) === i);
      if (ids.length) file.current[target] = ids; else delete file.current[target];
      if (projected.length) (file.currentInputs ??= {})[target] = projected; else if (file.currentInputs) delete file.currentInputs[target];
      if (work.length) (file.currentBindings ??= {})[target] = work.map(({ inputs: _inputs, ...binding }) => binding);
      else if (file.currentBindings) delete file.currentBindings[target];
    });
  } else await store().settled();
  return async () => {
    if (!changed) return;
    // A synchronous provider hook already observed the input: acceptance is ambiguous.
    if (assignments.get(target)?.revision !== revision) return;
    assignments.set(target, { ids: previous, revision: revision + 1 });
    await store().update((file) => {
      if (assignments.get(target)?.revision !== revision + 1) return;
      if (previous.length) file.current[target] = previous; else delete file.current[target];
      if (previousInputs.length) (file.currentInputs ??= {})[target] = previousInputs; else if (file.currentInputs) delete file.currentInputs[target];
      if (previousBindings.length) (file.currentBindings ??= {})[target] = previousBindings; else if (file.currentBindings) delete file.currentBindings[target];
    });
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
  return assignedWork(file, worker).filter((r) => r.sender === reader && r.expiresAt > now)
    .flatMap((r) => r.inputs.filter((input) => live(input, now)).map((input) => ({ ...input, targetId: reader })));
}
export function _setLocalWorkStoreForTesting(value?: ReturnType<typeof createLocalWorkStore>): void { retained = value; assignments.clear(); saveError = undefined; }
export async function _settleLocalWorkForTesting(): Promise<void> { await retained?.flush(); }
