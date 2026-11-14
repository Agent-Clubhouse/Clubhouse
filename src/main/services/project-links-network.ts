/**
 * Project display preferences use the pinned-member REST replication precedent
 * from group-project-network, with agent-delivery-capabilities-style probing.
 * /network remains strictly membership-only. Old peers are simply skipped.
 */
import {
  PROJECT_LINKS_CAPABILITIES_PATH, PROJECT_LINKS_SYNC_PATH, PROJECT_LINKS_PAGE_SIZE,
  parseProjectLinkRecords, projectLinkPairKey, PROJECT_LINKS_MAX_RECORDS, type ProjectLinkRecord,
} from '../../shared/project-links';
import { projectLinksStore, type ProjectLinksStore } from './project-links-store';
import { appLog } from './log-service';

export const projectLinksCapabilities = () => ({ version: 1 as const, maxRecords: PROJECT_LINKS_PAGE_SIZE });
export interface ProjectLinksNetworkOptions {
  store?: ProjectLinksStore;
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
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Called only after annex-server authenticates a currently pinned member desktop. */
export async function receiveProjectLinks(source: string, raw: unknown, current: () => boolean, store = projectLinksStore()): Promise<Record<string, unknown>> {
  if (!object(raw) || raw.version !== 1 || Object.keys(raw).some((k) => !['version', 'records', 'after', 'read'].includes(k))
    || raw.read !== undefined && typeof raw.read !== 'boolean'
    || raw.after !== undefined && (typeof raw.after !== 'string' || raw.after.length > 2300)) throw new Error('Invalid project links request.');
  const records = raw.records === undefined ? [] : parseProjectLinkRecords(raw.records, PROJECT_LINKS_PAGE_SIZE);
  if (!current()) throw new Error('Project link pairing changed.');
  await store.migrate();
  if (!current()) throw new Error('Project link pairing changed.');
  if (records.length) await store.merge(records, source, current);
  if (!current()) throw new Error('Project link pairing changed.');
  return { version: 1, ...(raw.read === false ? {} : store.page(raw.after as string | undefined)) };
}

export function startProjectLinksNetwork(options: ProjectLinksNetworkOptions): () => void {
  const store = options.store ?? projectLinksStore();
  let stopped = false;
  const supported = new Map<string, boolean>();
  const generations = new Map<string, number>();
  const running = new Set<string>(), dirty = new Set<string>();
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
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
      if (!current()) throw new Error('Project link pairing changed.');
      const response = await options.transport.post(machine, path, body);
      if (!current()) throw new Error('Project link pairing changed.');
      return response;
    };
    try {
      await store.migrate();
      while (current() && dirty.delete(machine)) {
        if (!supported.has(machine)) {
          const probe = await post(PROJECT_LINKS_CAPABILITIES_PATH, {});
          if (probe.status === 404) supported.set(machine, false);
          else if (probe.status !== 200) throw new Error(`Project link capability probe answered ${probe.status}.`);
          else supported.set(machine, object(probe.body) && probe.body.version === 1
            && typeof probe.body.maxRecords === 'number' && probe.body.maxRecords >= PROJECT_LINKS_PAGE_SIZE);
        }
        if (!supported.get(machine)) break;
        // Push the durable full set, including tombstones, in bounded pages.
        const records = store.records();
        for (let i = 0; i < records.length; i += PROJECT_LINKS_PAGE_SIZE) {
          const response = await post(PROJECT_LINKS_SYNC_PATH, { version: 1, read: false, records: records.slice(i, i + PROJECT_LINKS_PAGE_SIZE) });
          if (response.status !== 200) throw new Error(`Project link publication answered ${response.status}.`);
        }
        // Then pull: an offline member may have newer choices this computer hasn't seen.
        let after: string | undefined, pages = 0;
        do {
          if (++pages > Math.ceil(PROJECT_LINKS_MAX_RECORDS / PROJECT_LINKS_PAGE_SIZE) + 1) throw new Error('Too many project link pages.');
          const response = await post(PROJECT_LINKS_SYNC_PATH, { version: 1, ...(after !== undefined && { after }) });
          const body = response.body;
          if (response.status !== 200 || !object(body) || body.version !== 1
            || body.next !== undefined && (typeof body.next !== 'string' || body.next.length > 2300 || after !== undefined && body.next <= after)) throw new Error('Invalid project link sync response.');
          const incoming: ProjectLinkRecord[] = parseProjectLinkRecords(body.records, PROJECT_LINKS_PAGE_SIZE);
          if (body.next !== undefined && (!incoming.length || body.next !== projectLinkPairKey(...incoming[incoming.length - 1].projects))) throw new Error('Empty project link sync page.');
          await store.merge(incoming, machine, current);
          after = body.next as string | undefined;
        } while (after !== undefined && current());
      }
    } catch (error) { // telemetry-exempt: a failed sync is retried; no project paths or records are logged
      appLog('core:annex', 'warn', 'Project links could not synchronize', { meta: { machine, error: error instanceof Error ? error.message : String(error) } });
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
    for (const machine of options.members()) generations.set(machine, (generations.get(machine) ?? 0) + 1);
    for (const [machine, timer] of retries) if (!options.isMember(machine)) { clearTimeout(timer); retries.delete(machine); supported.delete(machine); dirty.delete(machine); }
    for (const machine of options.members()) queue(machine);
  });
  for (const machine of options.members()) queue(machine);
  // Import the saved mirror even when no other computer is connected yet.
  void store.migrate().catch((error) => appLog('core:annex', 'warn', 'Project link migration failed', { meta: { error: error instanceof Error ? error.message : String(error) } }));
  return () => {
    stopped = true; offConnected(); offChanged(); offMembers();
    for (const timer of retries.values()) clearTimeout(timer);
    retries.clear(); dirty.clear(); supported.clear();
  };
}
