/**
 * The authoritative roster of a group project (#3548).
 *
 * - **On the host** it is read from the host's own membership record and
 *   inventory, with roles from the host's grants: the ones it enforces. Linked
 *   project copies are judged by the same evidence as coverage (#3549); a copy
 *   it can't check is offline, truncated or unknown, never "no agents".
 * - **Another computer** with a copy asks the host for it over the Annex
 *   Network, a page at a time, and saves the answer with when it was fetched.
 *   It never builds a roster from its own copy's record: that only knows this
 *   computer's agents well. An older host answers 404, and the copy shows its
 *   own members, labelled as this computer's.
 *
 * Read-only: changing members and roles stays with the existing host-enforced
 * paths.
 */
import * as fsp from 'fs/promises';
import { createHash } from 'crypto';
import type { GroupProject, ResolvedGroupProjectMember } from '../../shared/group-project-types';
import {
  GROUP_PROJECT_ROSTER_PATH, GROUP_PROJECT_ROSTER_VERSION, ROSTER_COPIES_MAX, ROSTER_MEMBERS_MAX, ROSTER_PAGE_MAX, ROSTER_RESPONSE_MAX_BYTES,
  clipLabel, readRosterAnswer, readRosterRequest,
  type GroupProjectRosterView, type RosterAnswer, type RosterCopy, type RosterCopyState, type RosterMember, type RosterPage,
  type RosterProvenance, type RosterRequest, type RosterRoleMode,
} from '../../shared/group-project-roster';
import { parseAgentAddress } from '../../shared/agent-address';
import { groupProjectHost } from './group-project-host';
import { describeMembership, hostInventoryPartial } from './group-project-membership';
import { linkedAgents, linkedProjectCopies, verifyCopy } from './group-project-linked-agents';
import { listGroupProjectRoles } from './group-project-roles';
import { readJsonFile, writeJsonFile } from './group-project-json-file';
import { rosterCachePath } from './group-project-paths';
import { appLog } from './log-service';

/** How the roster reaches a host; group-project-network.ts provides it. */
export interface GroupProjectRosterLink {
  connected(machine: string): boolean;
  isMember(machine: string): boolean;
  machineName(machine: string): string | undefined;
  post(machine: string, path: string, body: Record<string, unknown>, options?: { maxResponseBytes?: number }): Promise<{ status: number; body: unknown }>;
}

/** A host answers each computer at most this many roster pages a minute: five full rosters. */
export const ROSTER_RATE_LIMIT = 25;
const RATE_WINDOW_MS = 60_000;
/** A copy reads again at most this often, unless the group changed since. */
export const ROSTER_FRESH_MS = 15_000;
/** An old host's 404 is believed this long. */
const UNSUPPORTED_TTL_MS = 60_000;
/**
 * A saved roster bigger than this is not read. The worst case (1000 members with
 * the longest ids and labels, 32 copies) is a little over 1 MB even written compact.
 */
export const ROSTER_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const PAGE_ATTEMPTS = 3;
/** A membership or record change since the saved roster reads again at once, but not more often than this. */
export const ROSTER_MIN_REFETCH_MS = 3_000;

interface CachedRoster {
  version: 1; fetchedAt: string; truncated: boolean; page: RosterPage;
  /** The copy's own record and membership when this was read; a later `seq` with the same basis is only board posts. */
  basis?: string;
}

const ROLE_MODES = new Set<RosterRoleMode>(['allow', 'ask', 'off']);
const roleMode = (mode: unknown): RosterRoleMode => (ROLE_MODES.has(mode as RosterRoleMode) ? mode as RosterRoleMode : 'off');

type Satellites = Parameters<typeof verifyCopy>[1];

/** What the host could check of one linked copy, by the evidence coverage uses. */
function copyState(copy: { machine: string; projectId: string }, satellites: Satellites, isMember: (m: string) => boolean): { state: RosterCopyState; label: string } {
  const { sat, snapshot, verified, name } = verifyCopy(copy, satellites, isMember);
  if (verified) return { state: 'verified', label: name };
  if (!sat || !isMember(copy.machine) || sat.state !== 'connected') return { state: 'offline', label: name };
  if (snapshot?.snapshotTruncated?.omitted?.some((f) => f === 'agents' || f === 'projects')) return { state: 'truncated', label: name };
  return { state: 'unknown', label: name };
}

function provenanceOf(member: ResolvedGroupProjectMember, autoProject: boolean): RosterProvenance {
  if (autoProject) return 'linked';
  return member.via === 'auto' ? 'auto' : 'explicit';
}

class GroupProjectRosterService {
  private link: GroupProjectRosterLink | null = null;
  /** As host: when each computer asked, within the last minute. */
  private asks = new Map<string, number[]>();
  /** As a copy: the last roster read per group, and reads in flight. */
  private memory = new Map<string, CachedRoster>();
  private inflight = new Map<string, Promise<GroupProjectRosterView>>();
  private unsupported = new Map<string, number>();

  setLink(link: GroupProjectRosterLink | null): void {
    this.link = link;
  }

  // ── The host side ──

  /** The whole roster of a group hosted here, sorted, before paging. */
  async buildHostRoster(gp: GroupProject): Promise<Omit<RosterPage, 'members' | 'page'> & { all: RosterMember[] }> {
    const self = groupProjectHost.selfMachine();
    const isMember = (machine: string) => groupProjectHost.isNetworkMember(machine);
    const [view, membership, partial] = await Promise.all([
      describeMembership(gp.id), groupProjectHost.getMembership(gp.id), hostInventoryPartial(gp),
    ]);
    const linked = await linkedAgents(gp.scope, self, isMember);
    const verifiedRemote = new Set(linked.available.map((a) => a.agentId));
    const { getSatellites } = await import('./annex-client');
    const satellites = getSatellites();

    const copies: RosterCopy[] = [];
    const machines = new Map<string, string>();
    for (const sat of satellites) if (sat.alias) machines.set(sat.fingerprint.toLowerCase(), clipLabel(sat.alias));
    let copiesCut = false;
    if (gp.scope?.level === 'project' && gp.scope.reach === 'network') {
      const linkedCopies = linkedProjectCopies(self, gp.scope.projectId);
      copiesCut = linkedCopies.length > ROSTER_COPIES_MAX;
      for (const copy of linkedCopies.slice(0, ROSTER_COPIES_MAX)) {
        const { state, label } = copyState(copy, satellites, isMember);
        copies.push({ machine: copy.machine, label: clipLabel(label), state });
      }
    }

    // Roles the host enforces, by host-relative address: a bare id here, `id@machine` for another computer's agent.
    const roles = new Map(listGroupProjectRoles(gp.id).map((h) => [h.agentId, h]));
    const autoProject = new Set(membership.explicit.filter((e) => e.autoProject).map((e) => e.address));
    const all: RosterMember[] = [];
    for (const member of view.members) {
      const parsed = parseAgentAddress(member.agentId);
      // With no lasting identity this computer's agents have no fingerprint; such a roster never leaves it.
      const machine = parsed.machine ?? self ?? '';
      const remote = !!parsed.machine && parsed.machine !== self;
      const holder = roles.get(member.agentId);
      all.push({
        agentId: parsed.agentId,
        machine,
        label: clipLabel(member.name) || parsed.agentId,
        kind: member.kind,
        provenance: provenanceOf(member, autoProject.has(member.agentId)),
        ...(member.projectName && clipLabel(member.projectName) && { projectLabel: clipLabel(member.projectName) }),
        inventory: !remote || verifiedRemote.has(member.agentId) ? 'verified' : 'unknown',
        lead: roleMode(holder?.lead),
        admin: roleMode(holder?.admin),
      });
    }
    all.sort((a, b) => a.label.localeCompare(b.label) || a.machine.localeCompare(b.machine) || a.agentId.localeCompare(b.agentId));
    const used = new Set([...all.map((m) => m.machine), ...copies.map((c) => c.machine)]);
    const hostInventory = partial ? 'partial' as const : 'complete' as const;
    // Every page of one roster carries this; a copy that sees two starts again.
    const etag = createHash('sha256').update(JSON.stringify({ all, copies, copiesCut, hostInventory })).digest('hex');
    return {
      v: 1, roster: GROUP_PROJECT_ROSTER_VERSION, status: 'ok', groupProjectId: gp.id,
      host: { machine: self ?? '' }, seq: gp.seq ?? 0, generatedAt: new Date().toISOString(),
      copies, ...(copiesCut && { copiesCut: true }), etag, hostInventory,
      machines: [...machines].filter(([m]) => used.has(m) && m !== self).slice(0, ROSTER_COPIES_MAX).map(([machine, label]) => ({ machine, label })),
      all,
    };
  }

  private rateLimited(machine: string): boolean {
    const now = Date.now();
    const recent = (this.asks.get(machine) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= ROSTER_RATE_LIMIT) { this.asks.set(machine, recent); return true; }
    recent.push(now);
    this.asks.set(machine, recent);
    return false;
  }

  /** A network computer asks for a page of a roster. `machine` is the authenticated computer. */
  async receive(machine: string, raw: unknown): Promise<RosterAnswer> {
    const asker = machine.toLowerCase();
    if (this.rateLimited(asker)) return { v: 1, status: 'busy' };
    const request = readRosterRequest(raw);
    const notFound: RosterAnswer = { v: 1, status: 'not_found' };
    // One answer for every refusal: not a member, not here, not hosted here, not shared, no identity.
    if (!groupProjectHost.isNetworkMember(asker) || !groupProjectHost.selfMachine()) return notFound;
    const gp = await groupProjectHost.get(request.groupProjectId).catch((): null => null);
    if (!gp || groupProjectHost.isReplica(gp) || gp.scope?.reach !== 'network') return notFound;
    const { all, ...rest } = await this.buildHostRoster(gp);
    return { ...rest, members: all.slice(request.offset, request.offset + request.limit), page: { offset: request.offset, total: all.length } };
  }

  // ── The copy side ──

  /** The roster to show for a group project, from wherever it can honestly come. */
  async describe(groupProjectId: string): Promise<GroupProjectRosterView> {
    const gp = await groupProjectHost.get(groupProjectId);
    if (!gp) throw new Error(`Group project ${groupProjectId} does not exist.`);
    if (!groupProjectHost.isReplica(gp)) return this.hostView(gp);
    const running = this.inflight.get(groupProjectId);
    if (running) return running;
    const next = this.replicaView(gp).finally(() => { if (this.inflight.get(groupProjectId) === next) this.inflight.delete(groupProjectId); });
    this.inflight.set(groupProjectId, next);
    return next;
  }

  private async hostView(gp: GroupProject): Promise<GroupProjectRosterView> {
    const { all, ...rest } = await this.buildHostRoster(gp);
    return this.toView(gp, { ...rest, members: all, page: { offset: 0, total: all.length } }, 'host', rest.generatedAt, false);
  }

  /**
   * What the roster depends on that this copy holds: the synced record and membership. A board post
   * advances `seq` and leaves this alone, so a busy board doesn't make the roster read again (#3581).
   * Unknown (undefined) counts as changed.
   */
  private async basisOf(gp: GroupProject): Promise<string | undefined> {
    try {
      const { seq: _seq, hostName: _hostName, network: _network, ...record } = gp;
      const membership = await groupProjectHost.getMembership(gp.id);
      return createHash('sha256').update(JSON.stringify({ record, membership })).digest('hex');
    } catch {
      return undefined;
    }
  }

  private async replicaView(gp: GroupProject): Promise<GroupProjectRosterView> {
    const host = gp.host!.machine!;
    const hostName = groupProjectHost.hostNameOf(gp);
    const unavailable = (reason: Extract<GroupProjectRosterView, { status: 'unavailable' }>['reason']): GroupProjectRosterView =>
      ({ groupProjectId: gp.id, status: 'unavailable', reason, hostName });
    if (gp.scope?.reach !== 'network') return unavailable('not_network');
    const cached = await this.cached(gp.id, host);
    const fromCache = (stale: 'offline' | 'changed' | 'failed', reason: Parameters<typeof unavailable>[0]): GroupProjectRosterView =>
      (cached ? this.toView(gp, cached.page, 'cache', cached.fetchedAt, cached.truncated, stale) : unavailable(reason));
    if (gp.network?.state === 'host-removed') return fromCache('offline', 'host_removed');
    if (!this.link || !this.link.connected(host) || !this.link.isMember(host)) return fromCache('offline', 'offline');
    const knownOld = this.unsupported.get(host);
    if (knownOld !== undefined && Date.now() - knownOld < UNSUPPORTED_TTL_MS) return unavailable('unsupported');
    const basis = await this.basisOf(gp);
    // The group moved on since, in what the roster shows: not a board post alone.
    const changedSince = !!cached && (gp.seq ?? 0) > cached.page.seq && (basis === undefined || basis !== cached.basis);
    const age = cached ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;
    // A fetch time in the future (a clock moved back) is never fresh.
    const fresh = age >= 0 && age < ROSTER_FRESH_MS && (!changedSince || age < ROSTER_MIN_REFETCH_MS);
    if (cached && fresh) {
      return this.toView(gp, cached.page, 'cache', cached.fetchedAt, cached.truncated, changedSince ? 'changed' : undefined);
    }
    const fetched = await this.fetch(gp.id, host);
    if (fetched.kind === 'unsupported') {
      this.unsupported.set(host, Date.now());
      return unavailable('unsupported');
    }
    this.unsupported.delete(host);
    if (fetched.kind === 'not_found') return unavailable('not_found');
    if (fetched.kind === 'busy') return fromCache(changedSince ? 'changed' : 'failed', 'busy');
    if (fetched.kind !== 'ok') return fromCache(changedSince ? 'changed' : 'failed', 'failed');
    const entry: CachedRoster = { version: 1, fetchedAt: new Date().toISOString(), truncated: fetched.truncated, page: fetched.page, ...(basis && { basis }) };
    await this.save(gp.id, entry);
    return this.toView(gp, entry.page, 'live', entry.fetchedAt, entry.truncated);
  }

  /** Every page from the host, read against one sequence number: a change between pages starts again. */
  private async fetch(groupProjectId: string, host: string): Promise<
    | { kind: 'ok'; page: RosterPage; truncated: boolean }
    | { kind: 'unsupported' | 'not_found' | 'busy' | 'failed' }
  > {
    for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
      let first: RosterPage | null = null;
      const members: RosterMember[] = [];
      let restart = false;
      while (members.length < ROSTER_MEMBERS_MAX) {
        const request: RosterRequest = { v: 1, groupProjectId, offset: members.length, limit: Math.min(ROSTER_PAGE_MAX, ROSTER_MEMBERS_MAX - members.length) };
        let answer: RosterAnswer;
        try {
          const response = await this.link!.post(host, GROUP_PROJECT_ROSTER_PATH, request as unknown as Record<string, unknown>, { maxResponseBytes: ROSTER_RESPONSE_MAX_BYTES });
          if (response.status === 404) return { kind: 'unsupported' };
          if (response.status !== 200) throw new Error(`The roster answered ${response.status}.`);
          answer = readRosterAnswer(response.body, host, request);
        } catch (err) {
          // telemetry-exempt: shown as a stale or unavailable roster, with when it was last read; logged
          appLog('core:group-project', 'warn', 'Could not read a group project roster from its host', {
            meta: { groupProjectId, host, error: err instanceof Error ? err.message : String(err) },
          });
          return { kind: 'failed' };
        }
        if (answer.status !== 'ok') return { kind: answer.status };
        if (first && (answer.etag !== first.etag || answer.seq !== first.seq || answer.page.total !== first.page.total)) { restart = true; break; }
        first ??= answer;
        members.push(...answer.members);
        if (answer.members.length === 0 || members.length >= answer.page.total) break;
      }
      if (restart || !first) continue;
      // Nobody is listed twice, even by a misbehaving host.
      const seen = new Set<string>();
      const unique = members.filter((m) => { const key = `${m.agentId}@${m.machine}`; if (seen.has(key)) return false; seen.add(key); return true; });
      return { kind: 'ok', page: { ...first, members: unique, page: { offset: 0, total: first.page.total } }, truncated: first.page.total > unique.length };
    }
    return { kind: 'failed' };
  }

  private async cached(groupProjectId: string, host: string): Promise<CachedRoster | null> {
    const inMemory = this.memory.get(groupProjectId);
    if (inMemory) return inMemory.page.host.machine === host ? inMemory : null;
    const file = rosterCachePath(groupProjectId);
    try {
      const stat = await fsp.stat(file);
      if (stat.size > ROSTER_CACHE_MAX_BYTES) throw new Error('The saved roster is too large.');
      const entry = await readJsonFile<CachedRoster | null>(file, () => null, (raw) => validateCached(raw, groupProjectId, host));
      if (entry) this.memory.set(groupProjectId, entry);
      return entry;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // telemetry-exempt: a damaged saved roster is ignored, and the next read from the host replaces it; logged
      appLog('core:group-project', 'warn', 'Ignored a saved group project roster that could not be read', {
        meta: { groupProjectId, error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  }

  private async save(groupProjectId: string, entry: CachedRoster): Promise<void> {
    this.memory.set(groupProjectId, entry);
    try {
      // The copy's folder goes when the copy does: never bring it back for a roster.
      const gp = await groupProjectHost.get(groupProjectId);
      if (!gp || !groupProjectHost.isReplica(gp)) return;
      await writeJsonFile(rosterCachePath(groupProjectId), entry, { createDir: false, compact: true });
    } catch (err) {
      // telemetry-exempt: the roster still shows from memory; only a restart while the host is offline loses it; logged
      appLog('core:group-project', 'warn', 'Could not save a group project roster', { meta: { groupProjectId, error: err instanceof Error ? err.message : String(err) } });
    }
  }

  private toView(
    gp: GroupProject, page: RosterPage, source: 'host' | 'live' | 'cache', fetchedAt: string, truncated: boolean,
    stale?: 'offline' | 'changed' | 'failed',
  ): GroupProjectRosterView {
    const self = groupProjectHost.selfMachine();
    const hostMachine = page.host.machine;
    const named = new Map(page.machines.map((m) => [m.machine, m.label]));
    const here = self ?? '';
    const machineLabel = (machine: string): string => {
      if (machine === here) return 'This computer';
      return this.link?.machineName(machine) || named.get(machine) || (machine === hostMachine ? groupProjectHost.hostNameOf(gp) : 'Another computer');
    };
    const copies = page.copies.map((c) => ({ ...c, thisComputer: c.machine === here }));
    return {
      groupProjectId: gp.id, status: 'available', source, hostName: groupProjectHost.hostNameOf(gp), fetchedAt,
      ...(stale && { stale }),
      members: page.members.map((m) => ({
        ...m, key: `${m.agentId}@${m.machine}`, machineLabel: machineLabel(m.machine), thisComputer: m.machine === here,
      })),
      copies, copiesCut: !!page.copiesCut, hostInventory: page.hostInventory, truncated,
      complete: !stale && !truncated && !page.copiesCut && page.hostInventory === 'complete' && copies.every((c) => c.state === 'verified')
        && page.members.every((m) => m.inventory === 'verified'),
    };
  }

  /** For tests. */
  _resetForTesting(): void {
    this.link = null;
    this.asks.clear();
    this.memory.clear();
    this.inflight.clear();
    this.unsupported.clear();
  }
}

function validateCached(raw: unknown, groupProjectId: string, host: string): CachedRoster | null {
  const v = raw as Partial<CachedRoster> | null;
  if (!v || typeof v !== 'object' || v.version !== 1 || typeof v.fetchedAt !== 'string' || Number.isNaN(Date.parse(v.fetchedAt))
    || typeof v.truncated !== 'boolean' || !v.page || typeof v.page !== 'object') throw new Error('The saved roster is not a valid version 1 record.');
  // The same checks as an answer off the wire: a saved file is no more trusted.
  const page = readRosterAnswer(v.page, host, { v: 1, groupProjectId, offset: 0, limit: ROSTER_MEMBERS_MAX });
  if (page.status !== 'ok') throw new Error('The saved roster is not a roster.');
  return { version: 1, fetchedAt: v.fetchedAt, truncated: v.truncated, page, ...(typeof v.basis === 'string' && /^[0-9a-f]{64}$/.test(v.basis) && { basis: v.basis }) };
}

export const groupProjectRoster = new GroupProjectRosterService();
