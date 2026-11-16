/**
 * Replicated record sets shared by Annex Network computers, such as project
 * links and linked project state. The pinned-member REST replication precedent
 * from group-project-network, with agent-delivery-capabilities-style probing.
 * /network remains strictly membership-only. Old peers are simply skipped.
 *
 * Each set is a durable replica whose merge is idempotent and commutative, so
 * a computer pushes its full set in bounded pages, then pulls the other's by
 * cursor, on connect, reconnect, membership change and local change.
 */
import { appLog } from './log-service';

export interface ReplicaChange { source?: string; recordsChanged: boolean }
export interface ReplicaStore<R> {
  migrate(): Promise<unknown>;
  records(): R[];
  page(after?: string): { records: R[]; next?: string };
  merge(raw: unknown, source: string, current?: () => boolean): Promise<unknown>;
  onChange(listener: (change: ReplicaChange) => void): () => void;
}
export interface ReplicaSpec<R> {
  /** Singular and plural nouns for errors and logs, e.g. "project link" / "project links". */
  noun: string;
  plural: string;
  capabilitiesPath: string;
  syncPath: string;
  pageSize: number;
  maxRecords: number;
  parse(raw: unknown, max: number): R[];
  /** `parse`, without records clocked too far ahead. */
  parseIncoming(raw: unknown, max: number): R[];
  /** The record's sort key; page cursors are keys. */
  keyOf(record: R): string;
}
export interface ReplicaNetworkOptions {
  transport: {
    connected(machine: string): boolean;
    post(machine: string, path: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
    onConnected(listener: (machine: string) => void): () => void;
  };
  members(): string[];
  isMember(machine: string): boolean;
  /** A pin or pairing change invalidates in-flight publications. */
  pairing(machine: string): string | undefined;
  onMembershipChanged(listener: () => void): () => void;
  /**
   * A machine's records are fully synced (pushed and pulled with no error) or no
   * longer known to be: a reconnect, a pairing change, a failure, or a peer
   * without this sync. Readers who would conclude "absent" from the records need it.
   */
  onSynced?(machine: string, synced: boolean): void;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const replicaCapabilities = (spec: Pick<ReplicaSpec<unknown>, 'pageSize'>) => ({ version: 1 as const, maxRecords: spec.pageSize });

/** Called only after annex-server authenticates a currently pinned member desktop. */
export async function receiveReplica<R>(spec: ReplicaSpec<R>, store: ReplicaStore<R>, source: string, raw: unknown, current: () => boolean): Promise<Record<string, unknown>> {
  const changed = `${capital(spec.noun)} pairing changed.`;
  if (!object(raw) || raw.version !== 1 || Object.keys(raw).some((k) => !['version', 'records', 'after', 'read'].includes(k))
    || raw.read !== undefined && typeof raw.read !== 'boolean'
    || raw.after !== undefined && (typeof raw.after !== 'string' || raw.after.length > 2300)) throw new Error(`Invalid ${spec.plural} request.`);
  const records = raw.records === undefined ? [] : spec.parseIncoming(raw.records, spec.pageSize);
  if (!current()) throw new Error(changed);
  await store.migrate();
  if (!current()) throw new Error(changed);
  if (records.length) await store.merge(records, source, current);
  if (!current()) throw new Error(changed);
  return { version: 1, ...(raw.read === false ? {} : store.page(raw.after as string | undefined)) };
}

export function startReplicaNetwork<R>(spec: ReplicaSpec<R>, store: ReplicaStore<R>, options: ReplicaNetworkOptions): () => void {
  const Noun = capital(spec.noun);
  let stopped = false;
  const supported = new Map<string, boolean>();
  const generations = new Map<string, number>();
  const running = new Set<string>(), dirty = new Set<string>();
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  const setSynced = (machine: string, synced: boolean) => options.onSynced?.(machine.toLowerCase(), synced);
  const online = (machine: string) => !stopped && options.isMember(machine) && options.transport.connected(machine);
  const queue = (machine: string) => {
    machine = machine.toLowerCase();
    if (!online(machine)) return;
    dirty.add(machine);
    if (!running.has(machine)) void sync(machine);
  };
  const sync = async (machine: string): Promise<void> => {
    running.add(machine);
    const pairing = options.pairing(machine), generation = generations.get(machine);
    const current = () => online(machine) && options.pairing(machine) === pairing && generations.get(machine) === generation;
    const post = async (path: string, body: Record<string, unknown>) => {
      if (!current()) throw new Error(`${Noun} pairing changed.`);
      const response = await options.transport.post(machine, path, body);
      if (!current()) throw new Error(`${Noun} pairing changed.`);
      return response;
    };
    try {
      await store.migrate();
      while (current() && dirty.delete(machine)) {
        if (!supported.has(machine)) {
          const probe = await post(spec.capabilitiesPath, {});
          if (probe.status === 404) supported.set(machine, false);
          else if (probe.status !== 200) throw new Error(`${Noun} capability probe answered ${probe.status}.`);
          else supported.set(machine, object(probe.body) && probe.body.version === 1
            && typeof probe.body.maxRecords === 'number' && probe.body.maxRecords >= spec.pageSize);
        }
        if (!supported.get(machine)) { setSynced(machine, false); break; }
        // Push the durable full set, including tombstones, in bounded pages.
        const records = store.records();
        for (let i = 0; i < records.length; i += spec.pageSize) {
          const response = await post(spec.syncPath, { version: 1, read: false, records: records.slice(i, i + spec.pageSize) });
          if (response.status !== 200) throw new Error(`${Noun} publication answered ${response.status}.`);
        }
        // Then pull: an offline member may have newer choices this computer hasn't seen.
        let after: string | undefined, pages = 0;
        do {
          if (++pages > Math.ceil(spec.maxRecords / spec.pageSize) + 1) throw new Error(`Too many ${spec.noun} pages.`);
          const response = await post(spec.syncPath, { version: 1, ...(after !== undefined && { after }) });
          const body = response.body;
          if (response.status !== 200 || !object(body) || body.version !== 1
            || body.next !== undefined && (typeof body.next !== 'string' || body.next.length > 2300 || after !== undefined && body.next <= after)) throw new Error(`Invalid ${spec.noun} sync response.`);
          const rows = spec.parse(body.records, spec.pageSize);
          // Cursors describe the original page, including records skipped for clock skew.
          if (body.next !== undefined && (!rows.length || body.next !== spec.keyOf(rows[rows.length - 1]))) throw new Error(`Empty ${spec.noun} sync page.`);
          await store.merge(spec.parseIncoming(rows, spec.pageSize), machine, current);
          after = body.next as string | undefined;
        } while (after !== undefined && current());
        if (current()) setSynced(machine, true);
      }
    } catch (error) { // telemetry-exempt: a failed sync is retried; no project paths or records are logged
      setSynced(machine, false);
      appLog('core:annex', 'warn', `${capital(spec.plural)} could not synchronize`, { meta: { machine, error: error instanceof Error ? error.message : String(error) } });
      if (current() && !retries.has(machine)) {
        const timer = setTimeout(() => { retries.delete(machine); queue(machine); }, 30_000);
        timer.unref?.(); retries.set(machine, timer);
      }
    } finally {
      running.delete(machine);
      if (dirty.has(machine) && online(machine) && !retries.has(machine)) queue(machine);
    }
  };
  const offConnected = options.transport.onConnected((machine) => {
    machine = machine.toLowerCase();
    generations.set(machine, (generations.get(machine) ?? 0) + 1);
    supported.delete(machine);
    setSynced(machine, false);
    const timer = retries.get(machine);
    if (timer) { clearTimeout(timer); retries.delete(machine); }
    queue(machine);
  });
  const offChanged = store.onChange((change) => {
    if (!change.recordsChanged) return;
    for (const machine of options.members()) if (machine.toLowerCase() !== change.source) queue(machine);
  });
  const offMembers = options.onMembershipChanged(() => {
    supported.clear();
    for (const machine of options.members()) { generations.set(machine, (generations.get(machine) ?? 0) + 1); setSynced(machine, false); }
    for (const [machine, timer] of retries) if (!options.isMember(machine)) { clearTimeout(timer); retries.delete(machine); supported.delete(machine); dirty.delete(machine); }
    for (const machine of options.members()) queue(machine);
  });
  for (const machine of options.members()) queue(machine);
  // Import saved state even when no other computer is connected yet.
  void store.migrate().catch((error) => appLog('core:annex', 'warn', `${Noun} migration failed`, { meta: { error: error instanceof Error ? error.message : String(error) } }));
  return () => {
    stopped = true; offConnected(); offChanged(); offMembers();
    for (const machine of options.members()) setSynced(machine, false);
    for (const timer of retries.values()) clearTimeout(timer);
    retries.clear(); dirty.clear(); supported.clear();
  };
}
