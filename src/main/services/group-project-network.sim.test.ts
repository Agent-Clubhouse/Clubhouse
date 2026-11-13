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
import type { GroupProjectNetworkRefusal } from '../../shared/group-project-types';

interface Machine {
  name: string;
  fp: string;
  home: string;
  projects?: Array<{ id: string; name: string; path: string; key: string; agents: Array<{ id: string; name: string }> }>;
  host?: typeof import('./group-project-host');
  registry?: typeof import('./group-project-registry');
  bulletin?: typeof import('./group-project-bulletin');
}

const world = vi.hoisted(() => ({
  als: null as unknown as AsyncLocalStorage<{ home: string; fp: string; projects?: Array<{ id: string; name: string; path: string; key: string; agents: Array<{ id: string; name: string }> }> }>,
  fallbackHome: '',
}));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => world.als?.getStore()?.home ?? world.fallbackHome } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-network-profile', () => ({ annexEphemeralSession: () => false }));
vi.mock('./annex-identity', () => ({ getIdentity: () => (world.als?.getStore() ? { fingerprint: world.als.getStore()!.fp } : null) }));
vi.mock('./annex-settings', () => ({ networkEnabled: () => true }));
const projectsHere = () => world.als?.getStore()?.projects ?? [];
vi.mock('./project-store', () => ({ list: vi.fn(async () => projectsHere().map(({ id, name, path }) => ({ id, name, path }))) }));
vi.mock('./agent-config', () => ({
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
  down.clear();
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
    m.host.groupProjectHost.setNetworkLink(linkFor(m));
  }
});

afterEach(async () => {
  for (const m of machines) {
    await as(m, async (h) => { await h.groupProjectHost.flushRegistry(); await h.groupProjectHost.flushBoards(); });
    m.host!.groupProjectHost._resetForTesting();
    m.registry!.groupProjectRegistry._resetForTesting();
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
  it('a copy appears on the other computer, named by its host, and its posts reach the host and back', async () => {
    const id = await sharedProject();
    const copy = await as(B, (h) => h.groupProjectHost.get(id));
    expect(copy).toMatchObject({ name: 'Launch', hostName: 'Desk', host: { machine: A.fp }, network: { role: 'replica', state: 'online', waitingWrites: 0 } });
    expect(await as(A, (h) => h.groupProjectHost.get(id))).toMatchObject({ hostName: 'This computer', network: { role: 'host' } });

    // An agent on the non-host computer, a member, posts: the host applies it, and every member computer shows it.
    await as(B, (h) => h.groupProjectHost.updateMembership(id, (m) => {
      m.explicit.push({ address: `agent_b@${B.fp}`, kind: 'durable', addedAt: '2026-11-13T00:00:00.000Z' });
    }));
    const posted = await as(B, (h) => h.groupProjectHost.post(id, 'builder@Studio', 'work', 'from the studio', { author: { agentId: 'agent_b', label: 'builder@Studio' } }));
    expect(posted.pending).toBeUndefined();
    expect(posted.seq).toBeGreaterThan(1);
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

  it('a project scope over the network covers the other computer\'s project of the same repository', async () => {
    const project = await as(A, (h) => h.groupProjectHost.create('App team', { scope: { level: 'project', projectId: 'proj_a', reach: 'network' } }));
    await as(B, (h) => h.groupProjectHost.syncFrom(A.fp));
    expect(await as(B, (h) => h.groupProjectHost.get(project.id))).toMatchObject({ scopeProjectKey: 'github.com/org/app' });
    expect(await as(B, (h) => h.groupProjectHost.inScope(project.id, 'builder'))).toBe(true);
    expect(await as(B, (h) => h.groupProjectHost.inScope(project.id, 'stranger'))).toBe(false);
    expect(await as(B, (h) => h.groupProjectHost.admits(project.id, 'builder'))).toBe(true);
    expect(await as(B, (h) => h.groupProjectHost.admits(project.id, 'stranger'))).toBe(false);
  });

  describe('the host decides who may write (#3446 review)', () => {
    const writeAs = (id: string, author: { agentId?: string; label: string }, write: unknown, writeId = `w-${Math.random()}`) =>
      as(A, (h) => h.groupProjectHost.applyRemoteWrites(B.fp, readWriteRequest(wire({ v: 1, writes: [{ id: writeId, groupProjectId: id, queuedAt: '2026-11-13T00:00:00.000Z', author, write }] }))));

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

    it('asks the registered grant check for an agent\'s change, with its address and the action', async () => {
      const id = await sharedProject();
      const checks: unknown[] = [];
      A.host!.groupProjectHost.setRemoteWriteGate((check) => { checks.push({ address: check.address, action: check.action, isMember: check.isMember }); return undefined; });
      expect((await writeAs(id, { agentId: 'lead', label: 'l' }, { op: 'update', fields: { description: 'by a granted lead' } })).results[0].status).toBe('applied');
      expect(checks).toEqual([{ address: `lead@${B.fp}`, action: 'group_project.admin', isMember: false }]);
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
});
