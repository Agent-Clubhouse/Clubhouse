/**
 * Creating a group project on another computer (#3547), with two and three
 * desktops in one process: each runs its own host service, registry, board,
 * Needs you requests and remote create module, with its own home folder and
 * identity. Requests go through JSON and the wire's own validators. A test can
 * take a computer offline, make one an older version, or lose an answer.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  GROUP_PROJECT_CREATE_CAPABILITIES_PATH, GROUP_PROJECT_CREATE_PATH, readSyncRequest, readSyncResponse, readWriteRequest, readWriteResponse,
} from '../../shared/group-project-network';
import { REMOTE_CREATE_TOOL } from '../../shared/grant-requests';

type Project = { id: string; name: string; path: string; key: string; agents: Array<{ id: string; name: string }> };

interface Machine {
  name: string;
  fp: string;
  home: string;
  projects?: Project[];
  dispatcherOn: boolean;
  host?: typeof import('./group-project-host');
  registry?: typeof import('./group-project-registry');
  membership?: typeof import('./group-project-membership');
  delivery?: typeof import('./group-project-delivery');
  persisted?: typeof import('./persisted-bindings');
  bindings?: typeof import('./clubhouse-mcp/binding-manager');
  remote?: typeof import('./group-project-remote-create');
  grants?: typeof import('./grant-requests');
}

const world = vi.hoisted(() => ({
  als: null as unknown as AsyncLocalStorage<{ home: string; fp: string; projects?: Project[] }>,
  fallbackHome: '',
  links: [] as Array<Array<{ machine: string; projectId: string }>>,
}));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => world.als?.getStore()?.home ?? world.fallbackHome } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./grant-telemetry', () => ({ recordGrantRequest: vi.fn() }));
vi.mock('./annex-network-profile', () => ({ annexEphemeralSession: () => false }));
vi.mock('./annex-identity', () => ({ getIdentity: () => (world.als?.getStore() ? { fingerprint: world.als.getStore()!.fp } : null) }));
vi.mock('./annex-settings', () => ({ networkEnabled: () => true }));
const projectsHere = () => world.als?.getStore()?.projects ?? [];
vi.mock('./project-store', () => ({
  list: vi.fn(async () => projectsHere().map(({ id, name, path }) => ({ id, name, path }))),
  onProjectsChanged: vi.fn(() => () => undefined),
}));
vi.mock('./project-links-store', () => ({ projectLinksStore: () => ({ groups: () => world.links, onChange: () => () => {} }) }));
vi.mock('./annex-client', () => ({
  getSatellites: () => machines.filter((m) => m.fp !== world.als?.getStore()?.fp).map((m) => ({
    fingerprint: m.fp, alias: m.name, state: down.has(m.name) ? 'disconnected' : 'connected',
    snapshot: { projects: m.projects, agents: Object.fromEntries((m.projects ?? []).map((p) => [p.id, p.agents])), quickAgents: {} },
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
  projectKey: vi.fn(async (projectPath: string) => projectsHere().find((p) => p.path === projectPath)?.key ?? 'unknown'),
}));

const fp = (n: string) => Array.from({ length: 32 }, () => n).join(':');
const A: Machine = { name: 'Desk', fp: fp('aa'), home: '', dispatcherOn: true };
const B: Machine = { name: 'Studio', fp: fp('bb'), home: '', dispatcherOn: true };
const C: Machine = { name: 'Attic', fp: fp('cc'), home: '', dispatcherOn: true };
const machines = [A, B, C];
const byFp = (f: string) => machines.find((m) => m.fp === f.toLowerCase())!;
/** Offline computers, by name. */
const down = new Set<string>();
/** Computers on a Clubhouse from before #3547: they answer 404. */
const old = new Set<string>();
/** Groups each computer started (afterCreate: membership and the created notice), in order. */
const startedOn = new Map<string, string[]>();
/** The next answer from this computer is lost after it acted. */
const loseNext = new Set<string>();

function as<T>(m: Machine, fn: () => Promise<T> | T): Promise<T> {
  return world.als.run({ home: m.home, fp: m.fp, projects: m.projects }, async () => fn());
}

const wire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));
const connected = (self: Machine, machine: string) => !down.has(byFp(machine).name) && !down.has(self.name);

function linkFor(self: Machine) {
  return {
    connected: (machine: string) => connected(self, machine),
    isMember: (machine: string) => machines.some((m) => m.fp === machine.toLowerCase()),
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

/** What annex-server's routes do for an authenticated network computer. */
function createLinkFor(self: Machine) {
  return {
    connected: (machine: string) => connected(self, machine),
    isMember: (machine: string) => machines.some((m) => m.fp === machine.toLowerCase()),
    members: () => machines.map((m) => m.fp),
    machineName: (machine: string) => byFp(machine).name,
    post: async (machine: string, urlPath: string, body: Record<string, unknown>) => {
      if (!connected(self, machine)) throw new Error('Satellite not connected');
      const other = byFp(machine);
      if (old.has(other.name)) return { status: 404, body: { error: 'not_found' } };
      let answer: unknown;
      try {
        answer = urlPath === GROUP_PROJECT_CREATE_PATH ? await as(other, () => other.remote!.groupProjectRemoteCreate.receive(self.fp, wire(body)))
          : urlPath === GROUP_PROJECT_CREATE_CAPABILITIES_PATH ? await as(other, () => other.remote!.groupProjectRemoteCreate.capabilities())
            : undefined;
      } catch (err) {
        if (err instanceof Error && err.name === 'GroupProjectNetworkError') return { status: 400, body: { error: 'invalid_request' } };
        throw err;
      }
      if (answer === undefined) return { status: 404, body: {} };
      if (loseNext.delete(other.name)) throw new Error('socket hang up');
      return { status: 200, body: wire(answer) };
    },
  };
}

async function load(m: Machine): Promise<void> {
  vi.resetModules();
  m.host = await import('./group-project-host');
  m.registry = await import('./group-project-registry');
  m.membership = await import('./group-project-membership');
  m.delivery = await import('./group-project-delivery');
  m.persisted = await import('./persisted-bindings');
  m.bindings = await import('./clubhouse-mcp/binding-manager');
  m.remote = await import('./group-project-remote-create');
  m.grants = await import('./grant-requests');
  m.host.groupProjectHost.setNetworkLink(linkFor(m));
  m.remote.groupProjectRemoteCreate.setLink(createLinkFor(m));
  const membership = m.membership;
  m.remote.groupProjectRemoteCreate.setHostDeps({
    approvalPlace: () => (m.dispatcherOn ? { agentId: 'dispatcher', agentName: 'Dispatcher', projectPath: '/dispatcher' } : null),
    afterCreate: async (project) => {
      startedOn.set(m.name, [...(startedOn.get(m.name) ?? []), project.id]);
      await as(m, () => membership.beginAutoJoin(project.id));
    },
  });
}

async function unload(m: Machine): Promise<void> {
  await as(m, async () => { await m.host!.groupProjectHost.flushRegistry(); await m.host!.groupProjectHost.flushBoards(); });
  m.remote!.groupProjectRemoteCreate._resetForTesting();
  m.grants!._resetGrantRequestsForTesting();
  m.host!.groupProjectHost._resetForTesting();
  m.registry!.groupProjectRegistry._resetForTesting();
  m.membership!._resetMembershipForTesting();
  m.delivery!._resetDeliveryForTesting();
  m.persisted!._resetPersistedBindingSourcesForTesting();
  m.bindings!.bindingManager._resetForTesting();
}

beforeEach(async () => {
  world.als = new AsyncLocalStorage();
  const cache = path.join(process.cwd(), 'node_modules', '.cache');
  await fsp.mkdir(cache, { recursive: true });
  world.fallbackHome = await fsp.mkdtemp(path.join(cache, 'gp-rc-none-'));
  down.clear(); old.clear(); loseNext.clear(); startedOn.clear(); world.links = [];
  A.projects = [{ id: 'proj_a', name: 'App', path: '/a/app', key: 'github.com/org/app', agents: [{ id: 'lead', name: 'lead' }] }];
  B.projects = [
    { id: 'proj_b', name: 'App', path: '/b/app', key: 'github.com/org/app', agents: [{ id: 'builder', name: 'builder' }] },
    { id: 'proj_other', name: 'Other', path: '/b/other', key: 'github.com/org/other', agents: [] },
  ];
  C.projects = [];
  for (const m of machines) {
    m.dispatcherOn = true;
    m.home = await fsp.mkdtemp(path.join(cache, `gp-rc-${m.name}-`));
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

const appWide = { scope: { level: 'app', reach: 'network' }, membership: { autoJoin: false, includeLinkedComputers: false, excluded: [] } } as const;
const projectGroup = (excluded: string[] = []) => ({
  scope: { level: 'project', projectId: 'proj_a', reach: 'network' }, membership: { autoJoin: true, includeLinkedComputers: true, excluded },
} as const);

const ask = (from: Machine, to: Machine, name: string, options: Parameters<NonNullable<Machine['remote']>['groupProjectRemoteCreate']['createOn']>[2] = appWide, retryOf?: string) =>
  as(from, () => from.remote!.groupProjectRemoteCreate.createOn(to.fp, name, options, retryOf));
const retry = (from: Machine, to: Machine, requestId: string) => ask(from, to, '', undefined, requestId);
const waitingOn = (m: Machine) => as(m, () => m.grants!.listGrantRequests());
/** The person on the host answers in Needs you: the request is used up, as answerGrantRequest does. */
const answer = async (m: Machine, requestId: string, allow: boolean) => {
  await as(m, async () => {
    expect(m.grants!.takeGrantRequest(requestId, allow)).not.toBeNull();
    m.grants!.finishGrantAnswer(requestId);
  });
  // Let the host record the answer, and create on Allow.
  await vi.waitFor(async () => {
    const answers = JSON.parse(await fsp.readFile(path.join(m.home, '.clubhouse-dev', 'group-projects', 'network-create-answers.json'), 'utf-8')) as { items: Array<{ grantRequestId?: string; answer: { status: string } }> };
    expect(answers.items.some((e) => e.grantRequestId === requestId && e.answer.status === 'waiting')).toBe(false);
  }, SETTLE);
};
const answersFile = (m: Machine) => path.join(m.home, '.clubhouse-dev', 'group-projects', 'network-create-answers.json');
const hosted = (m: Machine) => as(m, async () => (await m.host!.groupProjectHost.list()).filter((p) => !m.host!.groupProjectHost.isReplica(p)));

/**
 * Budgets for this multi-computer simulation, whose steps (create, save, start,
 * answer) trail one another through real files. A poll that succeeds returns on
 * its first success, so the larger poll budget only bounds a failure; the default
 * 1s missed on a loaded runner ('an Allow stays an Allow…'). The describe budget
 * is what lets such a poll run its course: the whole file takes about 7s locally.
 */
const SETTLE = { timeout: 10_000 };
const SIM_TEST_BUDGET_MS = 30_000;

describe('creating a group project on another computer (#3547)', { timeout: SIM_TEST_BUDGET_MS }, () => {
  it('a person\'s request waits for approval on the host, never created on the request alone, and Allow creates it once', async () => {
    const asked = await ask(A, B, 'Launch');
    expect(asked).toMatchObject({ status: 'waiting', host: B.fp, hostName: 'Studio' });
    // No bypass: the person is trusted for writes, but a create waits. Nothing was made on either computer.
    expect(await hosted(B)).toEqual([]);
    expect(await hosted(A)).toEqual([]);

    const [request] = await waitingOn(B);
    expect(request).toMatchObject({
      kind: 'call', agentId: 'dispatcher', toolName: REMOTE_CREATE_TOOL, actions: ['connection.manage'],
      remoteCreateReview: { machine: A.fp, machineName: 'Desk', name: 'Launch', scopeLabel: expect.stringContaining('whole app'), excluded: [] },
      argumentsText: JSON.stringify({ machine: A.fp, requestId: asked.requestId }),
    });
    expect(request.details).toContain('Create the group project "Launch" on this computer, as Desk asked.');
    // Single use, bounded: the ordinary 24-hour expiry.
    expect(Date.parse(request.expiresAt) - Date.parse(request.createdAt)).toBe(24 * 60 * 60 * 1000);

    // Asking again with the same id while it waits makes no second request.
    expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'waiting' });
    expect(await waitingOn(B)).toHaveLength(1);

    await answer(B, request.requestId, true);
    const made = await hosted(B);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ name: 'Launch', scope: { level: 'app', reach: 'network' }, metadata: { remoteCreate: { machine: A.fp, requestId: asked.requestId } } });
    expect(await as(B, () => B.host!.groupProjectHost.getMembership(made[0].id))).toMatchObject({ membershipPolicy: 'project-3546', autoJoin: false });

    const done = await retry(A, B, asked.requestId);
    expect(done).toMatchObject({ status: 'created', groupProjectId: made[0].id, project: { id: made[0].id, hostName: 'Studio', network: { role: 'replica' } } });
    // The approval was used once: it can't make another.
    expect(await as(B, () => B.grants!.hasCallApproval(B.grants!.callKey('dispatcher', REMOTE_CREATE_TOOL, { machine: A.fp, requestId: asked.requestId })))).toBe(false);
    expect(await hosted(B)).toHaveLength(1);
    expect(startedOn.get('Studio')).toEqual([made[0].id]);
  });

  it('Decline creates nothing, and a retry with the same id is told so', async () => {
    const asked = await ask(A, B, 'Nope');
    const [request] = await waitingOn(B);
    await answer(B, request.requestId, false);
    expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'declined', reason: expect.stringContaining('declined') });
    expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'declined' });
    expect(await hosted(B)).toEqual([]);
  });

  it('an approval nobody answers expires, and creates nothing', async () => {
    const asked = await ask(A, B, 'Later');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 24 * 60 * 60 * 1000 + 1000 });
    expect(await waitingOn(B)).toEqual([]);
    vi.useRealTimers();
    await vi.waitFor(async () => expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'expired', reason: expect.stringContaining('in time') }), SETTLE);
    expect(await hosted(B)).toEqual([]);
  });

  it('a host restart before an answer ends the request: approvals live in memory', async () => {
    const asked = await ask(A, B, 'Restarted');
    await unload(B);
    await load(B);
    expect(await waitingOn(B)).toEqual([]);
    expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'expired', reason: expect.stringContaining('restarted') });
    expect(await hosted(B)).toEqual([]);
  });

  it('a retry after a lost answer returns the same group, never a second one', async () => {
    const asked = await ask(A, B, 'Once');
    const [request] = await waitingOn(B);
    await answer(B, request.requestId, true);
    loseNext.add('Studio');
    expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'unreachable', reason: expect.stringContaining('Retry is safe') });
    const again = await retry(A, B, asked.requestId);
    expect(again).toMatchObject({ status: 'created' });
    expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'created', groupProjectId: (again as { groupProjectId: string }).groupProjectId });
    expect(await hosted(B)).toHaveLength(1);
  });

  it('a first send whose answer is lost is found again by its id, not asked twice', async () => {
    loseNext.add('Studio');
    const asked = await ask(A, B, 'Lost');
    expect(asked.status).toBe('unreachable');
    expect(await waitingOn(B)).toHaveLength(1);
    expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'waiting' });
    expect(await waitingOn(B)).toHaveLength(1);
  });

  it('a group made before a crash lost its answer is found by its mark', async () => {
    const asked = await ask(A, B, 'Crash');
    const [request] = await waitingOn(B);
    await answer(B, request.requestId, true);
    // The answer file is lost; the group's own record still names the request.
    await fsp.rm(path.join(B.home, '.clubhouse-dev', 'group-projects', 'network-create-answers.json'));
    await unload(B);
    await load(B);
    expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'created' });
    expect(await hosted(B)).toHaveLength(1);
  });

  it('a crash after the create but before its answer was saved still answers created after a restart (QA #3569)', async () => {
    const asked = await ask(A, B, 'Crash window');
    const [request] = await waitingOn(B);
    const waitingFile = await fsp.readFile(answersFile(B), 'utf-8');
    await answer(B, request.requestId, true);
    expect(await hosted(B)).toHaveLength(1);
    // The group was made and flushed; the answer never reached the file, and nothing after the create ran.
    await fsp.writeFile(answersFile(B), waitingFile);
    startedOn.clear();
    await unload(B);
    await load(B);
    const [made] = await hosted(B);
    expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'created', groupProjectId: made.id });
    expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'created' });
    expect(await hosted(B)).toHaveLength(1);
    // Recovered, it is started once, then never again.
    await vi.waitFor(() => expect(startedOn.get('Studio')).toEqual([made.id]), SETTLE);
    await unload(B);
    await load(B);
    await retry(A, B, asked.requestId);
    expect(startedOn.get('Studio')).toEqual([made.id]);
  });

  describe('a failed lookup during the recovery start (#3592 L1)', () => {
    async function crashWindow(name: string) {
      const asked = await ask(A, B, name);
      const [request] = await waitingOn(B);
      const waitingFile = await fsp.readFile(answersFile(B), 'utf-8');
      await answer(B, request.requestId, true);
      // Allow records the create, then starts the group and records that, in the background. Wait for that
      // last write: a late one would replace the stale file below, and the crash this simulates (the create
      // made, its answer not saved) would be lost, so recovery would find nothing to start (#3824).
      await vi.waitFor(async () => {
        const { items } = JSON.parse(await fsp.readFile(answersFile(B), 'utf-8')) as { items: Array<{ answer: { status: string }; started?: boolean }> };
        expect(items.some((e) => e.answer.status === 'created')).toBe(true);
        expect(items.some((e) => e.started === false)).toBe(false);
      }, SETTLE);
      await fsp.writeFile(answersFile(B), waitingFile);
      startedOn.clear();
      await unload(B);
      await load(B);
      const [made] = await hosted(B);
      return { asked, made };
    }
    // Fails every lookup of the group until healed, so both the request's start and startPending see the error.
    const lookupFails = (id: string, mode: 'until-healed' | 'absent') => {
      const host = B.host!.groupProjectHost, get = host.get.bind(host); let calls = 0, failing = true;
      vi.spyOn(host, 'get').mockImplementation(async (wanted: string) => {
        if (wanted !== id) return get(wanted);
        calls++;
        if (mode === 'absent') return null;
        if (failing) throw new Error('transient reconcile failure');
        return get(wanted);
      });
      return { calls: () => calls, heal: () => { failing = false; } };
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

    it('stays pending after a thrown lookup, then the next request starts it exactly once', async () => {
      const { asked, made } = await crashWindow('Lookup fails once');
      const lookup = lookupFails(made.id, 'until-healed');
      expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'created', groupProjectId: made.id });
      await settle();
      expect(lookup.calls()).toBeGreaterThanOrEqual(1);
      expect(startedOn.get('Studio')).toBeUndefined();
      lookup.heal();
      expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'created', groupProjectId: made.id });
      await vi.waitFor(() => expect(startedOn.get('Studio')).toEqual([made.id]), SETTLE);
      await retry(A, B, asked.requestId); await settle();
      await unload(B); await load(B); await retry(A, B, asked.requestId); await settle();
      expect(startedOn.get('Studio')).toEqual([made.id]);
    });

    it('stays pending after a thrown lookup, then a restart recovers it exactly once', async () => {
      const { asked, made } = await crashWindow('Lookup fails before restart');
      lookupFails(made.id, 'until-healed');
      await retry(A, B, asked.requestId); await settle();
      expect(startedOn.get('Studio')).toBeUndefined();
      await unload(B); await load(B); // the reload drops the failing spy: the restart's lookups succeed
      await retry(A, B, asked.requestId);
      await vi.waitFor(() => expect(startedOn.get('Studio')).toEqual([made.id]), SETTLE);
      await unload(B); await load(B); await retry(A, B, asked.requestId); await settle();
      expect(startedOn.get('Studio')).toEqual([made.id]);
    });

    it('settles a group that is gone without starting it, and never asks again', async () => {
      const { asked, made } = await crashWindow('Group gone');
      const lookup = lookupFails(made.id, 'absent');
      expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'created', groupProjectId: made.id });
      await settle();
      const settled = lookup.calls();
      expect(settled).toBeGreaterThanOrEqual(1);
      await retry(A, B, asked.requestId); await settle();
      expect(lookup.calls()).toBe(settled);
      expect(startedOn.get('Studio')).toBeUndefined();
    });
  });

  it('a stale answer is never given over the group its request made', async () => {
    const asked = await ask(A, B, 'Stale');
    const [request] = await waitingOn(B);
    const waitingFile = JSON.parse(await fsp.readFile(answersFile(B), 'utf-8')) as { items: Array<{ answer: Record<string, unknown> }> };
    await answer(B, request.requestId, true);
    // Left with an older non-created answer, the mark still wins.
    waitingFile.items[0].answer = { v: 1, requestId: asked.requestId, status: 'expired', reason: 'old' };
    await fsp.writeFile(answersFile(B), JSON.stringify(waitingFile));
    await unload(B);
    await load(B);
    expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'created' });
    expect(await hosted(B)).toHaveLength(1);
  });

  it('a failed save after the create records no refusal; the retry finds the group by its mark', async () => {
    const asked = await ask(A, B, 'Flush fails');
    const [request] = await waitingOn(B);
    const flush = vi.spyOn(B.host!.groupProjectHost, 'flushRegistry').mockRejectedValueOnce(new Error('disk full'));
    await as(B, () => { B.grants!.takeGrantRequest(request.requestId, true); B.grants!.finishGrantAnswer(request.requestId); });
    await vi.waitFor(() => expect(flush).toHaveBeenCalled(), SETTLE);
    await vi.waitFor(async () => expect(await hosted(B)).toHaveLength(1), SETTLE);
    flush.mockRestore();
    expect(startedOn.get('Studio')).toBeUndefined();
    expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'created' });
    expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'created' });
    expect(await hosted(B)).toHaveLength(1);
    // Found by its mark, it is started once.
    expect(startedOn.get('Studio')).toEqual([(await hosted(B))[0].id]);
  });

  it('an Allow stays an Allow when the Dispatcher\'s permissions change right after it', async () => {
    const asked = await ask(A, B, 'Kept');
    const [request] = await waitingOn(B);
    await as(B, () => {
      B.grants!.takeGrantRequest(request.requestId, true);
      B.grants!.dropCallApprovalsFor('dispatcher');
      B.grants!.finishGrantAnswer(request.requestId);
    });
    await vi.waitFor(async () => expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'created' }), SETTLE);
  });

  it('the mark can\'t be written by an update, here or from another computer, so it can\'t forge a created answer', async () => {
    const existing = await as(B, () => B.host!.groupProjectHost.create('Existing', { scope: { level: 'app', reach: 'network' } }));
    const forged = { machine: A.fp, requestId: 'rc_forged', hash: 'x' };
    await as(B, () => B.host!.groupProjectHost.update(existing.id, { metadata: { remoteCreate: forged, other: 1 } }));
    expect((await as(B, () => B.host!.groupProjectHost.get(existing.id)))!.metadata).toEqual({ other: 1 });
    await as(A, () => A.host!.groupProjectHost.syncFrom(B.fp));
    // A replica write names its author explicitly (#3664); here, the person on the other computer.
    await as(A, () => A.host!.groupProjectHost.update(existing.id, { metadata: { remoteCreate: forged } }, { author: { label: 'user' } }));
    expect((await as(B, () => B.host!.groupProjectHost.get(existing.id)))!.metadata.remoteCreate).toBeUndefined();
  });

  it('an unreachable host gets nothing: nothing is created or queued, and Retry is safe later', async () => {
    down.add('Studio');
    const asked = await ask(A, B, 'Offline');
    expect(asked).toMatchObject({ status: 'unreachable', reason: expect.stringContaining('nothing is queued') });
    expect(await as(A, () => A.host!.groupProjectHost.list())).toEqual([]);
    down.delete('Studio');
    expect(await waitingOn(B)).toEqual([]);
    expect(await hosted(B)).toEqual([]);
    // Coming back sends nothing by itself.
    await as(A, () => A.host!.groupProjectHost.flushOutbox(B.fp));
    expect(await waitingOn(B)).toEqual([]);
    expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'waiting' });
  });

  it('a retry sends the saved request exactly, whatever the form says now', async () => {
    down.add('Studio');
    const asked = await ask(A, B, 'Saved name');
    down.delete('Studio');
    expect(await ask(A, B, 'Edited name', appWide, asked.requestId)).toMatchObject({ status: 'waiting' });
    expect((await waitingOn(B))[0].remoteCreateReview?.name).toBe('Saved name');
    await expect(ask(A, C, 'Saved name', appWide, asked.requestId)).rejects.toThrow('no longer saved');
  });

  it('the host checks the scope again: an unlinked project is refused, a linked one becomes the host\'s own', async () => {
    const unlinked = await ask(A, B, 'Team', projectGroup());
    expect(unlinked).toMatchObject({ status: 'refused', reason: expect.stringContaining('isn\'t linked to a project on this computer') });
    expect(await retry(A, B, unlinked.requestId)).toMatchObject({ status: 'refused' });
    expect(await waitingOn(B)).toEqual([]);

    // A matching repository isn't consent: only an explicit link counts (#3546).
    world.links = [[{ machine: A.fp, projectId: 'proj_a' }, { machine: B.fp, projectId: 'proj_b' }]];
    const linked = await ask(A, B, 'Team', projectGroup(['lead', `builder@${B.fp}`]));
    expect(linked.status).toBe('waiting');
    const [request] = await waitingOn(B);
    expect(request.remoteCreateReview).toMatchObject({
      scopeLabel: expect.stringContaining('App on this computer'),
      membershipLabel: expect.stringContaining('linked computers'),
      // Relative to the host: its own agent bare, the asker's qualified.
      excluded: ['builder', `lead@${A.fp}`].sort(),
    });
    await answer(B, request.requestId, true);
    const [made] = await hosted(B);
    expect(made.scope).toEqual({ level: 'project', projectId: 'proj_b', reach: 'network' });
    const membership = await as(B, () => B.host!.groupProjectHost.getMembership(made.id));
    expect(membership).toMatchObject({ membershipPolicy: 'project-3546', autoJoin: true, includeLinkedComputers: true });
    expect(membership.excluded.map((e) => e.address).sort()).toEqual(['builder', `lead@${A.fp}`].sort());
  });

  it('a link removed after asking makes Allow refuse instead of creating', async () => {
    world.links = [[{ machine: A.fp, projectId: 'proj_a' }, { machine: B.fp, projectId: 'proj_b' }]];
    const asked = await ask(A, B, 'Team', projectGroup());
    const [request] = await waitingOn(B);
    world.links = [];
    await answer(B, request.requestId, true);
    expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'refused', reason: expect.stringContaining('approved, but') });
    expect(await hosted(B)).toEqual([]);
  });

  it('a bad scope never reaches a host: this computer refuses a local one, the host refuses a malformed one', async () => {
    await expect(ask(A, B, 'Local', { scope: { level: 'app', reach: 'local' } })).rejects.toThrow('shared with your network');
    const raw = await as(A, () => createLinkFor(A).post(B.fp, GROUP_PROJECT_CREATE_PATH, {
      v: 1, requestId: 'rc_bad', name: 'Bad', scope: { level: 'everything' }, membership: { autoJoin: false, includeLinkedComputers: false, excluded: [] },
    }));
    expect(raw.status).toBe(400);
    expect(await waitingOn(B)).toEqual([]);
  });

  it('the same request id with a different body is refused', async () => {
    const asked = await ask(A, B, 'First');
    const raw = await as(A, () => createLinkFor(A).post(B.fp, GROUP_PROJECT_CREATE_PATH, {
      v: 1, requestId: asked.requestId, name: 'Second', scope: { level: 'app' }, membership: { autoJoin: false, includeLinkedComputers: false, excluded: [] },
    }));
    expect(raw.body).toMatchObject({ status: 'refused', reason: expect.stringContaining('different group project') });
    expect(await waitingOn(B)).toHaveLength(1);
  });

  it('a host whose Dispatcher is off can\'t show the approval, so it refuses; Retry works once it is on', async () => {
    B.dispatcherOn = false;
    const asked = await ask(A, B, 'Quiet');
    // Not final: the asker is offered Retry.
    expect(asked).toMatchObject({ status: 'busy', reason: expect.stringContaining('Dispatcher is off') });
    B.dispatcherOn = true;
    expect(await retry(A, B, asked.requestId)).toMatchObject({ status: 'waiting' });
  });

  it('one computer can\'t flood the host\'s Needs you', async () => {
    expect((await ask(A, B, 'One')).status).toBe('waiting');
    expect((await ask(A, B, 'Two')).status).toBe('waiting');
    expect(await ask(A, B, 'Three')).toMatchObject({ status: 'busy', reason: expect.stringContaining('still waiting') });
    expect(await waitingOn(B)).toHaveLength(2);
    // Busy isn't final: the same id goes through once there's room.
    const third = (await ask(A, B, 'Three again'));
    for (const request of await waitingOn(B)) await answer(B, request.requestId, false);
    expect(await retry(A, B, third.requestId)).toMatchObject({ status: 'waiting' });
    // And new requests are limited per window, answered or not: five, then busy.
    for (const request of await waitingOn(B)) await answer(B, request.requestId, false);
    expect((await ask(A, B, 'Four')).status).toBe('waiting');
    expect((await ask(A, B, 'Five')).status).toBe('waiting');
    for (const request of await waitingOn(B)) await answer(B, request.requestId, false);
    expect(await ask(A, B, 'Six')).toMatchObject({ status: 'busy', reason: expect.stringContaining('Too many create requests') });
    // Another computer isn't held back by this one.
    expect((await ask(C, B, 'From the attic')).status).toBe('waiting');
  });

  it('an older computer is listed as needing an update, and a create sent to it says so', async () => {
    old.add('Attic');
    down.add('Studio');
    const hosts = await as(A, () => A.remote!.groupProjectRemoteCreate.listHosts());
    expect(hosts).toEqual([
      { machine: null, name: 'This computer', state: 'online' },
      expect.objectContaining({ machine: B.fp, state: 'offline' }),
      expect.objectContaining({ machine: C.fp, state: 'needs_update', reason: expect.stringContaining('needs a Clubhouse update') }),
    ]);
    expect(await ask(A, C, 'Old')).toMatchObject({ status: 'unsupported', reason: expect.stringContaining('update') });
    expect(await hosted(C)).toEqual([]);
  });

  it('three desktops: one asks another to host, the third gets the copy, and the asker can\'t see its own approval', async () => {
    expect((await as(A, () => A.remote!.groupProjectRemoteCreate.listHosts())).map((h) => [h.name, h.state])).toEqual([
      ['This computer', 'online'], ['Studio', 'online'], ['Attic', 'online'],
    ]);
    const asked = await ask(A, B, 'Shared');
    const [request] = await waitingOn(B);
    const { grantRowVisibleTo } = await import('./mobile-grant-requests');
    const row = { kind: request.kind, actions: request.actions, arguments: request.argumentsText ?? null, toolName: request.toolName };
    expect(grantRowVisibleTo(row, A.fp)).toBe(false);
    expect(grantRowVisibleTo(row, C.fp)).toBe(true);
    await answer(B, request.requestId, true);
    const done = await retry(A, B, asked.requestId);
    expect(done.status).toBe('created');
    const id = (done as { groupProjectId: string }).groupProjectId;
    await as(C, () => C.host!.groupProjectHost.syncFrom(B.fp));
    expect(await as(C, () => C.host!.groupProjectHost.get(id))).toMatchObject({ name: 'Shared', hostName: 'Studio', network: { role: 'replica' } });
    expect(await as(A, () => A.host!.groupProjectHost.get(id))).toMatchObject({ hostName: 'Studio' });
    // Each computer's answers are its own: C asking with A's id is a new request.
    const fromC = await as(C, () => createLinkFor(C).post(B.fp, GROUP_PROJECT_CREATE_PATH, {
      v: 1, requestId: asked.requestId, name: 'Shared', scope: { level: 'app' }, membership: { autoJoin: false, includeLinkedComputers: false, excluded: [] },
    }));
    expect(fromC.body).toMatchObject({ status: 'waiting' });
  });

  it('existing groups are left alone', async () => {
    const existing = await as(B, () => B.host!.groupProjectHost.create('Already here', { scope: { level: 'app', reach: 'network' } }));
    const before = await as(B, () => B.host!.groupProjectHost.get(existing.id));
    const asked = await ask(A, B, 'New one');
    const [request] = await waitingOn(B);
    await answer(B, request.requestId, true);
    await retry(A, B, asked.requestId);
    expect(await as(B, () => B.host!.groupProjectHost.get(existing.id))).toEqual(before);
  });
});
