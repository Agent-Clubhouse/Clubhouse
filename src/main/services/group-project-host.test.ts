import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

const fixture = vi.hoisted(() => ({ home: '', fingerprint: null as string | null }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => fixture.home },
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-network-profile', () => ({ annexEphemeralSession: () => false }));
vi.mock('./annex-identity', () => ({
  getIdentity: () => (fixture.fingerprint ? { fingerprint: fixture.fingerprint } : null),
}));
vi.mock('./project-store', () => ({ list: vi.fn(async () => [{ id: 'proj_a' }]) }));

import { groupProjectRegistry } from './group-project-registry';
import { _resetAllBoardsForTesting, getBulletinBoard } from './group-project-bulletin';
import { GroupProjectHostError, groupProjectHost } from './group-project-host';
import type { GroupProjectChange } from '../../shared/group-project-types';

const dataDir = () => path.join(fixture.home, '.clubhouse-dev', 'group-projects');
const hostFile = (id: string) => path.join(dataDir(), id, 'host.json');
const membershipFile = (id: string) => path.join(dataDir(), id, 'membership.json');
const FP_A = Array.from({ length: 32 }, () => 'aa').join(':');
const FP_B = Array.from({ length: 32 }, () => 'bb').join(':');

/** Drop every in-memory cache, as a restart would. Files stay. */
async function restart(): Promise<void> {
  await groupProjectRegistry.flush();
  await groupProjectHost.flushBoards();
  groupProjectRegistry._resetForTesting();
  _resetAllBoardsForTesting();
  groupProjectHost._resetForTesting();
}

beforeEach(async () => {
  const cache = path.join(process.cwd(), 'node_modules', '.cache');
  await fsp.mkdir(cache, { recursive: true });
  fixture.home = await fsp.mkdtemp(path.join(cache, 'group-project-host-'));
  fixture.fingerprint = null;
  groupProjectRegistry._resetForTesting();
  _resetAllBoardsForTesting();
  groupProjectHost._resetForTesting();
});

afterEach(async () => {
  groupProjectRegistry._resetForTesting();
  _resetAllBoardsForTesting();
  groupProjectHost._resetForTesting();
  vi.restoreAllMocks();
  await fsp.rm(fixture.home, { recursive: true, force: true });
});

describe('group project host: identity and creation', () => {
  it('records this machine as host at creation, by fingerprint when Annex has an identity', async () => {
    fixture.fingerprint = FP_A.toUpperCase();
    const project = await groupProjectHost.create('Release');
    expect(project.host).toEqual({ machine: FP_A });
    expect(project.seq).toBe(1);
    expect(groupProjectHost.isThisMachine(project.host)).toBe(true);
    expect(groupProjectHost.isThisMachine({ machine: FP_B })).toBe(false);
  });

  it('records a null host with no identity, and legacy records load as this machine', async () => {
    const project = await groupProjectHost.create('Local');
    expect(project.host).toEqual({ machine: null });
    await restart();
    await fsp.writeFile(path.join(dataDir(), 'registry.json'), JSON.stringify([
      { id: 'gp_legacy', name: 'Old', description: '', instructions: '', createdAt: '2026-01-01T00:00:00.000Z', scope: { level: 'app', reach: 'local' }, metadata: {} },
    ]));
    groupProjectRegistry._resetForTesting();
    const legacy = await groupProjectHost.get('gp_legacy');
    expect(legacy).toMatchObject({ host: { machine: null }, seq: 0 });
  });

  it('seeds general and control in the creating change, stamped with its sequence number', async () => {
    const project = await groupProjectHost.create('Seeded');
    const general = await getBulletinBoard(project.id).getTopicMessages('general');
    expect(general).toHaveLength(1);
    expect(general[0].seq).toBe(1);
    expect(getBulletinBoard(project.id).isTopicProtected('control')).toBe(true);
  });

  it('gives ids that differ across machines and never reuses a deleted id', async () => {
    const first = await groupProjectHost.create('One');
    expect(first.id).toMatch(/^gp_\d+_[0-9a-f]{12}$/);
    await groupProjectHost.delete(first.id);
    const second = await groupProjectHost.create('Two');
    expect(second.id).not.toBe(first.id);
  });

  it('refuses ids that would leave the data directory', async () => {
    await expect(groupProjectHost.get('../escape')).rejects.toThrow('Invalid group project id');
    await expect(groupProjectHost.post('a/b', 'x', 'general', 'hi')).rejects.toThrow('Invalid group project id');
  });
});

describe('group project host: sequence numbers', () => {
  it('increases with each change, across record, membership and board, and announces each one', async () => {
    const project = await groupProjectHost.create('Seq');
    const changes: GroupProjectChange[] = [];
    groupProjectHost.onChange((change) => changes.push(change));

    await groupProjectHost.update(project.id, { description: 'd' });
    const message = await groupProjectHost.post(project.id, 'alice', 'work', 'hello');
    await groupProjectHost.updateMembership(project.id, (m) => { m.autoJoin = true; });
    await groupProjectHost.setTopicProtected(project.id, 'work', true);

    expect(message.seq).toBe(3);
    expect(changes).toEqual([
      { groupProjectId: project.id, seq: 2, part: 'record' },
      { groupProjectId: project.id, seq: 3, part: 'board' },
      { groupProjectId: project.id, seq: 4, part: 'membership' },
      { groupProjectId: project.id, seq: 5, part: 'board' },
    ]);
    expect((await groupProjectHost.get(project.id))?.seq).toBe(5);
  });

  it('survives restart and keeps increasing', async () => {
    const project = await groupProjectHost.create('Durable');
    await groupProjectHost.post(project.id, 'alice', 'work', 'one');
    await restart();
    expect((await groupProjectHost.get(project.id))?.seq).toBe(2);
    const next = await groupProjectHost.post(project.id, 'alice', 'work', 'two');
    expect(next.seq).toBe(3);
    expect(JSON.parse(await fsp.readFile(hostFile(project.id), 'utf-8'))).toEqual({ version: 1, seq: 3 });
  });

  it('does not count a change that changes nothing', async () => {
    const project = await groupProjectHost.create('Noop');
    await groupProjectHost.setTopicProtected(project.id, 'general', true);
    expect(await groupProjectHost.deleteMessage(project.id, 'general', 'msg_missing')).toBe(false);
    expect(await groupProjectHost.deleteTopic(project.id, 'nowhere')).toBe(false);
    await groupProjectHost.ensureChannels(project.id);
    await groupProjectHost.updateMembership(project.id, () => undefined);
    expect((await groupProjectHost.get(project.id))?.seq).toBe(1);
  });

  it('serializes concurrent writes so every post gets its own number', async () => {
    const project = await groupProjectHost.create('Burst');
    const posts = await Promise.all(Array.from({ length: 10 }, (_, i) => groupProjectHost.post(project.id, 'a', 'work', `m${i}`)));
    expect(posts.map((p) => p.seq).sort((a, b) => a! - b!)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('refuses writes when the sequence state is corrupt, rather than restarting at zero', async () => {
    const project = await groupProjectHost.create('Corrupt');
    await restart();
    await fsp.writeFile(hostFile(project.id), '{not json');
    await expect(groupProjectHost.post(project.id, 'a', 'work', 'x')).rejects.toThrow('could not be read');
    expect(await fsp.readFile(hostFile(project.id), 'utf-8')).toBe('{not json');
  });
});

describe('group project host: crash safety', () => {
  it('leaves the previous sequence state readable when a write fails mid-way, and applies nothing', async () => {
    const project = await groupProjectHost.create('Crash');
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (to === hostFile(project.id)) throw new Error('disk full');
      await rename(from, to);
    });
    await expect(groupProjectHost.post(project.id, 'a', 'work', 'lost')).rejects.toThrow('disk full');
    expect(JSON.parse(await fsp.readFile(hostFile(project.id), 'utf-8'))).toEqual({ version: 1, seq: 1 });
    expect(await getBulletinBoard(project.id).hasTopic('work')).toBe(false);
    vi.restoreAllMocks();
    expect((await groupProjectHost.post(project.id, 'a', 'work', 'kept')).seq).toBe(2);
  });

  it('leaves the previous membership readable when its write fails', async () => {
    const project = await groupProjectHost.create('Members');
    await groupProjectHost.updateMembership(project.id, (m) => {
      m.explicit.push({ address: 'agent_1', kind: 'helper', addedAt: '2026-11-13T00:00:00.000Z', name: 'builder' });
    });
    const before = await fsp.readFile(membershipFile(project.id), 'utf-8');
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (to === membershipFile(project.id)) throw new Error('power cut');
      await rename(from, to);
    });
    await expect(groupProjectHost.updateMembership(project.id, (m) => { m.explicit = []; })).rejects.toThrow('power cut');
    expect(await fsp.readFile(membershipFile(project.id), 'utf-8')).toBe(before);
    await restart();
    expect((await groupProjectHost.getMembership(project.id)).explicit).toHaveLength(1);
  });

  it('finishes a delete that stopped after its tombstone was saved', async () => {
    const project = await groupProjectHost.create('Half deleted');
    await groupProjectHost.post(project.id, 'a', 'work', 'x');
    await restart();
    const registry = await fsp.readFile(path.join(dataDir(), 'registry.json'), 'utf-8');
    await groupProjectHost.delete(project.id);
    // Simulate the crash: the record and board came back, the tombstone stayed.
    await fsp.writeFile(path.join(dataDir(), 'registry.json'), registry);
    await fsp.mkdir(path.join(dataDir(), project.id), { recursive: true });
    await fsp.writeFile(path.join(dataDir(), project.id, 'bulletin.json'), '{"topics":{}}');
    await restart();
    expect(await groupProjectHost.list()).toEqual([]);
    expect(fs.existsSync(path.join(dataDir(), project.id))).toBe(false);
  });
});

describe('group project host: delete', () => {
  it('removes the record, board, membership and sequence state, and leaves a tombstone', async () => {
    fixture.fingerprint = FP_A;
    const project = await groupProjectHost.create('Gone');
    await groupProjectHost.updateMembership(project.id, (m) => { m.autoJoin = true; });
    const changes: GroupProjectChange[] = [];
    groupProjectHost.onChange((c) => changes.push(c));
    const result = await groupProjectHost.delete(project.id);
    expect(result).toMatchObject({ deleted: true, tombstone: { groupProjectId: project.id, host: { machine: FP_A }, seq: 3 } });
    expect(changes).toEqual([{ groupProjectId: project.id, seq: 3, part: 'deleted' }]);
    expect(fs.existsSync(path.join(dataDir(), project.id))).toBe(false);
    await restart();
    expect(await groupProjectHost.get(project.id)).toBeNull();
    expect((await groupProjectHost.listTombstones()).map((t) => t.groupProjectId)).toEqual([project.id]);
    expect(await groupProjectHost.delete(project.id)).toEqual({ deleted: false });
  });

  it('refuses when the group project changed since the expected sequence number', async () => {
    const project = await groupProjectHost.create('Previewed');
    const previewed = (await groupProjectHost.get(project.id))!.seq!;
    await groupProjectHost.post(project.id, 'a', 'work', 'arrived after the preview');
    const refused = groupProjectHost.delete(project.id, { expectedSeq: previewed });
    await expect(refused).rejects.toBeInstanceOf(GroupProjectHostError);
    await expect(refused).rejects.toMatchObject({ code: 'changed' });
    expect(await groupProjectHost.get(project.id)).not.toBeNull();
  });

  it('holds other writes while an exclusive operation runs, and deletes inside it', async () => {
    const project = await groupProjectHost.create('Locked');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const exclusive = groupProjectHost.exclusive(project.id, async ({ seq }) => {
      order.push('exclusive start');
      await gate;
      order.push('exclusive end');
      return groupProjectHost.delete(project.id, { expectedSeq: seq, withinExclusive: true });
    });
    const post = groupProjectHost.post(project.id, 'a', 'work', 'waits').then(() => order.push('post'), () => order.push('post refused'));
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await exclusive).deleted).toBe(true);
    await post;
    expect(order).toEqual(['exclusive start', 'exclusive end', 'post refused']);
  });
});

describe('group project host: members by address', () => {
  it('keeps two agents with the same name apart, keyed by address', async () => {
    fixture.fingerprint = FP_A;
    const project = await groupProjectHost.create('Names');
    const { membership } = await groupProjectHost.updateMembership(project.id, (m) => {
      m.explicit.push(
        { address: 'agent_1', kind: 'quick', addedAt: '2026-11-13T00:00:00.000Z', name: 'builder' },
        { address: `agent_1@${FP_B}`, kind: 'quick', addedAt: '2026-11-13T00:00:00.000Z', name: 'builder' },
        { address: 'agent_2', kind: 'quick', addedAt: '2026-11-13T00:00:00.000Z', name: 'builder' },
      );
    });
    expect(membership.explicit.map((e) => e.address)).toEqual(['agent_1', `agent_1@${FP_B}`, 'agent_2']);
  });

  it('stores this machine\'s qualified address in its host-relative form and refuses duplicates', async () => {
    fixture.fingerprint = FP_A;
    const project = await groupProjectHost.create('Canonical');
    const { membership } = await groupProjectHost.updateMembership(project.id, (m) => {
      m.excluded.push({ address: `agent_9@${FP_A.toUpperCase()}`, excludedAt: '2026-11-13T00:00:00.000Z' });
    });
    expect(membership.excluded[0].address).toBe('agent_9');
    await expect(groupProjectHost.updateMembership(project.id, (m) => {
      m.excluded.push({ address: 'agent_9', excludedAt: '2026-11-13T00:00:00.000Z' });
    })).rejects.toThrow('twice');
    expect((await groupProjectHost.getMembership(project.id)).excluded).toHaveLength(1);
  });

  it('keeps fields it does not know, for the membership policy to own', async () => {
    const project = await groupProjectHost.create('Policy');
    await groupProjectHost.updateMembership(project.id, (m) => { m.autoJoinOffer = 'pending'; m.futureField = { a: 1 }; });
    await restart();
    expect(await groupProjectHost.getMembership(project.id)).toMatchObject({ autoJoinOffer: 'pending', futureField: { a: 1 } });
  });

  it('gives a second member with the same name its own inbox, and keeps the first one\'s', async () => {
    const project = await groupProjectHost.create('Inboxes');
    const first = await groupProjectHost.ensureInbox(project.id, 'Builder', 'agent_1');
    const second = await groupProjectHost.ensureInbox(project.id, 'Builder', 'agent_2');
    expect(first).toBe('inbox-builder');
    expect(second).toMatch(/^inbox-builder-[0-9a-f]{6}$/);
    expect(await groupProjectHost.ensureInbox(project.id, 'Builder', 'agent_1')).toBe(first);
    await restart();
    expect(await groupProjectHost.inboxFor(project.id, 'Builder', 'agent_2')).toBe(second);
    expect(await groupProjectHost.inboxFor(project.id, 'Builder', 'agent_1')).toBe(first);
  });
});
