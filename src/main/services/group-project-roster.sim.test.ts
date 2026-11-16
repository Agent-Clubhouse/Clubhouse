/**
 * The authoritative roster (#3548), with two and three desktops in one
 * process: each runs its own host service, registry, membership and roster
 * module, with its own home folder and identity. Roster pages go through JSON
 * and the wire's own validators. A test can take a computer offline, cut its
 * inventory short, make it an older version, or flood its host.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { readSyncRequest, readSyncResponse, readWriteRequest, readWriteResponse } from '../../shared/group-project-network';
import { GROUP_PROJECT_ROSTER_PATH, ROSTER_MEMBERS_MAX, ROSTER_PAGE_MAX, readRosterAnswer, type GroupProjectRosterView } from '../../shared/group-project-roster';

type Project = { id: string; name: string; path: string; agents: Array<{ id: string; name: string; parentAgentId?: string }> };

interface Machine {
  name: string;
  fp: string;
  home: string;
  projects?: Project[];
  host?: typeof import('./group-project-host');
  registry?: typeof import('./group-project-registry');
  membership?: typeof import('./group-project-membership');
  persisted?: typeof import('./persisted-bindings');
  bindings?: typeof import('./clubhouse-mcp/binding-manager');
  roster?: typeof import('./group-project-roster');
  roles?: typeof import('./group-project-roles');
}

const world = vi.hoisted(() => ({
  als: null as unknown as AsyncLocalStorage<{ home: string; fp: string; projects?: Project[] }>,
  fallbackHome: '',
  links: [] as Array<Array<{ machine: string; projectId: string }>>,
  /** Runs once between a host's first and second roster page. */
  betweenPages: null as null | (() => Promise<void>),
}));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => world.als?.getStore()?.home ?? world.fallbackHome } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-network-profile', () => ({ annexEphemeralSession: () => false }));
vi.mock('./annex-identity', () => ({ getIdentity: () => (world.als?.getStore() ? { fingerprint: world.als.getStore()!.fp } : null) }));
vi.mock('./annex-settings', () => ({ networkEnabled: () => true }));
const projectsHere = () => world.als?.getStore()?.projects ?? [];
vi.mock('./project-store', () => ({
  list: vi.fn(async () => projectsHere().map(({ id, name, path }) => ({ id, name, path }))),
  onProjectsChanged: vi.fn(() => () => undefined),
}));
vi.mock('./project-links-store', () => ({ projectLinksStore: () => ({ groups: () => world.links, records: () => [], onChange: () => () => {} }) }));
vi.mock('./annex-client', () => ({
  getSatellites: () => machines.filter((m) => m.fp !== world.als?.getStore()?.fp).map((m) => ({
    fingerprint: m.fp, alias: m.name, state: down.has(m.name) ? 'disconnected' : 'connected',
    snapshot: {
      projects: m.projects,
      agents: truncated.has(m.name) ? {} : Object.fromEntries((m.projects ?? []).map((p) => [p.id, p.agents])),
      quickAgents: {},
      ...(truncated.has(m.name) && { snapshotTruncated: { omitted: ['agents'] } }),
    },
  })),
  onSatelliteSnapshot: () => () => {},
}));
vi.mock('./quick-agent-events', () => ({ knownQuickAgents: () => new Map() }));
vi.mock('./canvas-store-reader', () => ({ readAllCanvasStores: async () => [] }));
vi.mock('./canvas-wire-source', () => ({ canvasWireBindingSource: { id: 'canvas-wires', collect: async () => [], inspect: async () => [] } }));
vi.mock('./agent-config', () => ({
  listDurable: vi.fn(async (projectPath: string) => (projectsHere().find((p) => p.path === projectPath)?.agents ?? [])
    .map((a) => ({ ...a, color: 'emerald', createdAt: '2026-01-01T00:00:00.000Z' }))),
  onAgentConfigChanged: vi.fn(() => () => undefined),
  peekDurableConfigsChecked: vi.fn(async (projectPath: string) => ({ agents: projectsHere().find((p) => p.path === projectPath)?.agents ?? [], readable: true })),
  projectKey: vi.fn(async () => 'unknown'),
}));

const fp = (n: string) => Array.from({ length: 32 }, () => n).join(':');
const A: Machine = { name: 'Desk', fp: fp('aa'), home: '' };
const B: Machine = { name: 'Studio', fp: fp('bb'), home: '' };
const C: Machine = { name: 'Attic', fp: fp('cc'), home: '' };
const machines = [A, B, C];
const byFp = (f: string) => machines.find((m) => m.fp === f.toLowerCase())!;
const down = new Set<string>();
/** Computers whose Annex snapshot left their agents out. */
const truncated = new Set<string>();
/** Computers on a Clubhouse from before #3548: the roster route answers 404. */
const old = new Set<string>();
/** Computers outside the network, as their peers see it. */
const outsiders = new Set<string>();
/** Roster pages each host answered, by host name. */
const rosterPosts = new Map<string, number>();
/** Hosts that pad their answers past any sane size. */
const bloated = new Set<string>();
/** The byte limits copies asked for. */
const askedLimits: Array<number | undefined> = [];

function as<T>(m: Machine, fn: () => Promise<T> | T): Promise<T> {
  return world.als.run({ home: m.home, fp: m.fp, projects: m.projects }, async () => fn());
}

const wire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));
const connected = (self: Machine, machine: string) => !down.has(byFp(machine).name) && !down.has(self.name);
const isMember = (machine: string) => machines.some((m) => m.fp === machine.toLowerCase()) && !outsiders.has(byFp(machine).name);

function linkFor(self: Machine) {
  return {
    connected: (machine: string) => connected(self, machine),
    isMember,
    machineName: (machine: string) => byFp(machine).name,
    sync: async (machine: string, request: unknown) => {
      if (!connected(self, machine)) throw new Error('Satellite not connected');
      const other = byFp(machine);
      const body = await as(other, () => other.host!.groupProjectHost.networkSnapshot(readSyncRequest(wire(request))));
      return readSyncResponse(wire(body), other.fp);
    },
    sendWrites: async (machine: string, writes: unknown[]) => {
      if (!connected(self, machine)) throw new Error('Satellite not connected');
      const other = byFp(machine);
      const body = await as(other, () => other.host!.groupProjectHost.applyRemoteWrites(self.fp, readWriteRequest(wire({ v: 1, writes }))));
      return readWriteResponse(wire(body));
    },
  };
}

/** What annex-server's roster route does for an authenticated network computer. */
function rosterLinkFor(self: Machine) {
  return {
    connected: (machine: string) => connected(self, machine),
    isMember,
    machineName: (machine: string) => byFp(machine).name,
    post: async (machine: string, urlPath: string, body: Record<string, unknown>, options?: { maxResponseBytes?: number }) => {
      if (!connected(self, machine)) throw new Error('Satellite not connected');
      const other = byFp(machine);
      if (old.has(other.name) || urlPath !== GROUP_PROJECT_ROSTER_PATH) return { status: 404, body: { error: 'not_found' } };
      askedLimits.push(options?.maxResponseBytes);
      const count = (rosterPosts.get(other.name) ?? 0) + 1;
      rosterPosts.set(other.name, count);
      if (count === 2 && world.betweenPages) { const run = world.betweenPages; world.betweenPages = null; await run(); }
      try {
        const answer = await as(other, () => other.roster!.groupProjectRoster.receive(self.fp, wire(body)));
        const text = JSON.stringify(bloated.has(other.name) ? { ...answer, pad: 'x'.repeat(600 * 1024) } : answer);
        // What annex-client's postToMachine does with the limit.
        if (options?.maxResponseBytes !== undefined && Buffer.byteLength(text) > options.maxResponseBytes) throw new Error('Annex response exceeds its byte limit.');
        return { status: 200, body: JSON.parse(text) };
      } catch (err) {
        if (err instanceof Error && err.name === 'GroupProjectNetworkError') return { status: 400, body: { error: 'invalid_request' } };
        return { status: 500, body: { error: 'failed' } };
      }
    },
  };
}

async function load(m: Machine): Promise<void> {
  vi.resetModules();
  m.host = await import('./group-project-host');
  m.registry = await import('./group-project-registry');
  m.membership = await import('./group-project-membership');
  m.persisted = await import('./persisted-bindings');
  m.bindings = await import('./clubhouse-mcp/binding-manager');
  m.roster = await import('./group-project-roster');
  m.roles = await import('./group-project-roles');
  m.host.groupProjectHost.setNetworkLink(linkFor(m));
  m.roster.groupProjectRoster.setLink(rosterLinkFor(m));
}

async function unload(m: Machine): Promise<void> {
  await as(m, async () => { await m.host!.groupProjectHost.flushRegistry(); await m.host!.groupProjectHost.flushBoards(); });
  m.roster!.groupProjectRoster._resetForTesting();
  m.host!.groupProjectHost._resetForTesting();
  m.registry!.groupProjectRegistry._resetForTesting();
  m.membership!._resetMembershipForTesting();
  m.persisted!._resetPersistedBindingSourcesForTesting();
  m.bindings!.bindingManager._resetForTesting();
}

beforeEach(async () => {
  world.als = new AsyncLocalStorage();
  const cache = path.join(process.cwd(), 'node_modules', '.cache');
  await fsp.mkdir(cache, { recursive: true });
  world.fallbackHome = await fsp.mkdtemp(path.join(cache, 'gp-roster-none-'));
  down.clear(); truncated.clear(); old.clear(); outsiders.clear(); rosterPosts.clear(); bloated.clear();
  askedLimits.length = 0;
  world.links = [];
  world.betweenPages = null;
  A.projects = [{ id: 'proj_a', name: 'App', path: '/a/app', agents: [{ id: 'lead', name: 'Lead' }, { id: 'builder_a', name: 'Builder' }] }];
  B.projects = [{ id: 'proj_b', name: 'App', path: '/b/app', agents: [{ id: 'builder_b', name: 'Builder' }] }];
  C.projects = [{ id: 'proj_c', name: 'App', path: '/c/app', agents: [{ id: 'checker', name: 'Checker' }] }];
  for (const m of machines) {
    m.home = await fsp.mkdtemp(path.join(cache, `gp-roster-${m.name}-`));
    await load(m);
  }
});

afterEach(async () => {
  vi.useRealTimers();
  for (const m of machines) {
    await unload(m);
    await fsp.rm(m.home, { recursive: true, force: true });
  }
  await fsp.rm(world.fallbackHome, { recursive: true, force: true });
});

const scope = { level: 'project', projectId: 'proj_a', reach: 'network' } as const;

/** A project group on Desk that includes linked computers, with every copy's agents joined and synced to the others. */
async function linkedGroup(linked: Machine[] = [B, C]): Promise<string> {
  world.links = [[{ machine: A.fp, projectId: 'proj_a' }, ...linked.map((m) => ({ machine: m.fp, projectId: m.projects![0].id }))]];
  const project = await as(A, () => A.host!.groupProjectHost.create('Release', { projectId: 'proj_a', scope }));
  for (const m of machines) await as(m, async () => {
    m.persisted!.registerPersistedBindingSource(m.membership!.membershipBindingSource);
    await m.persisted!.rebuildPersistedBindings();
  });
  await as(A, () => A.membership!.reconcileMembership());
  for (const m of linked) await as(m, () => m.host!.groupProjectHost.syncFrom(A.fp));
  return project.id;
}

const roster = (m: Machine, id: string) => as(m, () => m.roster!.groupProjectRoster.describe(id));
const available = (view: GroupProjectRosterView) => {
  if (view.status !== 'available') throw new Error(`Roster unavailable: ${view.reason}`);
  return view;
};
const keys = (view: GroupProjectRosterView) => available(view).members.map((m) => m.key).sort();
const resetCopyCache = (m: Machine) => { m.roster!.groupProjectRoster._resetForTesting(); m.roster!.groupProjectRoster.setLink(rosterLinkFor(m)); };
const rosterFile = (m: Machine, id: string) => path.join(m.home, '.clubhouse-dev', 'group-projects', id, 'roster.json');

describe('the authoritative roster (#3548)', () => {
  it('a copy shows every member on every computer, read from the host, with machine labels', async () => {
    const id = await linkedGroup();
    const view = available(await roster(B, id));
    expect(view).toMatchObject({ source: 'live', hostName: 'Desk', complete: true, hostInventory: 'complete', truncated: false });
    expect(view.stale).toBeUndefined();
    expect(keys(view)).toEqual([`builder_a@${A.fp}`, `builder_b@${B.fp}`, `checker@${C.fp}`, `lead@${A.fp}`].sort());
    const byKey = new Map(view.members.map((m) => [m.key, m]));
    expect(byKey.get(`lead@${A.fp}`)).toMatchObject({ machineLabel: 'Desk', provenance: 'auto', thisComputer: false, inventory: 'verified' });
    expect(byKey.get(`builder_b@${B.fp}`)).toMatchObject({ machineLabel: 'This computer', provenance: 'linked', thisComputer: true });
    expect(byKey.get(`checker@${C.fp}`)).toMatchObject({ machineLabel: 'Attic', provenance: 'linked', inventory: 'verified' });
    expect(view.copies.map((c) => [c.machine, c.state, c.thisComputer])).toEqual([[B.fp, 'verified', true], [C.fp, 'verified', false]]);

    // Its own copy of the record only knows this computer's agents well: the roster isn't built from it.
    const local = await as(B, () => B.membership!.describeMembership(id));
    expect(local.members.map((m) => m.agentId)).toEqual(['builder_b']);

    // The host reads the same roster itself, with nothing fetched.
    const onHost = available(await roster(A, id));
    expect(onHost.source).toBe('host');
    expect(keys(onHost)).toEqual(keys(view));
    expect(onHost.members.find((m) => m.agentId === 'lead')).toMatchObject({ machineLabel: 'This computer', thisComputer: true });
  });

  it('keeps two agents with one name on two computers apart', async () => {
    const id = await linkedGroup([B]);
    const builders = available(await roster(B, id)).members.filter((m) => m.label === 'Builder');
    expect(builders.map((m) => [m.key, m.machineLabel]).sort()).toEqual([[`builder_a@${A.fp}`, 'Desk'], [`builder_b@${B.fp}`, 'This computer']]);
    // A third computer that has a copy too sees both, under its own names for them.
    world.links[0].push({ machine: C.fp, projectId: 'proj_c' });
    await as(A, () => A.membership!.reconcileMembership());
    await as(C, () => C.host!.groupProjectHost.syncFrom(A.fp));
    const fromC = available(await roster(C, id)).members.filter((m) => m.label === 'Builder');
    expect(fromC.map((m) => [m.key, m.machineLabel]).sort()).toEqual([[`builder_a@${A.fp}`, 'Desk'], [`builder_b@${B.fp}`, 'Studio']]);
  });

  it('shows offline and truncated inventories as incomplete, and keeps their saved members', async () => {
    const id = await linkedGroup();
    down.add('Attic');
    truncated.add('Studio');
    // Desk can't check Attic (offline) or Studio (its snapshot left agents out).
    resetCopyCache(B);
    const view = available(await roster(B, id));
    expect(view.complete).toBe(false);
    expect(view.copies.map((c) => [c.machine, c.state])).toEqual([[B.fp, 'truncated'], [C.fp, 'offline']]);
    // Their members stay listed, marked unverified: an unknown inventory is never "no agents".
    const byKey = new Map(view.members.map((m) => [m.key, m]));
    expect(byKey.get(`checker@${C.fp}`)).toMatchObject({ inventory: 'unknown' });
    expect(byKey.get(`builder_b@${B.fp}`)).toMatchObject({ inventory: 'unknown' });
    expect(byKey.get(`lead@${A.fp}`)).toMatchObject({ inventory: 'verified' });
  });

  it('a link the host can\'t verify for another reason is unknown, not absent', async () => {
    const id = await linkedGroup([B]);
    // Studio's snapshot no longer lists the linked project at all.
    const saved = B.projects!;
    B.projects = [];
    const view = available(await roster(A, id));
    B.projects = saved;
    expect(view.copies).toEqual([expect.objectContaining({ machine: B.fp, state: 'unknown' })]);
    expect(view.complete).toBe(false);
  });

  it('an offline host leaves the saved roster, labelled stale, and nothing at all before a first read', async () => {
    const id = await linkedGroup();
    expect(await roster(C, id)).toMatchObject({ status: 'available', source: 'live' });
    down.add('Desk');
    resetCopyCache(B);
    expect(await roster(B, id)).toEqual({ groupProjectId: id, status: 'unavailable', reason: 'offline', hostName: 'Desk' });
    // Attic read it before: after a restart it still shows it, from disk, stale and never complete.
    await unload(C);
    await load(C);
    const saved = available(await roster(C, id));
    expect(saved).toMatchObject({ source: 'cache', stale: 'offline', complete: false });
    expect(saved.members).toHaveLength(4);
    // Back online: read again once the saved one is no longer fresh.
    down.delete('Desk');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16_000 });
    expect(await roster(C, id)).toMatchObject({ source: 'live', complete: true });
  });

  it('a saved roster is stale once the copy caught up past it, and is read again', async () => {
    const id = await linkedGroup();
    const first = available(await roster(B, id));
    await as(A, () => A.membership!.excludeMember(id, 'builder_a'));
    await as(B, () => B.host!.groupProjectHost.syncFrom(A.fp));
    down.add('Desk');
    const stale = available(await roster(B, id));
    expect(stale).toMatchObject({ source: 'cache', stale: 'offline', complete: false });
    expect(stale.members).toHaveLength(first.members.length);
    down.delete('Desk');
    // Past the short floor between reads, which keeps a burst of changes to one read.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 4_000 });
    const fresh = available(await roster(B, id));
    // Read again at once, not after the freshness window: the group changed since.
    expect(fresh).toMatchObject({ source: 'live' });
    expect(fresh.members.map((m) => m.agentId)).not.toContain('builder_a');
  });

  it('roles come from the host\'s real grant store, by host-relative address, not the copy\'s', async () => {
    const id = await linkedGroup();
    // The host's own agent by bare id, another computer's by `id@machine`: the keys the remote write gate checks.
    await as(A, async () => {
      await A.roles!.setGroupProjectRole(id, 'lead', 'lead', 'allow');
      await A.roles!.setGroupProjectRole(id, 'lead', 'admin', 'allow');
      await A.roles!.setGroupProjectRole(id, `builder_b@${B.fp}`, 'lead', 'ask');
      // Not a member: never shown as one.
      await A.roles!.setGroupProjectRole(id, `ghost@${C.fp}`, 'lead', 'allow');
    });
    // A bare id on the host is the host's agent, never Studio's agent of the same id.
    await as(A, () => A.roles!.setGroupProjectRole(id, 'builder_b', 'admin', 'allow'));
    // Studio's own grants say otherwise; the host doesn't enforce them for its changes.
    await as(B, async () => {
      await B.roles!.setGroupProjectRole(id, 'builder_b', 'lead', 'allow');
      await B.roles!.setGroupProjectRole(id, 'builder_b', 'admin', 'allow');
    });
    const view = available(await roster(B, id));
    const byKey = new Map(view.members.map((m) => [m.key, m]));
    expect(byKey.get(`lead@${A.fp}`)).toMatchObject({ lead: 'allow', admin: 'allow' });
    expect(byKey.get(`builder_b@${B.fp}`)).toMatchObject({ lead: 'ask', admin: 'off' });
    expect(byKey.get(`checker@${C.fp}`)).toMatchObject({ lead: 'off', admin: 'off' });
    expect(view.members.some((m) => m.agentId === 'ghost')).toBe(false);
  });

  it('an older host answers 404: the copy falls back to its own members, and asks again later', async () => {
    const id = await linkedGroup();
    old.add('Desk');
    expect(await roster(B, id)).toEqual({ groupProjectId: id, status: 'unavailable', reason: 'unsupported', hostName: 'Desk' });
    expect(await roster(B, id)).toMatchObject({ reason: 'unsupported' });
    // Believed for a while: one ask, not one per look.
    expect(rosterPosts.get('Desk') ?? 0).toBe(0);
    old.delete('Desk');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    expect(await roster(B, id)).toMatchObject({ status: 'available', source: 'live' });
  });

  it('answers not found alike for an unknown, unshared or copied group, and for a computer outside the network', async () => {
    const id = await linkedGroup();
    const local = await as(A, () => A.host!.groupProjectHost.create('Local only', { scope: { level: 'app', reach: 'local' } }));
    const ask = (from: Machine, to: Machine, groupProjectId: string) =>
      as(to, () => to.roster!.groupProjectRoster.receive(from.fp, wire({ v: 1, groupProjectId, offset: 0, limit: 10 })));
    const notFound = { v: 1, status: 'not_found' };
    expect(await ask(B, A, 'gp_nope')).toEqual(notFound);
    expect(await ask(B, A, local.id)).toEqual(notFound);
    // Studio only holds a copy: it never speaks for Desk's group.
    expect(await ask(C, B, id)).toEqual(notFound);
    outsiders.add('Attic');
    expect(await ask(C, A, id)).toEqual(notFound);
    // On its own host, a local group still has its roster.
    expect(await roster(A, local.id)).toMatchObject({ status: 'available', source: 'host' });
  });

  it('pages are capped, a copy reads every page, and a very large roster is cut and shown as incomplete', async () => {
    A.projects![0].agents = Array.from({ length: 250 }, (_, i) => ({ id: `agent_${String(i).padStart(4, '0')}`, name: `Agent ${i}` }));
    const id = await linkedGroup([B]);
    const page = await as(A, () => A.roster!.groupProjectRoster.receive(B.fp, wire({ v: 1, groupProjectId: id, offset: 0, limit: 5000 })));
    expect(page).toMatchObject({ status: 'ok', page: { offset: 0, total: 251 } });
    expect((page as { members: unknown[] }).members).toHaveLength(ROSTER_PAGE_MAX);
    // Nothing that names a place on disk, instructions or tool switches.
    const text = JSON.stringify(page);
    for (const leak of ['/a/app', '/b/app', 'proj_a', 'instructions', 'disabledTools', 'path']) expect(text).not.toContain(leak);

    const view = available(await roster(B, id));
    expect(view.members).toHaveLength(251);
    expect(new Set(view.members.map((m) => m.key)).size).toBe(251);
    expect(view).toMatchObject({ truncated: false, complete: true });
    expect(rosterPosts.get('Desk')).toBe(2);

    A.projects![0].agents = Array.from({ length: ROSTER_MEMBERS_MAX + 5 }, (_, i) => ({ id: `agent_${String(i).padStart(4, '0')}`, name: `Agent ${i}` }));
    await as(A, () => A.membership!.reconcileMembership());
    await as(B, () => B.host!.groupProjectHost.syncFrom(A.fp));
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16_000 });
    const cut = available(await roster(B, id));
    expect(cut.members).toHaveLength(ROSTER_MEMBERS_MAX);
    expect(cut).toMatchObject({ truncated: true, complete: false });
    // A page past the cap is refused outright.
    await expect(as(A, () => A.roster!.groupProjectRoster.receive(B.fp, wire({ v: 1, groupProjectId: id, offset: ROSTER_MEMBERS_MAX + 1, limit: 10 }))))
      .rejects.toMatchObject({ name: 'GroupProjectNetworkError' });
  });

  it('a host answers each computer a bounded number of pages a minute', async () => {
    const id = await linkedGroup();
    const { ROSTER_RATE_LIMIT } = A.roster!;
    const ask = (from: Machine) => as(A, () => A.roster!.groupProjectRoster.receive(from.fp, wire({ v: 1, groupProjectId: id, offset: 0, limit: 10 })));
    for (let i = 0; i < ROSTER_RATE_LIMIT; i++) expect(await ask(B)).toMatchObject({ status: 'ok' });
    expect(await ask(B)).toEqual({ v: 1, status: 'busy' });
    // Another computer isn't held up by Studio.
    expect(await ask(C)).toMatchObject({ status: 'ok' });
    // Studio's view says so honestly, rather than showing nothing as everything.
    expect(await roster(B, id)).toMatchObject({ status: 'unavailable', reason: 'busy' });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    expect(await ask(B)).toMatchObject({ status: 'ok' });
  });

  it('ignores a damaged or oversized saved roster, and saves a new one atomically', async () => {
    const id = await linkedGroup();
    await roster(B, id);
    const saved = JSON.parse(await fsp.readFile(rosterFile(B, id), 'utf-8'));
    expect(saved).toMatchObject({ version: 1, page: { host: { machine: A.fp } } });
    const dir = path.dirname(rosterFile(B, id));
    expect((await fsp.readdir(dir)).filter((f) => f.includes('roster') && f !== 'roster.json')).toEqual([]);

    down.add('Desk');
    await fsp.writeFile(rosterFile(B, id), '{ not json');
    resetCopyCache(B);
    expect(await roster(B, id)).toMatchObject({ status: 'unavailable', reason: 'offline' });

    await fsp.writeFile(rosterFile(B, id), JSON.stringify({ ...saved, pad: 'x'.repeat(A.roster!.ROSTER_CACHE_MAX_BYTES + 1) }));
    resetCopyCache(B);
    expect(await roster(B, id)).toMatchObject({ status: 'unavailable', reason: 'offline' });

    // A saved roster that claims another host's group, or an injected member, is refused too.
    await fsp.writeFile(rosterFile(B, id), JSON.stringify({ ...saved, page: { ...saved.page, host: { machine: C.fp } } }));
    resetCopyCache(B);
    expect(await roster(B, id)).toMatchObject({ status: 'unavailable', reason: 'offline' });
    await fsp.writeFile(rosterFile(B, id), JSON.stringify({ ...saved, page: { ...saved.page, members: [{ agentId: 'x', machine: 'nope' }] } }));
    resetCopyCache(B);
    expect(await roster(B, id)).toMatchObject({ status: 'unavailable', reason: 'offline' });
  });

  it('a maximum-size roster is saved, survives a restart, and shows from the saved copy while the host is offline (#3581)', async () => {
    // The longest ids, and labels at their cap in three-byte characters, for the most members a copy reads.
    const wide = '\u9f8d'.repeat(120);
    A.projects![0].name = wide;
    A.projects![0].agents = Array.from({ length: ROSTER_MEMBERS_MAX }, (_, i) => ({ id: `${String(i).padStart(4, '0')}${'a'.repeat(196)}`, name: `${wide}${i}` }));
    const id = await linkedGroup([B]);
    const live = available(await roster(B, id));
    expect(live.members).toHaveLength(ROSTER_MEMBERS_MAX);
    const size = (await fsp.stat(rosterFile(B, id))).size;
    // Big enough that the old pretty-printed file would have gone past the old 1 MB cap, and within the cap now.
    expect(size).toBeGreaterThan(700 * 1024);
    expect(size).toBeLessThanOrEqual(B.roster!.ROSTER_CACHE_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(JSON.parse(await fsp.readFile(rosterFile(B, id), 'utf-8')), null, 2))).toBeGreaterThan(1024 * 1024);
    // Restart while the host is offline: the saved roster is read, not ignored.
    down.add('Desk');
    resetCopyCache(B);
    const after = available(await roster(B, id));
    expect(after).toMatchObject({ source: 'cache', stale: 'offline' });
    expect(after.members).toHaveLength(ROSTER_MEMBERS_MAX);
  });

  it('sustained board posts with an open panel stay under the host\'s page limit and never fail the roster (#3581)', { timeout: 60_000 }, async () => {
    // Two pages a read: a read every 3 seconds would be 40 pages a minute, past the host's 25.
    A.projects![0].agents = Array.from({ length: 250 }, (_, i) => ({ id: `agent_${String(i).padStart(4, '0')}`, name: `Agent ${i}` }));
    const id = await linkedGroup([B]);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    // A panel open for five minutes that asks on each change, as a post lands every 3 seconds.
    for (let step = 0; step < 100; step++) {
      vi.setSystemTime(Date.now() + 3000);
      await as(A, () => A.host!.groupProjectHost.post(id, 'Lead', 'general', `post ${step}`));
      await as(B, () => B.host!.groupProjectHost.syncFrom(A.fp));
      const view = available(await roster(B, id));
      // Nothing about the members changed, so a post never makes the roster stale, busy or incomplete.
      expect(view.stale).toBeUndefined();
      expect(view).toMatchObject({ complete: true });
      expect(view.members).toHaveLength(251);
    }
    // At most one read (two pages) per 15 seconds: 40 pages in five minutes, nowhere near 25 a minute.
    expect(rosterPosts.get('Desk')!).toBeLessThanOrEqual(2 * 21);
    expect(rosterPosts.get('Desk')! / 5).toBeLessThan(A.roster!.ROSTER_RATE_LIMIT);
  });

  it('a membership change during sustained posts is still read again once the floor passes (#3581)', async () => {
    const id = await linkedGroup([B]);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    available(await roster(B, id));
    const before = rosterPosts.get('Desk')!;
    vi.setSystemTime(Date.now() + 4_000);
    await as(A, () => A.host!.groupProjectHost.post(id, 'Lead', 'general', 'hello'));
    await as(B, () => B.host!.groupProjectHost.syncFrom(A.fp));
    // Only a post: still the saved roster, no read.
    expect(available(await roster(B, id))).toMatchObject({ source: 'cache' });
    expect(rosterPosts.get('Desk')).toBe(before);
    await as(A, () => A.membership!.excludeMember(id, 'builder_a'));
    await as(B, () => B.host!.groupProjectHost.syncFrom(A.fp));
    const fresh = available(await roster(B, id));
    expect(fresh).toMatchObject({ source: 'live' });
    expect(fresh.members.map((m) => m.agentId)).not.toContain('builder_a');
  });

  it('caps each answer\'s bytes: an oversized page fails the read, never shows', async () => {
    const id = await linkedGroup();
    bloated.add('Desk');
    expect(await roster(B, id)).toMatchObject({ status: 'unavailable', reason: 'failed' });
    expect(askedLimits.every((limit) => limit === 512 * 1024)).toBe(true);
    // Validated too: a generatedAt that isn't a date, or a page with no digest, is refused.
    const page = await as(A, () => A.roster!.groupProjectRoster.receive(B.fp, wire({ v: 1, groupProjectId: id, offset: 0, limit: 10 })));
    const request = { v: 1 as const, groupProjectId: id, offset: 0, limit: 10 };
    expect(() => readRosterAnswer({ ...(page as object), generatedAt: 'x'.repeat(41) }, A.fp, request)).toThrow();
    expect(() => readRosterAnswer({ ...(page as object), generatedAt: 'yesterday' }, A.fp, request)).toThrow();
    expect(() => readRosterAnswer({ ...(page as object), etag: undefined }, A.fp, request)).toThrow();
  });

  it('a roster that changes between pages is read again from the start, never stitched', async () => {
    A.projects![0].agents = Array.from({ length: 250 }, (_, i) => ({ id: `agent_${String(i).padStart(4, '0')}`, name: `Agent ${i}` }));
    const id = await linkedGroup([B]);
    // An agent appears on the host between page one and two: no sequence number changes, but the digest does.
    world.betweenPages = async () => { A.projects![0].agents.unshift({ id: 'aaa_new', name: 'Aaa new' }); };
    const view = available(await roster(B, id));
    expect(view.members.map((m) => m.agentId)).toContain('aaa_new');
    expect(view.members).toHaveLength(252);
    expect(new Set(view.members.map((m) => m.key)).size).toBe(252);
    expect(rosterPosts.get('Desk')).toBe(4);
  });

  it('more linked copies than a page carries are cut and marked, never complete', async () => {
    const extra = Array.from({ length: 40 }, (_, i) => ({ machine: fp(i.toString(16).padStart(2, '0').replace(/^(aa|bb|cc)$/, 'dd')), projectId: `p${i}` }));
    const id = await linkedGroup([B]);
    world.links[0].push(...extra);
    const page = await as(A, () => A.roster!.groupProjectRoster.receive(B.fp, wire({ v: 1, groupProjectId: id, offset: 0, limit: 10 }))) as { copies: unknown[]; copiesCut?: boolean };
    expect(page.copies).toHaveLength(32);
    expect(page.copiesCut).toBe(true);
    expect(await roster(B, id)).toMatchObject({ status: 'available', copiesCut: true, complete: false });
  });

  it('a saved roster with a fetch time in the future is not fresh', async () => {
    const id = await linkedGroup();
    await roster(B, id);
    const posts = rosterPosts.get('Desk');
    // The clock moved back a minute: the saved roster now looks fetched in the future.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 60_000 });
    expect(await roster(B, id)).toMatchObject({ source: 'live' });
    expect(rosterPosts.get('Desk')).toBeGreaterThan(posts!);
  });

  it('never brings back the folder of a copy that went', async () => {
    const id = await linkedGroup();
    await fsp.rm(path.dirname(rosterFile(B, id)), { recursive: true, force: true });
    await roster(B, id);
    await expect(fsp.stat(path.dirname(rosterFile(B, id)))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a host that left the network leaves only the saved roster, stale', async () => {
    const id = await linkedGroup();
    await roster(B, id);
    outsiders.add('Desk');
    expect(await roster(B, id)).toMatchObject({ status: 'available', source: 'cache', stale: 'offline', complete: false });
  });
});
