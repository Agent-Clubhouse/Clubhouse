/**
 * Outcomes of changes made on a copy of a network group project (#3550), with
 * two desktops in one process: each runs its own host service, registry and
 * board, with its own home folder and identity, and requests between them go
 * through JSON and the validators the wire uses. A test can take the host
 * offline, or lose an answer after the host has applied the write.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { readSyncResponse, readWriteRequest, readWriteResponse, readSyncRequest } from '../../shared/group-project-network';
import type { GroupProjectNetworkRefusal, GroupProjectOperation } from '../../shared/group-project-types';

interface Machine {
  name: string;
  fp: string;
  home: string;
  projects?: Array<{ id: string; name: string; path: string; key: string; agents: Array<{ id: string; name: string }> }>;
  host?: typeof import('./group-project-host');
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
/** Writes to apply on the host and then fail to answer, as a dropped connection does. */
let loseAnswers = 0;

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
      if (loseAnswers > 0) { loseAnswers -= 1; throw new Error('connection dropped after the host applied the write'); }
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
  down.clear(); world.links = []; loseAnswers = 0;
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
    m.registry = await import('./group-project-registry');
    m.bulletin = await import('./group-project-bulletin');
    m.membership = await import('./group-project-membership');
    m.delivery = await import('./group-project-delivery');
    m.persisted = await import('./persisted-bindings');
    m.bindings = await import('./clubhouse-mcp/binding-manager');
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

const operations = (m: Machine, id: string) => as(m, (h) => h.groupProjectHost.operations(id));
const ofKind = (list: GroupProjectOperation[], op: string) => list.filter((o) => o.op === op);
const outboxIds = async (m: Machine): Promise<string[]> => {
  const file = path.join(m.home, '.clubhouse-dev', 'group-projects', 'network-outbox.json');
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf-8')) as { items: Array<{ id: string }> }).items.map((i) => i.id) : [];
};
const asMember = async (id: string) => {
  await as(B, (h) => h.groupProjectHost.updateMembership(id, (m) => {
    m.explicit.push({ address: `agent_b@${B.fp}`, kind: 'durable', addedAt: '2026-11-13T00:00:00.000Z' });
  }));
};
const agentB = { agentId: 'agent_b', label: 'builder@Studio' };
/** The next write of this computer's file fails, as a power cut would leave it. */
const failRenameOf = (m: Machine, name: string, times = 1) => {
  const rename = fs.promises.rename;
  let left = times;
  return vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (left > 0 && String(to).startsWith(m.home) && path.basename(String(to)) === name) { left -= 1; throw new Error('power cut'); }
    await rename(from, to);
  });
};
const ringIds = (m: Machine): string[] => (JSON.parse(fs.readFileSync(path.join(m.home, '.clubhouse-dev', 'group-projects', 'network-operations.json'), 'utf-8')) as { items: Array<{ id: string }> }).items.map((i) => i.id);

describe('queued, applied and refused outcomes for changes made on a copy (#3550)', () => {
  it('a change made with the host connected is applied, and says so under its own id', async () => {
    const id = await sharedProject();
    await as(B, (h) => h.groupProjectHost.setTopicProtected(id, 'work', true, { author: { label: 'user' } }));
    const { operations: list, omittedQueued } = await operations(B, id);
    expect(omittedQueued).toBe(0);
    expect(list).toEqual([expect.objectContaining({ groupProjectId: id, op: 'setTopicProtected', section: 'cleanup', outcome: { status: 'applied' }, author: { label: 'user' } })]);
    expect(await outboxIds(B)).toEqual([]);
  });

  it('offline: queued with who it waits for and since when; on reconnect the same id is applied', async () => {
    const id = await sharedProject();
    down.add('Desk');
    await as(B, (h) => h.groupProjectHost.update(id, { description: 'while away' }));
    await as(B, (h) => h.groupProjectHost.deleteTopic(id, 'general'));
    const waiting = await operations(B, id);
    expect(waiting.operations.map((o) => [o.op, o.section, o.outcome.status])).toEqual([['update', 'details', 'queued'], ['deleteTopic', 'cleanup', 'queued']]);
    expect(waiting.operations[0].outcome).toEqual({ status: 'queued', waitingFor: 'Desk', since: waiting.operations[0].since });
    // The operation's id is the outbox entry's own: the one the host recognizes a replay by.
    const queuedIds = await outboxIds(B);
    expect(waiting.operations.map((o) => o.id)).toEqual(queuedIds);
    // Nothing applied on the host, and the copy has not changed.
    expect((await as(A, (h) => h.groupProjectHost.get(id)))!.description).toBe('');

    down.delete('Desk');
    await as(B, (h) => h.groupProjectHost.flushOutbox(A.fp));
    const answered = await operations(B, id);
    expect(answered.operations.map((o) => o.id)).toEqual(queuedIds);
    expect(answered.operations.map((o) => o.outcome.status)).toEqual(['applied', 'applied']);
    expect(await outboxIds(B)).toEqual([]);
    expect((await as(A, (h) => h.groupProjectHost.get(id)))!.description).toBe('while away');
  });

  it('a queued write whose answer was lost and is replayed settles exactly once, with no new id', async () => {
    const id = await sharedProject();
    down.add('Desk');
    await as(B, (h) => h.groupProjectHost.post(id, 'user', 'work', 'once', { author: { label: 'user' } }));
    const [queuedId] = await outboxIds(B);
    down.delete('Desk');
    const events: string[] = [];
    await as(B, async (h) => { h.groupProjectHost.onOperationsChanged((group) => events.push(group)); });

    // The host applies it and the answer never arrives; the write stays in the outbox.
    loseAnswers = 1;
    await expect(as(B, (h) => h.groupProjectHost.flushOutbox(A.fp))).rejects.toThrow('connection dropped');
    expect(await outboxIds(B)).toEqual([queuedId]);
    expect((await operations(B, id)).operations).toEqual([expect.objectContaining({ id: queuedId, outcome: expect.objectContaining({ status: 'queued' }) })]);

    // The replay carries the same id; the host answers as before and the post is made once.
    await as(B, (h) => h.groupProjectHost.flushOutbox(A.fp));
    await as(B, (h) => h.groupProjectHost.flushOutbox(A.fp));
    const final = (await operations(B, id)).operations;
    expect(final).toEqual([expect.objectContaining({ id: queuedId, outcome: { status: 'applied' } })]);
    const ring = JSON.parse(fs.readFileSync(path.join(B.home, '.clubhouse-dev', 'group-projects', 'network-operations.json'), 'utf-8')) as { items: Array<{ id: string }> };
    expect(ring.items.filter((i) => i.id === queuedId)).toHaveLength(1);
    expect((await as(A, (h) => h.groupProjectHost.readTopic(id, 'work'))).map((m) => m.body)).toEqual(['once']);
    expect(events.length).toBeGreaterThan(0);
  });

  it('a crash after the answer is settled but before the outbox is saved: Applied shows, and the restart replay settles once', async () => {
    const id = await sharedProject();
    down.add('Desk');
    await as(B, (h) => h.groupProjectHost.post(id, 'user', 'work', 'once', { author: { label: 'user' } }));
    const [queuedId] = await outboxIds(B);
    down.delete('Desk');

    const spy = failRenameOf(B, 'network-outbox.json');
    await expect(as(B, (h) => h.groupProjectHost.flushOutbox(A.fp))).rejects.toThrow('power cut');
    spy.mockRestore();
    // The host applied it and the status was settled; the write is still in the outbox.
    expect(await outboxIds(B)).toEqual([queuedId]);
    expect((await operations(B, id)).operations).toEqual([expect.objectContaining({ id: queuedId, outcome: { status: 'applied' } })]);

    // Restart: the replay carries the same id, the host answers as before, nothing is settled twice.
    B.host!.groupProjectHost._resetForTesting();
    B.host!.groupProjectHost.setNetworkLink(linkFor(B));
    expect((await operations(B, id)).operations).toEqual([expect.objectContaining({ id: queuedId, outcome: { status: 'applied' } })]);
    await as(B, (h) => h.groupProjectHost.flushOutbox(A.fp));
    expect(await outboxIds(B)).toEqual([]);
    expect(ringIds(B)).toEqual([queuedId]);
    expect((await operations(B, id)).operations).toEqual([expect.objectContaining({ id: queuedId, outcome: { status: 'applied' } })]);
    expect((await as(A, (h) => h.groupProjectHost.readTopic(id, 'work'))).map((m) => m.body)).toEqual(['once']);
  });

  it('a replayed membership write the host applied, except for what could not be attributed, is applied with one refusal-list entry', async () => {
    const id = await sharedProject();
    down.add('Desk');
    await as(B, (h) => h.groupProjectHost.updateMembership(id, (m) => {
      m.explicit.push({ address: `agent_b@${B.fp}`, kind: 'durable', addedAt: '2026-11-13T00:00:00.000Z', name: 'builder' });
      // What an older build queued: an agent named by a bare id that is not one of this computer's.
      m.disabledTools = { ...m.disabledTools, ghost: ['broadcast'] };
    }));
    down.delete('Desk');
    await as(B, (h) => h.groupProjectHost.flushOutbox(A.fp));
    expect((await as(A, (h) => h.groupProjectHost.getMembership(id))).explicit.map((e) => e.address)).toEqual([`agent_b@${B.fp}`]);
    expect((await operations(B, id)).operations).toEqual([expect.objectContaining({ op: 'membership', outcome: { status: 'applied' } })]);
    const shown = (await as(B, (h) => h.groupProjectHost.get(id)))!.network!.refusals;
    expect(shown).toEqual([expect.objectContaining({ op: 'membership', reason: expect.stringContaining('ghost') })]);
  });

  it('a crash while refusing expired changes refuses them once, whichever side of the outbox it fell on', async () => {
    const id = await sharedProject();
    down.add('Desk');
    await as(B, (h) => h.groupProjectHost.update(id, { name: 'Late' }));
    down.delete('Desk');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 24 * 60 * 60 * 1000 + 1000 });
    try {
      const spy = failRenameOf(B, 'network-outbox.json');
      await expect(as(B, (h) => h.groupProjectHost.flushOutbox(A.fp))).rejects.toThrow('power cut');
      spy.mockRestore();
      // Refused before it left the outbox, so the crash lost nothing: it is refused again on the next flush, once.
      expect(await outboxIds(B)).toHaveLength(1);
      await as(B, (h) => h.groupProjectHost.flushOutbox(A.fp));
    } finally {
      vi.useRealTimers();
    }
    expect(await outboxIds(B)).toEqual([]);
    expect((await as(B, (h) => h.groupProjectHost.get(id)))!.network!.refusals).toHaveLength(1);
    expect((await operations(B, id)).operations).toEqual([expect.objectContaining({ outcome: { status: 'refused', reason: expect.stringContaining('more than a day') } })]);
    expect(refusals).toHaveLength(1);
  });

  it('membership changed meanwhile: the host refuses the queued post, and the same id is refused in both lists', async () => {
    const id = await sharedProject();
    await asMember(id);
    down.add('Desk');
    await as(B, (h) => h.groupProjectHost.post(id, 'builder@Studio', 'work', 'queued while a member', { author: agentB }));
    // The host removes the agent while it is away.
    await as(A, (h) => h.groupProjectHost.updateMembership(id, (m) => { m.explicit = []; }));
    down.delete('Desk');
    await as(B, (h) => h.groupProjectHost.flushOutbox(A.fp));
    const all = (await operations(B, id)).operations;
    // The agent's own join was applied when made; only the post is refused.
    expect(all.map((o) => [o.op, o.outcome.status])).toEqual([['membership', 'applied'], ['post', 'refused']]);
    const refused = ofKind(all, 'post')[0];
    expect(refused).toMatchObject({ op: 'post', section: 'posts', outcome: { status: 'refused', reason: expect.stringContaining('member') } });
    // The existing refusal list is unchanged and keyed by the same id.
    const shown = (await as(B, (h) => h.groupProjectHost.get(id)))!.network!.refusals;
    expect(shown).toEqual([expect.objectContaining({ id: refused.id, op: 'post', reason: expect.stringContaining('member') })]);
    expect((await as(A, (h) => h.groupProjectHost.readTopic(id, 'work')))).toEqual([]);
  });

  it('a change refused while the host is online is refused at once, and recorded as refused', async () => {
    const id = await sharedProject();
    await expect(as(B, (h) => h.groupProjectHost.post(id, 'user', 'system', 'nope', { author: { label: 'user' } }))).rejects.toMatchObject({ code: 'refused' });
    const [only] = (await operations(B, id)).operations;
    expect(only).toMatchObject({ op: 'post', outcome: { status: 'refused', reason: expect.stringContaining('reserved') } });
    // Not a deferred refusal: the refusal list is for what the host refused later.
    expect((await as(B, (h) => h.groupProjectHost.get(id)))!.network!.refusals).toEqual([]);
  });

  it('expiry: a change waiting more than a day is refused as it always was, and says so', async () => {
    const id = await sharedProject();
    down.add('Desk');
    await as(B, (h) => h.groupProjectHost.update(id, { name: 'Late' }));
    down.delete('Desk');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 24 * 60 * 60 * 1000 + 1000 });
    try {
      await as(B, (h) => h.groupProjectHost.flushOutbox(A.fp));
      const [expired] = (await operations(B, id)).operations;
      expect(expired).toMatchObject({ op: 'update', outcome: { status: 'refused', reason: expect.stringContaining('more than a day') } });
    } finally {
      vi.useRealTimers();
    }
    expect((await as(A, (h) => h.groupProjectHost.get(id)))!.name).toBe('Launch');
    expect((await as(B, (h) => h.groupProjectHost.get(id)))!.network!.refusals).toHaveLength(1);
  });

  it('a full queue refuses the new change, keeps the waiting ones, and bounds what is read', async () => {
    const id = await sharedProject();
    down.add('Desk');
    for (let n = 0; n < 200; n++) await as(B, (h) => h.groupProjectHost.post(id, 'user', 'work', `m${n}`, { author: { label: 'user' } }));
    await expect(as(B, (h) => h.groupProjectHost.deleteMessage(id, 'work', 'msg_x', { author: { label: 'user' } }))).rejects.toMatchObject({ code: 'queue_full' });
    const read = await operations(B, id);
    expect(ofKind(read.operations, 'post').filter((o) => o.outcome.status === 'queued')).toHaveLength(50);
    expect(read.omittedQueued).toBe(150);
    expect(ofKind(read.operations, 'deleteMessage')).toEqual([expect.objectContaining({ section: 'cleanup', outcome: { status: 'refused', reason: expect.stringContaining('Too many changes') } })]);
    expect(await outboxIds(B)).toHaveLength(200);
  }, 60_000);

  it('a removed host: waiting changes are refused with its name, and a new change is refused as read-only', async () => {
    const id = await sharedProject();
    down.add('Desk');
    await as(B, (h) => h.groupProjectHost.update(id, { description: 'waiting' }));
    await as(B, (h) => h.groupProjectHost.machineRemoved(A.fp));
    await expect(as(B, (h) => h.groupProjectHost.update(id, { description: 'after' }))).rejects.toMatchObject({ code: 'read_only' });
    const list = (await operations(B, id)).operations;
    expect(list.map((o) => o.outcome)).toEqual([
      { status: 'refused', reason: expect.stringContaining('Desk left your network') },
      { status: 'refused', reason: expect.stringContaining('read-only') },
    ]);
    expect(await outboxIds(B)).toEqual([]);
  });

  it('a deleted group project refuses what was waiting for it', async () => {
    const id = await sharedProject();
    down.add('Desk');
    await as(B, (h) => h.groupProjectHost.setTopicProtected(id, 'work', true, { author: { label: 'user' } }));
    await as(A, (h) => h.groupProjectHost.delete(id));
    down.delete('Desk');
    await as(B, (h) => h.groupProjectHost.flushOutbox(A.fp));
    const [only] = (await operations(B, id)).operations;
    expect(only).toMatchObject({ op: 'setTopicProtected', outcome: { status: 'refused', reason: expect.stringContaining('deleted') } });
  });

  it('housekeeping with no place on the page is not listed', async () => {
    const id = await sharedProject();
    down.add('Desk');
    await as(B, (h) => h.groupProjectHost.ensureInbox(id, 'builder', 'agent_b'));
    expect(await outboxIds(B)).toHaveLength(1);
    expect((await operations(B, id)).operations).toEqual([]);
  });

  it('answers survive a restart, age out after an hour, and clearing refusals keeps the applied ones', async () => {
    const id = await sharedProject();
    await as(B, (h) => h.groupProjectHost.update(id, { description: 'applied one' }));
    down.add('Desk');
    await as(B, (h) => h.groupProjectHost.update(id, { name: 'refused one' }));
    await as(A, (h) => h.groupProjectHost.delete(id));
    down.delete('Desk');
    await as(B, (h) => h.groupProjectHost.flushOutbox(A.fp));
    B.host!.groupProjectHost.setNetworkLink(linkFor(B));
    expect((await operations(B, id)).operations.map((o) => o.outcome.status)).toEqual(['applied', 'refused']);

    B.host!.groupProjectHost._resetForTesting();
    B.host!.groupProjectHost.setNetworkLink(linkFor(B));
    expect((await operations(B, id)).operations.map((o) => o.outcome.status)).toEqual(['applied', 'refused']);

    await as(B, (h) => h.groupProjectHost.dismissRefusals(id));
    expect((await operations(B, id)).operations.map((o) => o.outcome.status)).toEqual(['applied']);

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61 * 60 * 1000 });
    try {
      expect((await operations(B, id)).operations).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a corrupt status file is ignored: waiting changes still show, and nothing is shown as applied', async () => {
    const id = await sharedProject();
    await as(B, (h) => h.groupProjectHost.update(id, { description: 'applied' }));
    down.add('Desk');
    await as(B, (h) => h.groupProjectHost.update(id, { name: 'waiting' }));
    const file = path.join(B.home, '.clubhouse-dev', 'group-projects', 'network-operations.json');
    fs.writeFileSync(file, '{ not json');
    B.host!.groupProjectHost._resetForTesting();
    B.host!.groupProjectHost.setNetworkLink(linkFor(B));
    const list = (await operations(B, id)).operations;
    expect(list).toEqual([expect.objectContaining({ op: 'update', outcome: expect.objectContaining({ status: 'queued' }) })]);

    // Entries that are not well-formed are dropped one by one, never read as applied.
    fs.writeFileSync(file, JSON.stringify({ version: 1, items: [{ id: 'x', groupProjectId: id, op: 'update', outcome: { status: 'applied' } }, 7] }));
    B.host!.groupProjectHost._resetForTesting();
    B.host!.groupProjectHost.setNetworkLink(linkFor(B));
    expect((await operations(B, id)).operations.map((o) => o.outcome.status)).toEqual(['queued']);
  });
});
