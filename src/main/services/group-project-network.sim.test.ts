/**
 * Network group projects (#3363), two desktops in one process: each machine
 * runs its own copy of the host service, registry and board, with its own home
 * folder and identity, and requests between them go through JSON and the same
 * validators the wire uses. A test can take either machine offline.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { readSyncResponse, readWriteRequest, readWriteResponse, readSyncRequest } from '../../shared/group-project-network';
import { postLegacyGroupMessage } from './group-project-legacy-message';
import type { GroupProjectNetworkRefusal } from '../../shared/group-project-types';

interface Machine {
  name: string;
  fp: string;
  home: string;
  projects?: Array<{ id: string; name: string; path: string; key: string; agents: Array<{ id: string; name: string }> }>;
  receipts?: typeof import('./group-project-notification-store');
  origins?: typeof import('./group-project-local-origin');
  host?: typeof import('./group-project-host');
  roles?: typeof import('./group-project-roles');
  gate?: typeof import('./group-project-remote-grants');
  registry?: typeof import('./group-project-registry');
  bulletin?: typeof import('./group-project-bulletin');
  membership?: typeof import('./group-project-membership');
  delivery?: typeof import('./group-project-delivery');
  persisted?: typeof import('./persisted-bindings');
  bindings?: typeof import('./clubhouse-mcp/binding-manager');
}

const world = vi.hoisted(() => ({
  als: null as unknown as AsyncLocalStorage<{ home: string; fp: string; projects?: Array<{ id: string; name: string; path: string; key: string; agents: Array<{ id: string; name: string }> }> }>,
  fallbackHome: '',
  links: [] as Array<Array<{ machine: string; projectId: string }>>,
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
const A: Machine = { name: 'Desk', fp: fp('aa'), home: '' };
const B: Machine = { name: 'Studio', fp: fp('bb'), home: '' };
const machines = [A, B];
const byFp = (f: string) => machines.find((m) => m.fp === f.toLowerCase())!;
const down = new Set<string>();
const refusals: Array<{ on: string; refusal: GroupProjectNetworkRefusal }> = [];

/** Run as a machine: its home, its identity, its modules. */
function as<T>(m: Machine, fn: (host: Machine['host'] & object) => Promise<T>): Promise<T> {
  return world.als.run({ home: m.home, fp: m.fp, projects: m.projects }, () => fn(m.host!));
}

const wire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

function linkFor(self: Machine) {
  return {
    connected: (machine: string) => !down.has(byFp(machine).name) && !down.has(self.name),
    isMember: (machine: string) => machines.some((m) => m.fp === machine.toLowerCase()),
    machineName: (machine: string) => byFp(machine).name,
    sync: async (machine: string, request: unknown) => {
      if (!linkFor(self).connected(machine)) throw new Error('Satellite not connected');
      const other = byFp(machine);
      const body = await as(other, (h) => h.groupProjectHost.networkSnapshot(readSyncRequest(wire(request))));
      return readSyncResponse(wire(body), other.fp);
    },
    sendWrites: async (machine: string, writes: unknown[]) => {
      if (!linkFor(self).connected(machine)) throw new Error('Satellite not connected');
      const other = byFp(machine);
      const body = await as(other, (h) => h.groupProjectHost.applyRemoteWrites(self.fp, readWriteRequest(wire({ v: 1, writes }))));
      return readWriteResponse(wire(body));
    },
    notifyRefusal: (refusal: GroupProjectNetworkRefusal) => { refusals.push({ on: self.name, refusal }); },
  };
}

beforeEach(async () => {
  world.als = new AsyncLocalStorage();
  const cache = path.join(process.cwd(), 'node_modules', '.cache');
  await fsp.mkdir(cache, { recursive: true });
  world.fallbackHome = await fsp.mkdtemp(path.join(cache, 'gp-net-none-'));
  down.clear(); world.links = [];
  refusals.length = 0;
  A.projects = [{ id: 'proj_a', name: 'App', path: '/a/app', key: 'github.com/org/app', agents: [{ id: 'lead', name: 'lead' }] }];
  B.projects = [
    { id: 'proj_b', name: 'App', path: '/b/app', key: 'github.com/org/app', agents: [{ id: 'builder', name: 'builder' }] },
    { id: 'proj_c', name: 'Other', path: '/b/other', key: 'github.com/org/other', agents: [{ id: 'stranger', name: 'stranger' }] },
  ];
  for (const m of machines) {
    m.home = await fsp.mkdtemp(path.join(cache, `gp-net-${m.name}-`));
    vi.resetModules();
    m.host = await import('./group-project-host');
    m.origins = await import('./group-project-local-origin');
    m.registry = await import('./group-project-registry');
    m.bulletin = await import('./group-project-bulletin');
    m.membership = await import('./group-project-membership');
    m.delivery = await import('./group-project-delivery');
    m.receipts = await import('./group-project-notification-store');
    m.persisted = await import('./persisted-bindings');
    m.bindings = await import('./clubhouse-mcp/binding-manager');
    m.roles = await import('./group-project-roles');
    m.gate = await import('./group-project-remote-grants');
    m.host.groupProjectHost.setNetworkLink(linkFor(m));
  }
});

afterEach(async () => {
  for (const m of machines) {
    await as(m, async (h) => { await h.groupProjectHost.flushRegistry(); await h.groupProjectHost.flushBoards(); });
    m.host!.groupProjectHost._resetForTesting();
    m.registry!.groupProjectRegistry._resetForTesting();
    m.membership!._resetMembershipForTesting();
    m.delivery!._resetDeliveryForTesting();
    m.persisted!._resetPersistedBindingSourcesForTesting();
    m.bindings!.bindingManager._resetForTesting();
    await fsp.rm(m.home, { recursive: true, force: true });
  }
  await fsp.rm(world.fallbackHome, { recursive: true, force: true });
});

const network = { scope: { level: 'app', reach: 'network' } } as const;

async function sharedProject(): Promise<string> {
  const project = await as(A, (h) => h.groupProjectHost.create('Launch', network));
  await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
  return project.id;
}

describe('network group projects across two desktops (#3363)', () => {
  it('delivers a host post to a distinct-name running replica member subscribed to its inbox', async () => {
    const id = await sharedProject();
    const address = `builder@${B.fp}`;
    await as(A, async h => {
      await h.groupProjectHost.updateMembership(id, d => {
        d.explicit.push({ address, kind: 'durable', name: 'builder', addedAt: 'x' });
        d.subscriptions = { [address]: { add: ['inbox-builder'], remove: [] } };
      });
      await h.groupProjectHost.ensureInbox(id, 'builder', address);
    });
    await as(B, h => h.groupProjectHost.syncFrom(A.fp));
    const sendMessage = vi.fn(async () => ({ delivery: 'prompt' as const }));
    await as(B, async () => {
      const { registerChatRuntime } = await import('./agent-runtime');
      const { agentRegistry } = await import('./agent-registry');
      const { isAgentAlive } = await import('./group-project-lifecycle');
      agentRegistry.register('builder', { projectPath: '/b/app', orchestrator: 'claude-code', runtime: 'chat' });
      registerChatRuntime({ agentId: 'builder', kind: 'chat', isRunning: () => true, getState: () => 'idle', sendMessage } as unknown as import('../../shared/chat').AgentRuntime);
      expect(isAgentAlive('builder')).toBe(true);
      B.membership!.watchGroupProjectMembership();
      B.delivery!.watchGroupProjectDelivery();
    });
    await as(A, h => h.groupProjectHost.post(id, 'lead@Launch', 'inbox-builder', 'hello from the host'));
    // A changed notice causes syncFrom on the receiving computer; exercise its complete apply/event/delivery path.
    await as(B, h => h.groupProjectHost.syncFrom(A.fp));
    await as(B, async h => {
      expect(await h.groupProjectHost.get(id)).toBeTruthy();
      const membership = await h.groupProjectHost.getMembership(id);
      const inbox = await h.groupProjectHost.inboxFor(id, 'builder', address);
      expect(B.delivery!.memberSubscriptions(membership, address, inbox).has('inbox-builder')).toBe(true);
      expect(await h.groupProjectHost.readTopic(id, 'inbox-builder')).toEqual(expect.arrayContaining([expect.objectContaining({ body: 'hello from the host' })]));
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1), { timeout: B.delivery!.COALESCE_MS + 1500 });
    });
  }, 25_000);

  it('a copy appears on the other computer, named by its host, and its posts reach the host and back', async () => {
    const id = await sharedProject();
    const copy = await as(B, (h) => h.groupProjectHost.get(id));
    expect(copy).toMatchObject({ name: 'Launch', hostName: 'Desk', host: { machine: A.fp }, network: { role: 'replica', state: 'online', waitingWrites: 0 } });
    expect(await as(A, (h) => h.groupProjectHost.get(id))).toMatchObject({ hostName: 'This computer', network: { role: 'host' } });

    // An agent on the non-host computer, a member, posts: the host applies it, and every member computer shows it.
    await as(B, (h) => h.groupProjectHost.updateMembership(id, (m) => {
      m.explicit.push({ address: `agent_b@${B.fp}`, kind: 'durable', addedAt: '2026-11-13T00:00:00.000Z' });
    }));
    const posted = await as(B, (h) => h.groupProjectHost.post(id, 'builder@Studio', 'work', 'from the studio', { author: { agentId: 'agent_b', label: 'builder@Studio' }, urgent: true }));
    expect(posted.urgent).toBe(true);
    expect((await as(B, (h) => h.groupProjectHost.readTopic(id, 'work')))[0].urgent).toBe(true);
    expect(posted.senderAddress).toBe(`agent_b@${B.fp}`);
    expect(posted.pending).toBeUndefined();
    expect(posted.seq).toBeGreaterThan(1);
    expect((await as(B, (h) => h.groupProjectHost.readTopic(id, 'work')))[0].senderAddress).toBe(`agent_b@${B.fp}`);
    expect((await as(A, (h) => h.groupProjectHost.readTopic(id, 'work'))).map((m) => m.body)).toEqual(['from the studio']);
    expect((await as(B, (h) => h.groupProjectHost.readTopic(id, 'work'))).map((m) => m.body)).toEqual(['from the studio']);
  });

  it('with the host off, reads come from the copy and writes queue; when it returns they are applied in order', async () => {
    const id = await sharedProject();
    await as(A, (h) => h.groupProjectHost.post(id, 'lead@Desk', 'work', 'before'));
    await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
    down.add('Desk');

    expect((await as(B, (h) => h.groupProjectHost.readTopic(id, 'work'))).map((m) => m.body)).toEqual(['before']);
    const first = await as(B, (h) => h.groupProjectHost.post(id, 'user', 'work', 'one'));
    const second = await as(B, (h) => h.groupProjectHost.post(id, 'user', 'work', 'two'));
    expect(first.pending).toEqual({ waitingFor: 'Desk' });
    expect(second.pending).toEqual({ waitingFor: 'Desk' });
    expect(await as(B, (h) => h.groupProjectHost.get(id))).toMatchObject({ network: { state: 'cached', waitingWrites: 2 } });

    down.delete('Desk');
    await as(B, (h) => h.groupProjectHost.flushOutbox(A.fp));
    expect((await as(A, (h) => h.groupProjectHost.readTopic(id, 'work'))).map((m) => m.body)).toEqual(['before', 'one', 'two']);
    expect((await as(B, (h) => h.groupProjectHost.readTopic(id, 'work'))).map((m) => m.body)).toEqual(['before', 'one', 'two']);
    expect(await as(B, (h) => h.groupProjectHost.get(id))).toMatchObject({ network: { state: 'online', waitingWrites: 0 } });
  });

  it('a queued write the host refuses tells its author why, and the copy of a deleted group project goes', async () => {
    const id = await sharedProject();
    await as(B, (h) => h.groupProjectHost.updateMembership(id, (m) => {
      m.explicit.push({ address: `agent_b@${B.fp}`, kind: 'durable', addedAt: '2026-11-13T00:00:00.000Z' });
    }));
    down.add('Desk');
    await as(B, (h) => h.groupProjectHost.post(id, 'builder@Studio', 'work', 'too late', { author: { agentId: 'agent_b', label: 'builder@Studio' } }));
    await as(A, (h) => h.groupProjectHost.delete(id));
    down.delete('Desk');
    await as(B, (h) => h.groupProjectHost.flushOutbox(A.fp));
    expect(refusals).toEqual([{ on: 'Studio', refusal: expect.objectContaining({ groupProjectId: id, op: 'post', reason: expect.stringContaining('deleted'), author: { agentId: 'agent_b', label: 'builder@Studio' } }) }]);
    // A member that was offline during the delete purges its copy on reconnect (#3364).
    expect(await as(B, (h) => h.groupProjectHost.get(id))).toBeNull();
  });

  it('a write refused while the host is online is refused to the caller at once', async () => {
    const id = await sharedProject();
    await expect(as(B, (h) => h.groupProjectHost.post(id, 'user', 'system', 'nope'))).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('reserved') });
  });

  it('catches up from the last sequence number it saw, dropping what the host removed', async () => {
    const id = await sharedProject();
    const keep = await as(A, (h) => h.groupProjectHost.post(id, 'a', 'work', 'keep'));
    const drop = await as(A, (h) => h.groupProjectHost.post(id, 'a', 'work', 'drop'));
    await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
    down.add('Studio');
    await as(A, (h) => h.groupProjectHost.deleteMessage(id, 'work', drop.id));
    await as(A, (h) => h.groupProjectHost.post(id, 'a', 'work', 'new'));
    await as(A, (h) => h.groupProjectHost.update(id, { description: 'renamed while away' }));
    down.delete('Studio');
    await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
    expect((await as(B, (h) => h.groupProjectHost.readTopic(id, 'work'))).map((m) => m.id)).toEqual(
      (await as(A, (h) => h.groupProjectHost.readTopic(id, 'work'))).map((m) => m.id),
    );
    expect((await as(B, (h) => h.groupProjectHost.readTopic(id, 'work'))).map((m) => m.body)).toEqual(['keep', 'new']);
    expect(keep.id).toBeTruthy();
    expect(await as(B, (h) => h.groupProjectHost.get(id))).toMatchObject({ description: 'renamed while away', seq: (await as(A, (h) => h.groupProjectHost.get(id)))!.seq });
  });

  it('unread counts match on both computers for the same read markers (#1559)', async () => {
    const id = await sharedProject();
    await as(A, (h) => h.groupProjectHost.post(id, 'a', 'work', 'one'));
    const marker = (await as(A, (h) => h.groupProjectHost.readTopic(id, 'work')))[0].timestamp;
    await new Promise((r) => setTimeout(r, 5));
    await as(A, (h) => h.groupProjectHost.post(id, 'a', 'work', 'two'));
    await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
    const since = { work: marker };
    const counts = async (m: Machine) => Object.fromEntries((await as(m, (h) => h.groupProjectHost.readDigest(id, since))).map((d) => [d.topic, d.newMessageCount]));
    expect(await counts(B)).toEqual(await counts(A));
    expect((await counts(B)).work).toBe(1);
  });

  it('membership changes on a copy are applied by the host to its own record', async () => {
    const id = await sharedProject();
    await as(B, (h) => h.groupProjectHost.updateMembership(id, (m) => {
      m.explicit.push({ address: `agent_b@${B.fp}`, kind: 'durable', addedAt: '2026-11-13T00:00:00.000Z', name: 'builder' });
    }));
    expect((await as(A, (h) => h.groupProjectHost.getMembership(id))).explicit.map((e) => e.address)).toEqual([`agent_b@${B.fp}`]);
    expect((await as(B, (h) => h.groupProjectHost.getMembership(id))).explicit.map((e) => e.address)).toEqual([`agent_b@${B.fp}`]);
    // A copy names this computer's agents with its machine, and the host's agents bare.
    const copy = (await as(B, (h) => h.groupProjectHost.get(id)))!;
    await expect(as(B, async (h) => [h.groupProjectHost.localAgentId(copy, `agent_b@${B.fp}`), h.groupProjectHost.localAgentId(copy, 'lead')])).resolves.toEqual(['agent_b', null]);
  });

  it('an MCP membership edit carries its agent author and cannot use the housekeeping exemption', async () => {
    const id = await sharedProject();
    await as(A, (h) => h.groupProjectHost.updateMembership(id, (draft) => {
      draft.explicit.push({ address: `builder@${B.fp}`, kind: 'durable', addedAt: 'x' });
    }));
    await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
    const checks: Array<{ address: string; action: string }> = [];
    A.host!.groupProjectHost.setRemoteWriteGate((check) => {
      checks.push({ address: check.address, action: check.action });
      return 'Host admin is off';
    });
    await expect(as(B, () => B.membership!.excludeMember(id, 'builder', { author: { agentId: 'builder', label: 'Builder' } })))
      .rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('Host admin is off') });
    expect(checks).toEqual([{ address: `builder@${B.fp}`, action: 'group_project.admin' }]);
    expect((await as(A, (h) => h.groupProjectHost.getMembership(id))).excluded).toEqual([]);
    A.host!.groupProjectHost.setRemoteWriteGate(() => undefined);
    await as(B, () => B.membership!.excludeMember(id, 'builder', { author: { agentId: 'builder', label: 'Builder' } }));
    expect((await as(A, (h) => h.groupProjectHost.getMembership(id))).excluded.map((e) => e.address)).toContain(`builder@${B.fp}`);
  });

  it('removing the host leaves a read-only copy with a message', async () => {
    const id = await sharedProject();
    await as(A, (h) => h.groupProjectHost.post(id, 'a', 'work', 'kept'));
    await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
    down.add('Desk');
    await as(B, (h) => h.groupProjectHost.post(id, 'user', 'work', 'waiting'));
    await as(B, (h) => h.groupProjectHost.machineRemoved(A.fp));
    expect(await as(B, (h) => h.groupProjectHost.get(id))).toMatchObject({ network: { state: 'host-removed', waitingWrites: 0 } });
    expect((await as(B, (h) => h.groupProjectHost.readTopic(id, 'work'))).map((m) => m.body)).toEqual(['kept']);
    await expect(as(B, (h) => h.groupProjectHost.post(id, 'user', 'work', 'no'))).rejects.toMatchObject({ code: 'read_only', message: expect.stringContaining('Desk left your network') });
    expect(refusals.map((r) => r.refusal.reason)).toEqual([expect.stringContaining('left your network')]);
  });

  it('only the host deletes, clears or rescopes; a copy says who can', async () => {
    const id = await sharedProject();
    await expect(as(B, (h) => h.groupProjectHost.delete(id))).rejects.toMatchObject({ code: 'not_host', message: 'Only Desk can delete this group project.' });
    await expect(as(B, (h) => h.groupProjectHost.clearAll(id))).rejects.toMatchObject({ code: 'not_host' });
    await expect(as(B, (h) => h.groupProjectHost.setScope(id, { level: 'app', reach: 'local' }))).rejects.toMatchObject({ code: 'not_host' });
  });

  it('narrowing the host to this computer stops sharing: the copy goes', async () => {
    const id = await sharedProject();
    await as(A, (h) => h.groupProjectHost.setScope(id, { level: 'app', reach: 'local' }));
    await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
    expect(await as(B, (h) => h.groupProjectHost.get(id))).toBeNull();
  });

  it('an existing project group keeps repository coverage unchanged', async () => {
    const project = await as(A, (h) => h.groupProjectHost.create('App team', { scope: { level: 'project', projectId: 'proj_a', reach: 'network' } }));
    await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
    // A pre-3546 record keeps its exact previous behaviour.
    await as(A, (h) => h.groupProjectHost.updateMembership(project.id, (m) => { delete m.membershipPolicy; delete m.includeLinkedComputers; }));
    await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
    expect(await as(B, (h) => h.groupProjectHost.get(project.id))).toMatchObject({ scopeProjectKey: 'github.com/org/app' });
    expect(await as(B, (h) => h.groupProjectHost.inScope(project.id, 'builder'))).toBe(true);
    expect(await as(B, (h) => h.groupProjectHost.inScope(project.id, 'stranger'))).toBe(false);
    expect(await as(B, (h) => h.groupProjectHost.admits(project.id, 'builder'))).toBe(true);
    expect(await as(B, (h) => h.groupProjectHost.admits(project.id, 'stranger'))).toBe(false);
  });

  it('new project groups require explicit links on both host and replica, then keep joining future agents', async () => {
    const project = await as(A, (h) => h.groupProjectHost.create('Linked team', { projectId: 'proj_a', scope: { level: 'project', projectId: 'proj_a', reach: 'network' } }));
    await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
    expect(await as(B, (h) => h.groupProjectHost.inScope(project.id, 'builder'))).toBe(false);
    world.links = [[{ machine: A.fp, projectId: 'proj_a' }, { machine: B.fp, projectId: 'proj_b' }]];
    expect(await as(B, (h) => h.groupProjectHost.inScope(project.id, 'builder'))).toBe(true);
    expect(await as(B, (h) => h.groupProjectHost.inScope(project.id, 'stranger'))).toBe(false);
    for (const m of machines) await as(m, async () => {
      m.persisted!.registerPersistedBindingSource(m.membership!.membershipBindingSource);
      await m.persisted!.rebuildPersistedBindings();
    });
    await as(A, () => A.membership!.reconcileMembership());
    await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
    await as(B, () => B.membership!.reconcileMembership());
    expect(await as(B, async () => B.bindings!.bindingManager.getBindingsForAgent('builder').map((b) => b.targetId))).toContain(project.id);
    B.projects![0].agents.push({ id: 'later', name: 'Later' });
    await as(A, () => A.membership!.reconcileMembership());
    await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
    await as(B, () => B.membership!.reconcileMembership());
    expect(await as(B, async () => B.bindings!.bindingManager.getBindingsForAgent('later').map((b) => b.targetId))).toContain(project.id);
    await expect(as(B, () => B.membership!.setAutomaticMembership(project.id, { autoJoin: false, includeLinkedComputers: false }))).rejects.toMatchObject({ code: 'not_host' });
    await expect(as(B, (h) => h.groupProjectHost.updateMembership(project.id, (m) => { m.autoJoin = false; }))).rejects.toMatchObject({ code: 'not_host', message: expect.stringContaining('Only the host') });
    const attempted = await as(A, (h) => h.groupProjectHost.applyRemoteWrites(B.fp, readWriteRequest(wire({ v: 1, writes: [{
      id: 'replica-policy', groupProjectId: project.id, queuedAt: new Date().toISOString(), author: { label: 'user' },
      write: { op: 'membership', patch: { addExplicit: [], removeExplicit: [], addExcluded: [], removeExcluded: [], set: { autoJoin: false } } },
    }] }))));
    expect(attempted.results[0]).toMatchObject({ status: 'refused', reason: expect.stringContaining('Only the host') });
    expect((await as(A, (h) => h.groupProjectHost.getMembership(project.id))).autoJoin).toBe(true);
    await as(B, () => B.membership!.excludeMember(project.id, 'builder'));
    await as(B, () => B.membership!.addMember(project.id, 'builder'));
    const includedAgain = (await as(A, (h) => h.groupProjectHost.getMembership(project.id))).explicit.find((entry) => entry.address === `builder@${B.fp}`);
    expect(includedAgain?.autoProject).toEqual({ machine: B.fp, projectId: 'proj_b' });

  });

  describe('the host decides who may write (#3446 review)', () => {
    const writeAs = (id: string, author: { agentId?: string; label: string }, write: unknown, writeId = `w-${Math.random()}`) =>
      as(A, (h) => h.groupProjectHost.applyRemoteWrites(B.fp, readWriteRequest(wire({ v: 1, writes: [{ id: writeId, groupProjectId: id, queuedAt: '2026-11-13T00:00:00.000Z', author, write }] }))));

    // Identity comes from the authenticated sending computer: an agent author may be bare or
    // qualified with that computer, never with another one (#3664). A forged senderAddress is
    // always discarded and rebuilt from the authenticated machine (#3666).
    it.each([['bare', 'member'], ['qualified with the sending computer', 'member@B']])('applies a valid %s author, discarding a forged senderAddress for the authenticated machine', async (_label, claimed) => {
      const id = await sharedProject();
      await as(A, h => h.groupProjectHost.updateMembership(id, d => {
        d.explicit.push({ address: `member@${B.fp}`, kind: 'durable', addedAt: 'x' });
      }));
      const agentId = claimed === 'member@B' ? `member@${B.fp}` : claimed;
      const response = await writeAs(id, { agentId, label: 'Member' }, {
        op: 'post', sender: 'Member', senderAddress: 'host-victim', topic: 'work', body: 'legitimate',
      });
      expect(response.results[0].status).toBe('applied');
      expect((await as(A, h => h.groupProjectHost.readTopic(id, 'work')))[0].senderAddress).toBe(`member@${B.fp}`);
      await as(B, h => h.groupProjectHost.syncFrom(A.fp));
      expect((await as(B, h => h.groupProjectHost.readTopic(id, 'work')))[0].senderAddress).toBe(`member@${B.fp}`);
    });

    it('refuses an author claiming another computer, even when the authenticated computer has a member of that name', async () => {
      const id = await sharedProject();
      await as(A, h => h.groupProjectHost.updateMembership(id, d => {
        d.explicit.push({ address: `member@${B.fp}`, kind: 'durable', addedAt: 'x' });
      }));
      // B claims to write as the host's agent. Before #3664 this was silently rebound to member@B;
      // now a claim that contradicts the authenticated identity fails closed and nothing is written.
      const response = await writeAs(id, { agentId: `member@${A.fp}`, label: 'Victim' }, {
        op: 'post', sender: 'Victim', senderAddress: 'host-victim', topic: 'work', body: 'forged',
      });
      expect(response.results[0]).toMatchObject({ status: 'refused', reason: expect.stringContaining('authenticated computer') });
      expect(await as(A, h => h.groupProjectHost.readTopic(id, 'work'))).toEqual([]);
    });

    it('refuses a forged other-machine member when the authenticated sending machine has no such member', async () => {
      const id = await sharedProject();
      await as(A, h => h.groupProjectHost.updateMembership(id, d => {
        d.explicit.push({ address: 'host-victim', kind: 'durable', addedAt: 'x' });
      }));
      const response = await writeAs(id, { agentId: `host-victim@${A.fp}`, label: 'Victim' }, {
        op: 'post', sender: 'Victim', topic: 'work', body: 'must refuse',
      });
      expect(response.results[0]).toMatchObject({ status: 'refused' });
      expect(await as(A, h => h.groupProjectHost.readTopic(id, 'work'))).toEqual([]);
    });

    it('refuses an agent that is not a member, and lead or admin changes without a grant (fails closed)', async () => {
      const id = await sharedProject();
      expect((await writeAs(id, { agentId: 'outsider', label: 'o' }, { op: 'post', sender: 'o', topic: 'work', body: 'hi' })).results[0])
        .toMatchObject({ status: 'refused', reason: expect.stringContaining('member') });
      expect((await writeAs(id, { agentId: 'outsider', label: 'o' }, { op: 'update', fields: { name: 'Renamed by an outsider' } })).results[0].status).toBe('refused');
      await as(A, (h) => h.groupProjectHost.updateMembership(id, (m) => { m.explicit.push({ address: `member@${B.fp}`, kind: 'durable', addedAt: 'x' }); }));
      expect((await writeAs(id, { agentId: 'member', label: 'm' }, { op: 'post', sender: 'm', topic: 'work', body: 'hi' })).results[0].status).toBe('applied');
      expect((await writeAs(id, { agentId: 'member', label: 'm' }, { op: 'update', fields: { name: 'Renamed' } })).results[0])
        .toMatchObject({ status: 'refused', reason: expect.stringContaining('grant') });
      expect((await as(A, (h) => h.groupProjectHost.get(id)))!.name).toBe('Launch');
    });

    it('checks an exclusion before the explicit-entry authorization fallback', async () => {
      const id = await sharedProject();
      await as(A, (h) => h.groupProjectHost.updateMembership(id, (membership) => {
        membership.explicit.push({ address: `member@${B.fp}`, kind: 'durable', addedAt: 'x' });
        membership.excluded.push({ address: `member@${B.fp}`, excludedAt: 'x' });
      }));
      expect((await writeAs(id, { agentId: 'member', label: 'Member' }, { op: 'post', sender: 'Member', topic: 'work', body: 'excluded' })).results[0])
        .toMatchObject({ status: 'refused', reason: expect.stringContaining('member') });
    });

    it('asks the registered grant check for an agent\'s change, with its address and the action', async () => {
      const id = await sharedProject();
      const checks: unknown[] = [];
      A.host!.groupProjectHost.setRemoteWriteGate((check) => { checks.push({ address: check.address, action: check.action, isMember: check.isMember }); return undefined; });
      expect((await writeAs(id, { agentId: 'lead', label: 'l' }, { op: 'update', fields: { description: 'by a granted lead' } })).results[0].status).toBe('applied');
      expect(checks).toEqual([{ address: `lead@${B.fp}`, action: 'group_project.admin', isMember: false }]);
    });

    it('rejects a forged author machine before consulting the grant gate', async () => {
      const id = await sharedProject();
      const checks: Array<{ address: string; machine: string }> = [];
      A.host!.groupProjectHost.setRemoteWriteGate((check) => {
        checks.push({ address: check.address, machine: check.machine });
        return check.address === 'lead' ? undefined : 'No admin grant for this authenticated computer';
      });
      const answer = await writeAs(id, { agentId: `lead@${A.fp}`, label: 'user' }, { op: 'update', fields: { name: 'Spoofed host lead' } });
      expect(answer.results[0]).toMatchObject({ status: 'refused', reason: expect.stringContaining('authenticated computer') });
      expect(checks).toEqual([]);
      expect((await as(A, (h) => h.groupProjectHost.get(id)))!.name).toBe('Launch');
    });

    it('limits a computer\'s own housekeeping to its own agents', async () => {
      const id = await sharedProject();
      await writeAs(id, { label: 'membership' }, { op: 'membership', patch: {
        addExplicit: [{ address: `mine@${B.fp}`, kind: 'durable', addedAt: 'x' }, { address: 'host-agent', kind: 'durable', addedAt: 'x' }],
        removeExplicit: [], addExcluded: [{ address: 'lead', excludedAt: 'x' }], removeExcluded: [], set: { autoJoin: true },
      } });
      const membership = await as(A, (h) => h.groupProjectHost.getMembership(id));
      expect(membership.explicit.map((e) => e.address)).toEqual([`mine@${B.fp}`]);
      expect(membership.excluded).toEqual([]);
      expect(membership.autoJoin).toBe(false);
      expect((await writeAs(id, { label: 'membership' }, { op: 'update', fields: { name: 'x' } })).results[0].status).toBe('refused');
    });

    it('answers a replayed write as the first time, without posting twice', async () => {
      const id = await sharedProject();
      const first = await writeAs(id, { label: 'user' }, { op: 'post', sender: 'user', topic: 'work', body: 'once' }, 'same-write');
      const again = await writeAs(id, { label: 'user' }, { op: 'post', sender: 'user', topic: 'work', body: 'once' }, 'same-write');
      expect(again).toEqual(first);
      expect((await as(A, (h) => h.groupProjectHost.readTopic(id, 'work'))).map((m) => m.body)).toEqual(['once']);
      // Even after the saved answers are lost (a crash after the post), the post is found by its id.
      A.host!.groupProjectHost._resetForTesting();
      A.host!.groupProjectHost.setNetworkLink(linkFor(A));
      await fsp.rm(path.join(A.home, '.clubhouse-dev', 'group-projects', 'network-applied.json'), { force: true });
      await writeAs(id, { label: 'user' }, { op: 'post', sender: 'user', topic: 'work', body: 'once' }, 'same-write');
      expect((await as(A, (h) => h.groupProjectHost.readTopic(id, 'work'))).map((m) => m.body)).toEqual(['once']);
    });
  });

  describe('a remote write is durable before it is answered (#3446 re-review)', () => {
    const write = (id: string) => ({ v: 1, writes: [{ id: 'durable-1', groupProjectId: id, queuedAt: '2026-11-13T00:00:00.000Z', author: { label: 'user' }, write: { op: 'post', sender: 'user', topic: 'work', body: 'kept' } }] });
    /** The host stops: everything in memory is lost, the files stay. */
    const crashHost = () => {
      A.host!.groupProjectHost._resetForTesting();
      A.bulletin!._resetAllBoardsForTesting();
      A.registry!.groupProjectRegistry._resetForTesting();
      A.host!.groupProjectHost.setNetworkLink(linkFor(A));
    };
    const failRenameOf = (name: string) => {
      const rename = fs.promises.rename;
      return vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (String(to).startsWith(A.home) && path.basename(String(to)) === name) throw new Error('power cut');
        await rename(from, to);
      });
    };

    it('crashing before the board is on disk answers nothing; the resend posts it once', async () => {
      const id = await sharedProject();
      const spy = failRenameOf('bulletin.json');
      await expect(as(A, (h) => h.groupProjectHost.applyRemoteWrites(B.fp, readWriteRequest(wire(write(id)))))).rejects.toThrow('power cut');
      spy.mockRestore();
      crashHost();
      const resent = await as(A, (h) => h.groupProjectHost.applyRemoteWrites(B.fp, readWriteRequest(wire(write(id)))));
      expect(resent.results[0].status).toBe('applied');
      crashHost();
      expect((await as(A, (h) => h.groupProjectHost.readTopic(id, 'work'))).map((m) => m.body)).toEqual(['kept']);
    });

    it('crashing after the board is on disk but before the answer is saved: the resend finds the post', async () => {
      const id = await sharedProject();
      const spy = failRenameOf('network-applied.json');
      await expect(as(A, (h) => h.groupProjectHost.applyRemoteWrites(B.fp, readWriteRequest(wire(write(id)))))).rejects.toThrow('power cut');
      spy.mockRestore();
      crashHost();
      const resent = await as(A, (h) => h.groupProjectHost.applyRemoteWrites(B.fp, readWriteRequest(wire(write(id)))));
      expect(resent.results[0].status).toBe('applied');
      crashHost();
      expect((await as(A, (h) => h.groupProjectHost.readTopic(id, 'work'))).map((m) => m.body)).toEqual(['kept']);
    });
  });

  describe('copies stay consistent (#3446 review)', () => {
    it('keeps every write made at once while the host is away', async () => {
      const id = await sharedProject();
      down.add('Desk');
      await Promise.all(['a', 'b', 'c', 'd'].map((body) => as(B, (h) => h.groupProjectHost.post(id, 'user', 'work', body))));
      expect(await as(B, (h) => h.groupProjectHost.get(id))).toMatchObject({ network: { waitingWrites: 4 } });
      down.delete('Desk');
      await as(B, (h) => h.groupProjectHost.flushOutbox(A.fp));
      expect((await as(A, (h) => h.groupProjectHost.readTopic(id, 'work'))).map((m) => m.body).sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('a late answer from before a delete does not bring the copy back', async () => {
      const id = await sharedProject();
      const stale = await as(A, (h) => h.groupProjectHost.networkSnapshot({ v: 1, known: {} }));
      await as(A, (h) => h.groupProjectHost.delete(id));
      await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
      expect(await as(B, (h) => h.groupProjectHost.get(id))).toBeNull();
      // The stale answer arrives now.
      const link = linkFor(B);
      B.host!.groupProjectHost.setNetworkLink({ ...link, sync: async () => readSyncResponse(wire(stale), A.fp) });
      await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
      expect(await as(B, (h) => h.groupProjectHost.get(id))).toBeNull();
      B.host!.groupProjectHost.setNetworkLink(link);
    });
  });

  describe('a member\'s own tool switches and instructions are keyed by address (#3516)', () => {
    const POLICY = {
      lead: { tools: ['clear_topic'], instructions: { reviewer: 'host agent rule' } },
      builder: { tools: ['wake_agent'], instructions: { designer: 'copy agent rule' } },
    };

    /** The host's record: its own agent bare, the other computer's with its machine; both with switches and instructions. */
    async function policyProject(): Promise<string> {
      const id = await sharedProject();
      await as(A, (h) => h.groupProjectHost.updateMembership(id, (m) => {
        m.autoJoin = false;
        m.autoJoinOffer = 'dismissed';
        m.explicit.push(
          { address: 'lead', kind: 'durable', addedAt: '2026-11-13T00:00:00.000Z' },
          { address: `builder@${B.fp}`, kind: 'durable', addedAt: '2026-11-13T00:00:00.000Z' },
        );
        m.disabledTools = { lead: POLICY.lead.tools, [`builder@${B.fp}`]: POLICY.builder.tools };
        m.instructions = { lead: POLICY.lead.instructions, [`builder@${B.fp}`]: POLICY.builder.instructions };
      }));
      await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
      return id;
    }

    /** Bind from the record, as the app does at startup, and read the binding each of this machine's agents got. */
    async function bindingOf(m: Machine, agentId: string, id: string) {
      return as(m, async () => {
        m.persisted!.registerPersistedBindingSource(m.membership!.membershipBindingSource);
        await m.persisted!.rebuildPersistedBindings();
        await m.membership!.reconcileMembership();
        return m.bindings!.bindingManager.getBindingsForAgent(agentId).find((b) => b.targetId === id);
      });
    }

    it('a copy\'s own member gets the tool switches and instructions the host holds for its address', async () => {
      const id = await policyProject();
      const binding = await bindingOf(B, 'builder', id);
      expect(binding?.disabledTools).toEqual(POLICY.builder.tools);
      expect(binding?.instructions).toEqual(POLICY.builder.instructions);
    });

    it('the host\'s own member is unaffected, and the copy does not bind the host\'s agent', async () => {
      const id = await policyProject();
      const onHost = await bindingOf(A, 'lead', id);
      expect(onHost?.disabledTools).toEqual(POLICY.lead.tools);
      expect(onHost?.instructions).toEqual(POLICY.lead.instructions);
      // A bare id on the copy is the host's agent, never this computer's.
      expect(await as(B, async () => B.bindings!.bindingManager.getBindingsForAgent('lead'))).toEqual([]);
    });

    it('a switch saved on the copy lands under this computer\'s address on the host', async () => {
      const id = await policyProject();
      await bindingOf(B, 'builder', id);
      await as(B, () => B.membership!.recordMemberDisabledTools(id, 'builder', ['clear_topic']));
      const onHost = await as(A, (h) => h.groupProjectHost.getMembership(id));
      expect(onHost.disabledTools).toEqual({ lead: POLICY.lead.tools, [`builder@${B.fp}`]: ['clear_topic'] });
      await expect(as(B, () => B.membership!.savedMemberDisabledTools(id, 'builder'))).resolves.toEqual(['clear_topic']);
    });
    it('a subscription saved on the copy lands under this computer\'s address on the host and reads back', async () => {
      const id = await policyProject();
      await expect(as(B, () => B.delivery!.setTopicSubscription(id, 'builder', 'builder', 'releases', true))).resolves.toContain('releases');
      const onHost = await as(A, (h) => h.groupProjectHost.getMembership(id));
      expect(onHost.subscriptions).toEqual({ [`builder@${B.fp}`]: { add: ['releases'], remove: [] } });
      await expect(as(B, () => B.delivery!.listTopicSubscriptions(id, 'builder', 'builder'))).resolves.toContain('releases');
      // A host-side member keeps its bare key.
      await as(A, () => A.delivery!.setTopicSubscription(id, 'lead', 'lead', 'releases', true));
      expect(Object.keys((await as(A, (h) => h.groupProjectHost.getMembership(id))).subscriptions ?? {}).sort()).toEqual([`builder@${B.fp}`, 'lead']);
    });

    it('a switch queued before the fix with a bare id is applied under this computer\'s address, not dropped', async () => {
      const id = await policyProject();
      down.add('Desk');
      // What an older build queued: this computer's agent named by its bare id.
      await as(B, (h) => h.groupProjectHost.updateMembership(id, (m) => { m.disabledTools = { ...m.disabledTools, builder: ['clear_topic'] }; }));
      expect(await as(B, (h) => h.groupProjectHost.get(id))).toMatchObject({ network: { waitingWrites: 1 } });
      down.delete('Desk');
      await as(B, (h) => h.groupProjectHost.flushOutbox(A.fp));
      const onHost = await as(A, (h) => h.groupProjectHost.getMembership(id));
      // The host held ['wake_agent'] for it; the user's saved change wins.
      expect(onHost.disabledTools).toEqual({ lead: POLICY.lead.tools, [`builder@${B.fp}`]: ['clear_topic'] });
      expect(refusals).toEqual([]);
    });

    it('a bare id queued before the fix that is not one of this computer\'s agents is refused visibly, not dropped as applied', async () => {
      const id = await policyProject();
      down.add('Desk');
      await as(B, (h) => h.groupProjectHost.updateMembership(id, (m) => { m.disabledTools = { ...m.disabledTools, ghost: ['clear_topic'] }; }));
      down.delete('Desk');
      await as(B, (h) => h.groupProjectHost.flushOutbox(A.fp));
      expect((await as(A, (h) => h.groupProjectHost.getMembership(id))).disabledTools).toEqual({ lead: POLICY.lead.tools, [`builder@${B.fp}`]: POLICY.builder.tools });
      expect(refusals).toEqual([expect.objectContaining({ on: 'Studio', refusal: expect.objectContaining({ reason: expect.stringContaining('ghost') }) })]);
    });
  });
});

describe('author boundary (#3664)', () => {
  it('keeps per-write outcomes isolated across overlapping updates and never persists them', async () => {
    const id = await sharedProject();
    A.host!.groupProjectHost.setRemoteWriteGate(check =>
      check.write.write.op === 'update' && check.write.write.fields.name === 'Denied' ? 'denied' : undefined);
    down.add(A.name);
    const host = B.host!.groupProjectHost;
    const originalGet = host.get.bind(host);
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const readback = vi.spyOn(host, 'get').mockImplementationOnce(async projectId => {
      entered();
      await resume;
      return originalGet(projectId);
    });
    const first = as(B, h => h.groupProjectHost.update(id, { name: 'Denied' }, { author: { agentId: 'builder', label: 'user' } }));
    try {
      await reading;
      down.delete(A.name);
      await as(B, h => h.groupProjectHost.flushOutbox(A.fp));
      const second = await as(B, h => h.groupProjectHost.update(id, { name: 'Applied' }, { author: { agentId: 'builder', label: 'user' } }));
      release();
      const queued = await first;
      expect(queued).toMatchObject({ name: 'Applied', writeOutcome: { status: 'queued' } });
      expect(second).toMatchObject({ name: 'Applied', writeOutcome: { status: 'applied' } });
      expect(queued!.writeOutcome).not.toBe(second!.writeOutcome);
      for (const machine of [A, B]) {
        expect(await as(machine, h => h.groupProjectHost.get(id))).not.toHaveProperty('writeOutcome');
        expect(await as(machine, () => machine.registry!.groupProjectRegistry.get(id))).not.toHaveProperty('writeOutcome');
      }
    } finally {
      release();
      await first;
      readback.mockRestore();
    }
  });

  it.each(['deliver', 'wake', 'actions'] as const)('fails closed when the %s own-grant service omits its replica author', async grant => {
    const id = await sharedProject();
    await expect(as(B, () => B.roles!.setOwnGrant(id, grant, 'off'))).rejects.toMatchObject({ code: 'invalid' });
    expect((await as(A, h => h.groupProjectHost.get(id)))?.metadata?.grants).toBeUndefined();
  });


  it.each(['deliver', 'wake', 'actions'] as const)('preserves the person IPC path for the %s own grant on a replica', async grant => {
    const id = await sharedProject();
    // The fixed SET_OWN_GRANT IPC boundary passes its explicit person author.
    // The service itself must not assume that an omitted author means the person.
    const mode = grant === 'wake' ? 'allow' : 'off';
    await as(B, () => B.roles!.setOwnGrant(id, grant, mode, { author: { label: 'user' } }));
    expect((await as(A, h => h.groupProjectHost.get(id)))?.metadata?.grants).toMatchObject({ [grant]: mode });
  });


  it.each(['', 'builder@bad', `builder@${A.fp}`, `builder@${B.fp}@${B.fp}`])('rejects malformed or foreign author %s through the real network parser', async agentId => {
    const id = await sharedProject();
    const gate = vi.fn(() => undefined);
    A.host!.groupProjectHost.setRemoteWriteGate(gate);
    const request = readWriteRequest(wire({ v: 1, writes: [{
      id: 'malformed', groupProjectId: id, queuedAt: new Date().toISOString(),
      author: { agentId, label: 'user' }, write: { op: 'update', fields: { metadata: { legacyFlag: true } } },
    }] }));
    const result = await as(A, h => h.groupProjectHost.applyRemoteWrites(B.fp.toUpperCase(), request));
    expect(result.results[0].status).toBe('refused');
    expect(gate).not.toHaveBeenCalled();
    expect((await as(A, h => h.groupProjectHost.get(id)))?.metadata?.legacyFlag).not.toBe(true);
  });

  it('rejects a forged author machine and an anonymous legacy envelope', async () => {
    const id = await sharedProject();
    const gate = vi.fn(() => undefined);
    A.host!.groupProjectHost.setRemoteWriteGate(gate);
    for (const author of [{ agentId: `lead@${A.fp}`, label: 'user' }, { label: 'unknown' }, { agentId: '', label: 'user' }]) {
      const result = await as(A, h => h.groupProjectHost.applyRemoteWrites(B.fp, { v: 1, writes: [{
        id: `forge-${author.label}-${author.agentId}`, groupProjectId: id, queuedAt: new Date().toISOString(), author,
        write: { op: 'update', fields: { metadata: { legacyFlag: true } } },
      }] }));
      expect(result.results[0].status).toBe('refused');
    }
    expect(gate).not.toHaveBeenCalled();
    expect((await as(A, h => h.groupProjectHost.get(id)))?.metadata?.legacyFlag).not.toBe(true);
  });
});

describe('startup roles migration with a replica (#3664)', () => {
  it('does not let an unmarked replica prevent later local projects from migrating', async () => {
    const remoteId = await sharedProject();
    const local = await as(B, h => h.groupProjectHost.create('Legacy local'));
    await as(B, h => h.groupProjectHost.update(local.id, { metadata: { admins: ['builder'] } }));
    // The remote group was created since the host last ran startup migration.
    // Registry order puts its unmarked replica before the legacy local group.
    expect((await as(B, h => h.groupProjectHost.list())).map(gp => gp.id)).toEqual([remoteId, local.id]);
    expect((await as(B, h => h.groupProjectHost.get(remoteId)))!.metadata.rolesMigratedAt).toBeUndefined();

    const replicaBefore = structuredClone(await as(B, () => B.registry!.groupProjectRegistry.get(remoteId)));
    const hostBefore = structuredClone(await as(A, () => A.registry!.groupProjectRegistry.get(remoteId)));
    await expect(as(B, () => B.roles!.migrateGroupProjectRoles())).resolves.toBe(1);
    expect(B.roles!.roleModeOf('builder', local.id, 'lead')).toBe('allow');
    expect(B.roles!.roleModeOf('builder', local.id, 'admin')).toBe('allow');
    expect((await as(B, h => h.groupProjectHost.get(local.id)))!.metadata.rolesMigratedAt).toBeTruthy();
    expect(await as(B, () => B.registry!.groupProjectRegistry.get(remoteId))).toEqual(replicaBefore);
    expect(await as(A, () => A.registry!.groupProjectRegistry.get(remoteId))).toEqual(hostBefore);
  });
});

describe('legacy polling migration through real storage (#3698)', () => {
  it.each(['allow', 'off'] as const)('clears the host flag, preserves deliver=%s and custom metadata, leaves replicas alone, and is idempotent', async deliver => {
    const remoteId = await sharedProject();
    await as(A, h => h.groupProjectHost.update(remoteId, { metadata: { pollingEnabled: true, custom: 'remote', grants: { deliver } } }));
    await as(B, h => h.groupProjectHost.syncFrom(A.fp));
    const local = await as(B, h => h.groupProjectHost.create('Legacy local'));
    await as(B, h => h.groupProjectHost.update(local.id, { metadata: { pollingEnabled: true, custom: 'local', grants: { deliver } } }));
    const beforeReplica = structuredClone(await as(B, () => B.registry!.groupProjectRegistry.get(remoteId)));
    await as(B, h => h.groupProjectHost.flushRegistry());
    B.registry!.groupProjectRegistry._resetForTesting();
    const loaded = await as(B, h => h.groupProjectHost.get(local.id));
    expect(loaded!.metadata).toEqual({ custom: 'local', grants: { deliver } });
    expect(await as(B, () => B.registry!.groupProjectRegistry.get(remoteId))).toEqual(beforeReplica);
    expect((await as(A, h => h.groupProjectHost.get(remoteId)))!.metadata.pollingEnabled).toBe(true);
    const file = path.join(B.home, '.clubhouse-dev', 'group-projects', 'registry.json');
    const first = await fsp.readFile(file, 'utf-8');
    expect(JSON.parse(first).find((p: { id: string }) => p.id === local.id).metadata).toEqual(loaded!.metadata);
    B.registry!.groupProjectRegistry._resetForTesting();
    expect((await as(B, h => h.groupProjectHost.get(local.id)))!.metadata).toEqual(loaded!.metadata);
    expect(await fsp.readFile(file, 'utf-8')).toBe(first);
    // Its authoritative host migrates the other record on its own next load.
    await as(A, h => h.groupProjectHost.flushRegistry());
    A.registry!.groupProjectRegistry._resetForTesting();
    expect((await as(A, h => h.groupProjectHost.get(remoteId)))!.metadata).toEqual({ custom: 'remote', grants: { deliver } });
    await as(B, h => h.groupProjectHost.syncFrom(A.fp));
    expect((await as(B, h => h.groupProjectHost.get(remoteId)))!.metadata).toEqual({ custom: 'remote', grants: { deliver } });
  });

  it('loads saved member switches containing retired or unknown names and keeps only active tools after save and reload', async () => {
    const id = await sharedProject();
    const file = path.join(A.home, '.clubhouse-dev', 'group-projects', id, 'membership.json');
    const record = await as(A, h => h.groupProjectHost.getMembership(id));
    await fsp.writeFile(file, JSON.stringify({ ...record, disabledTools: { lead: ['shoulder_tap', 'broadcast', 'query_polling', 'toggle_polling', 'nudge_polling', 'unknown', 'wake_agent'] } }));
    expect((await as(A, h => h.groupProjectHost.getMembership(id))).disabledTools).toEqual({ lead: ['wake_agent'] });
    await as(A, h => h.groupProjectHost.updateMembership(id, draft => { draft.autoJoin = !draft.autoJoin; }));
    expect(JSON.parse(await fsp.readFile(file, 'utf-8')).disabledTools).toEqual({ lead: ['wake_agent'] });
    expect((await as(A, h => h.groupProjectHost.getMembership(id))).disabledTools).toEqual({ lead: ['wake_agent'] });
  });
});


describe('legacy message shim through a copy (#3702 review)', () => {
  it.each([null, 'builder'])('forwards target=%s to its authoritative host as the person', async targetAgentId => {
    const id = await sharedProject();
    await as(A, h => h.groupProjectHost.updateMembership(id, draft => {
      draft.explicit.push({ address: `builder@${B.fp}`, name: 'Builder', kind: 'durable', addedAt: 'now' });
    }));
    await as(B, h => h.groupProjectHost.syncFrom(A.fp));
    B.bindings!.bindingManager.bind('builder', { targetId: id, targetKind: 'group-project', label: 'Launch', agentName: 'Builder' });
    const gate = vi.fn(() => 'An agent may not post here');
    A.host!.groupProjectHost.setRemoteWriteGate(gate);
    const posted = await as(B, async h => {
      const project = await h.groupProjectHost.get(id);
      expect(project!.network?.role).toBe('replica');
      return postLegacyGroupMessage(h.groupProjectHost, project!, 'Plugin user', targetAgentId, 'Through the copy', { label: 'user' });
    });
    expect(posted).toBeTruthy();
    expect(posted!.pending).toBeUndefined();
    const topic = targetAgentId ? 'inbox-builder' : 'general';
    expect(posted!.topic).toBe(topic);
    expect(await as(A, h => h.groupProjectHost.readTopic(id, topic))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: posted!.id, body: 'Through the copy', sender: 'Plugin user', urgent: true }),
    ]));
    expect(gate).not.toHaveBeenCalled();
    expect(refusals).toEqual([]);
  });
});

it('local provenance stays on the originating computer and cannot be claimed on the wire', async () => {
  const id = await sharedProject();
  const local = await as(B, (h) => h.groupProjectHost.post(id, 'user', 'general', 'from copy', { author: { label: 'user' } }));
  expect(B.origins!.isLocalGroupPost(id, local.id)).toBe(true);
  expect(A.origins!.isLocalGroupPost(id, local.id)).toBe(false);
  const forged = readWriteRequest(wire({ v: 1, writes: [{ id: 'forged-origin', groupProjectId: id, queuedAt: new Date().toISOString(), author: { label: 'user' }, write: { op: 'post', sender: 'user', topic: 'general', body: 'claim', localOrigin: true, remoteOrigin: false } }] }));
  await as(A, (h) => h.groupProjectHost.applyRemoteWrites(B.fp, forged));
  const received = (await as(A, (h) => h.groupProjectHost.readTopic(id, 'general'))).find((m) => m.body === 'claim')!;
  expect(received).toBeTruthy();
  expect(A.origins!.isLocalGroupPost(id, received.id)).toBe(false);
  expect(received).not.toHaveProperty('localOrigin');
});

it('snapshot departure prunes the copy member receipt when its host removes that member', async () => {
  const id = await sharedProject();
  const address = `builder@${B.fp}`;
  await as(A, h => h.groupProjectHost.updateMembership(id, draft => {
    draft.explicit.push({ address, kind: 'durable', name: 'Builder', addedAt: 'now' });
  }));
  await as(B, h => h.groupProjectHost.syncFrom(A.fp));
  await as(B, async () => {
    await B.receipts!.markNotified(id, 'builder', 30);
    expect(await B.receipts!.lastNotified(id, 'builder')).toBe(30);
    B.delivery!.watchGroupProjectDelivery();
  });
  const arrived: import('../../shared/group-project-types').GroupProjectChange[] = [];
  const off = B.host!.groupProjectHost.onChange(c => arrived.push(c));
  try {
    await as(A, h => h.groupProjectHost.updateMembership(id, draft => {
      draft.explicit = draft.explicit.filter(m => m.address !== address);
      draft.excluded.push({ address, excludedAt: 'now' });
    }));
    await as(B, h => h.groupProjectHost.syncFrom(A.fp));
    expect(arrived).toEqual(expect.arrayContaining([expect.objectContaining({ groupProjectId: id, part: 'record', departed: [address] })]));
    await vi.waitFor(async () => {
      expect(await as(B, async () => B.receipts!.lastNotified(id, 'builder'))).toBeUndefined();
    });
    const saved = JSON.parse(await fsp.readFile(path.join(B.home, 'group-project-notification-receipts.json'), 'utf8'));
    expect(Object.hasOwn(saved.notified, JSON.stringify([id, 'builder']))).toBe(false);
  } finally { off(); }
});
