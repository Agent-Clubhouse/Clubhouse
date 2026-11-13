/**
 * Network group projects over Annex (#3363): the requests between computers.
 *
 * The host service (group-project-host.ts) keeps every store; this module only
 * carries requests. A copy catches up from its host when they connect and when
 * the host says something changed; writes made while the host was away go to
 * it, in order, on the next connect. Only computers in the Annex Network take
 * part (members, never phones), over the pinned mTLS connection.
 */
import {
  GROUP_PROJECT_CHANGED_PATH, GROUP_PROJECT_SYNC_PATH, GROUP_PROJECT_WRITE_PATH,
  readChangedNotice, readSyncRequest, readSyncResponse, readWriteRequest, readWriteResponse,
  type ChangedNotice, type QueuedWrite, type SyncRequest, type SyncResponse, type WriteResponse,
} from '../../shared/group-project-network';
import type { GroupProjectNetworkRefusal } from '../../shared/group-project-types';
import { groupProjectHost } from './group-project-host';
import { appLog } from './log-service';

export interface GroupProjectNetworkTransport {
  connected(machine: string): boolean;
  post(machine: string, path: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  onConnected(listener: (machine: string) => void): () => void;
  machineName(machine: string): string | undefined;
}

export interface StartGroupProjectNetworkOptions {
  transport: GroupProjectNetworkTransport;
  /** A computer in this machine's Annex Network. */
  isMember(machine: string): boolean;
  /** Every computer in the network now. */
  members(): string[];
  onMembershipChanged(listener: () => void): () => void;
  /** Tell an agent here that the host refused its change. */
  notifyAgent?(agentId: string, text: string): void;
  /** Remove a group project's saved Canvas cards, wires and guidance: its copy here went. */
  purgeViews?(groupProjectId: string): Promise<void>;
}

/** Changes are told in one notice per burst. */
const NOTICE_DELAY_MS = 250;

let options: StartGroupProjectNetworkOptions | null = null;
let lifecycle = 0;
const pullChains = new Map<string, Promise<void>>();

async function postJson(machine: string, path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await options!.transport.post(machine, path, body);
  if (response.status !== 200) throw new Error(`${path} answered ${response.status}.`);
  return response.body;
}

function logFailure(what: string, machine: string, err: unknown): void {
  // telemetry-exempt: network failures are retried at the next connect or notice; logged
  appLog('core:group-project', 'warn', `Network group projects: ${what} failed`, {
    meta: { machine, error: err instanceof Error ? err.message : String(err) },
  });
}

/** Catch up from a host, one request at a time per host. */
function pullFrom(machine: string, flush: boolean): Promise<void> {
  const previous = pullChains.get(machine) ?? Promise.resolve();
  const next = previous.then(async () => {
    if (!options?.transport.connected(machine) || !options.isMember(machine)) return;
    // Waiting writes first, so the copy then shows what the host made of them.
    if (flush) await groupProjectHost.flushOutbox(machine);
    else await groupProjectHost.syncFrom(machine);
  }).catch((err) => logFailure('catching up', machine, err));
  pullChains.set(machine, next);
  void next.finally(() => { if (pullChains.get(machine) === next) pullChains.delete(machine); });
  return next;
}

export function startGroupProjectNetwork(start: StartGroupProjectNetworkOptions): () => void {
  const generation = ++lifecycle;
  options = start;
  groupProjectHost.setNetworkLink({
    connected: (machine) => start.transport.connected(machine),
    isMember: (machine) => start.isMember(machine),
    machineName: (machine) => start.transport.machineName(machine),
    sync: async (machine, request: SyncRequest): Promise<SyncResponse> =>
      readSyncResponse(await postJson(machine, GROUP_PROJECT_SYNC_PATH, request as unknown as Record<string, unknown>), machine),
    sendWrites: async (machine, writes: QueuedWrite[]): Promise<WriteResponse> =>
      readWriteResponse(await postJson(machine, GROUP_PROJECT_WRITE_PATH, { v: 1, writes } as unknown as Record<string, unknown>)),
    notifyRefusal: (refusal: GroupProjectNetworkRefusal) => {
      if (!refusal.author.agentId || !start.notifyAgent) return;
      start.notifyAgent(refusal.author.agentId, `[Group project] Your ${refusal.op === 'post' ? 'post' : 'change'} waited for its host and was refused: ${refusal.reason}`);
    },
  });

  // On connect: send what waited, then catch up.
  const offConnected = start.transport.onConnected((machine) => {
    if (start.isMember(machine)) void pullFrom(machine.toLowerCase(), true);
  });

  // As host: tell connected computers when a network group project here changes, once per burst.
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const notify = async (): Promise<void> => {
    timer = null;
    const ids = [...pending];
    pending.clear();
    const notice: ChangedNotice = { v: 1, ids };
    for (const machine of start.members()) {
      if (!start.transport.connected(machine)) continue;
      await postJson(machine, GROUP_PROJECT_CHANGED_PATH, notice as unknown as Record<string, unknown>).catch((err) => logFailure('telling of a change', machine, err));
    }
  };
  const offChanged = groupProjectHost.onChange((change) => {
    // This computer's copy went (deleted on its host, or no longer shared): so do its cards and wires.
    if (change.part === 'deleted' && change.project?.network?.role === 'replica') {
      void start.purgeViews?.(change.groupProjectId).catch((err) => logFailure('removing a copy\'s canvas cards', change.project!.host?.machine ?? '', err));
      return;
    }
    void (async () => {
      const project = change.project ?? await groupProjectHost.get(change.groupProjectId).catch((): null => null);
      if (!project || project.network?.role === 'replica' || (project.scope?.reach !== 'network' && change.part !== 'deleted')) return;
      pending.add(change.groupProjectId);
      if (!timer) {
        timer = setTimeout(() => { void notify(); }, NOTICE_DELAY_MS);
        timer.unref?.();
      }
    })();
  });

  // A computer that left: its group projects become read-only copies here, and its agents leave ours.
  let known = new Set(start.members().map((m) => m.toLowerCase()));
  const offMembers = start.onMembershipChanged(() => {
    const now = new Set(start.members().map((m) => m.toLowerCase()));
    for (const machine of known) {
      if (!now.has(machine)) void groupProjectHost.machineRemoved(machine).catch((err) => logFailure('removing a computer', machine, err));
    }
    known = now;
  });

  // Catch up with every computer already connected.
  for (const machine of start.members()) {
    if (start.transport.connected(machine)) void pullFrom(machine.toLowerCase(), true);
  }

  return () => {
    if (generation !== lifecycle) return;
    lifecycle++;
    offConnected();
    offChanged();
    offMembers();
    if (timer) clearTimeout(timer);
    groupProjectHost.setNetworkLink(null);
    options = null;
    pullChains.clear();
  };
}

// ── Receiving (called by annex-server's routes, for an authenticated network computer) ──

export async function receiveGroupProjectSync(machine: string, raw: unknown): Promise<SyncResponse> {
  return groupProjectHost.networkSnapshot(readSyncRequest(raw));
}

export async function receiveGroupProjectWrites(machine: string, raw: unknown): Promise<WriteResponse> {
  return groupProjectHost.applyRemoteWrites(machine, readWriteRequest(raw));
}

export function receiveGroupProjectChanged(machine: string, raw: unknown): void {
  readChangedNotice(raw);
  void pullFrom(machine.toLowerCase(), false);
}
