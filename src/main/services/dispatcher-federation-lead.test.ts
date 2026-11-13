/**
 * The network-wide lead (#3351), across simulated computers: each is its own
 * instance of the module with its own files, peers and clock, and they meet
 * only through the connection exchange's `extra`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compareLeadRecords, readLeadRecord, NO_LEAD, type LeadRecord } from '../../shared/dispatcher-lead';

type Peer = { fingerprint: string; alias: string; role: string; kind: string };
const world = vi.hoisted(() => ({
  current: '',
  files: new Map<string, unknown>(),
  peers: {} as Record<string, Peer[]>,
  removals: {} as Record<string, Array<{ fingerprint: string; removedAt: string }>>,
  paired: {} as Record<string, boolean>,
  membership: {} as Record<string, Array<() => void>>,
}));

vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./settings-store', () => ({
  createSettingsStore: <T>(file: string, defaults: T) => {
    const key = `${world.current}/${file}`;
    return {
      get: () => (world.files.get(key) as T | undefined) ?? defaults,
      save: async (value: T) => { world.files.set(key, structuredClone(value)); },
    };
  },
}));
vi.mock('./annex-identity', () => ({ getIdentity: () => (world.current ? { fingerprint: world.current.toUpperCase() } : null) }));
vi.mock('./annex-settings', () => ({ getSettings: () => ({ alias: world.current.toUpperCase() }) }));
vi.mock('./annex-peers', () => ({ listPeers: () => world.peers[world.current] ?? [], peerNeedsPairing: () => false }));
vi.mock('./dispatcher-federation', () => ({ remoteFederationController: () => ({ agentId: 'c', name: 'Controller', enabled: true }) }));
vi.mock('./dispatcher/dispatcher-service', () => ({ isDispatcherEnabled: () => true, onDispatcherChanged: () => () => {} }));
vi.mock('./annex-device-signal', () => ({ onDevicesChanged: () => () => {}, onDevicePresenceChanged: () => () => {} }));
vi.mock('./annex-network-membership', () => ({
  currentView: () => ({ members: [], removals: world.removals[world.current] ?? [] }),
  ownPairing: () => (world.paired[world.current] ? { id: 'p', joinedAt: new Date(0).toISOString() } : undefined),
  onMembershipChanged: (listener: () => void) => {
    const machine = world.current;
    (world.membership[machine] ??= []).push(listener);
    return () => { world.membership[machine] = world.membership[machine].filter((l) => l !== listener); };
  },
}));

type Lead = typeof import('./dispatcher-federation-lead');
const machines = new Map<string, Lead>();
const online = new Set<string>();
const pushed = new Set<string>();

/** Runs `fn` as `machine`, so every mock answers for it. */
async function on<T>(machine: string, fn: (lead: Lead) => T | Promise<T>): Promise<T> {
  const before = world.current;
  world.current = machine;
  try { return await fn(machines.get(machine)!); } finally { world.current = before; }
}

const peer = (id: string, kind = 'desktop', role = 'member'): Peer => ({ fingerprint: id.toUpperCase(), alias: id.toUpperCase(), role, kind });

async function boot(ids: string[]) {
  for (const id of ids) {
    world.current = id;
    vi.resetModules();
    const lead = await import('./dispatcher-federation-lead');
    machines.set(id, lead);
    world.peers[id] = ids.filter((o) => o !== id).map((o) => peer(o));
    world.paired[id] = true;
    lead.startDispatcherLead({ push: () => { pushed.add(id); }, connected: (m) => online.has(m) });
    online.add(id);
  }
  world.current = '';
}

/** The connection exchange between two computers: request one way, answer back. */
async function exchange(a: string, b: string) {
  if (!online.has(a) || !online.has(b)) return;
  const request = await on(a, (l) => l.leadShare());
  await on(b, (l) => l.learnLeadShare(a.toUpperCase(), request));
  const answer = await on(b, (l) => l.leadShare());
  await on(a, (l) => l.learnLeadShare(b.toUpperCase(), answer));
}

/** Runs every push until nothing changes, the way syncDirectionsWith would. */
async function settle() {
  for (let i = 0; i < 20 && pushed.size > 0; i++) {
    const from = [...pushed];
    pushed.clear();
    for (const a of from) for (const b of machines.keys()) if (a !== b) await exchange(a, b);
  }
}

const record = (machine: string) => on(machine, (l) => l.leadRecord());
const state = (machine: string) => on(machine, (l) => l.getLeadState());

beforeEach(() => {
  world.files.clear();
  world.peers = {}; world.removals = {}; world.paired = {}; world.membership = {};
  machines.clear(); online.clear(); pushed.clear();
});

describe('the lead record (#3351)', () => {
  it('orders by counter, then time, then machine, the same way from either side', () => {
    const at = (rev: number, ms: number, by: string): LeadRecord => ({ v: 1, lead: null, rev, changedAt: new Date(ms).toISOString(), by });
    expect(compareLeadRecords(at(2, 0, 'a'), at(1, 9_999_999, 'z'))).toBeGreaterThan(0);
    expect(compareLeadRecords(at(1, 2, 'a'), at(1, 1, 'z'))).toBeGreaterThan(0);
    expect(compareLeadRecords(at(1, 1, 'b'), at(1, 1, 'a'))).toBeGreaterThan(0);
    expect(Math.sign(compareLeadRecords(at(1, 1, 'a'), at(1, 1, 'b')))).toBe(-Math.sign(compareLeadRecords(at(1, 1, 'b'), at(1, 1, 'a'))));
  });

  it('reads only well-formed records', () => {
    const ok = { v: 1, lead: 'ABC', rev: 3, changedAt: '2026-11-13T10:00:00.000Z', by: 'DEF' };
    expect(readLeadRecord(ok)).toEqual({ ...ok, lead: 'abc', by: 'def' });
    expect(readLeadRecord(NO_LEAD)).toEqual(NO_LEAD);
    for (const bad of [null, 'x', { ...ok, v: 2 }, { ...ok, rev: -1 }, { ...ok, rev: 1.5 }, { ...ok, lead: 'a@b' }, { ...ok, lead: 7 },
      { ...ok, changedAt: 'soon' }, { ...ok, by: '' }, { ...ok, lead: 'x'.repeat(201) }, { ...ok, clearedFor: { machine: 'a' } }]) {
      expect(readLeadRecord(bad)).toBeUndefined();
    }
  });
});

describe('choosing a lead across three computers (#3351)', () => {
  it('spreads a choice made on one member to every member, which all confirm it', async () => {
    await boot(['a', 'b', 'c']);
    await on('a', (l) => l.chooseLead('B'));
    await settle();
    for (const m of ['a', 'b', 'c']) expect((await record(m)).lead).toBe('b');
    expect((await state('b')).role).toBe('lead');
    expect((await state('c')).role).toBe('follower');
    const a = await state('a');
    expect(a).toMatchObject({ role: 'follower', lead: { machine: 'b', name: 'B' }, confirmedBy: ['B', 'C'], waitingOn: [], changedByName: 'A' });
  });

  it('a member that was off catches up when it reconnects, from any member', async () => {
    await boot(['a', 'b', 'c']);
    online.delete('c');
    await on('a', (l) => l.chooseLead('A'));
    await settle();
    expect((await record('c')).lead).toBeNull();
    expect((await state('a')).waitingOn).toEqual(['C']);
    // C comes back where it can reach only B; B passes on what A chose.
    online.add('c');
    online.delete('a');
    await exchange('c', 'b');
    expect((await record('c')).lead).toBe('a');
  });

  it('two choices made at once settle on the same lead everywhere', async () => {
    await boot(['a', 'b', 'c']);
    await on('a', (l) => l.chooseLead('B', 1_000));
    await on('c', (l) => l.chooseLead('C', 2_000));
    pushed.add('a'); pushed.add('c');
    await settle();
    const leads = await Promise.all(['a', 'b', 'c'].map(async (m) => (await record(m)).lead));
    expect(new Set(leads)).toEqual(new Set(['c']));
    // Same counter and the same time: the machine id decides, still the same everywhere.
    await on('a', (l) => l.chooseLead('A', 5_000));
    await on('b', (l) => l.chooseLead('B', 5_000));
    pushed.add('a'); pushed.add('b');
    await settle();
    const tied = await Promise.all(['a', 'b', 'c'].map(async (m) => (await record(m)).lead));
    expect(new Set(tied)).toEqual(new Set(['b']));
  });

  it('a later choice wins even when the earlier one was made on a clock far ahead', async () => {
    await boot(['a', 'b']);
    const hourAhead = Date.parse('2026-11-13T11:00:00Z');
    await on('a', (l) => l.chooseLead('A', hourAhead));
    await settle();
    await on('b', (l) => l.chooseLead('B', hourAhead - 3_600_000));
    await settle();
    expect((await record('a')).lead).toBe('b');
    expect((await record('b')).lead).toBe('b');
  });

  it('None returns every member to peers', async () => {
    await boot(['a', 'b']);
    await on('a', (l) => l.chooseLead('B'));
    await settle();
    await on('b', (l) => l.chooseLead(null));
    await settle();
    expect((await state('a'))).toMatchObject({ role: 'peer', lead: null, clearedFor: null });
  });

  it('refuses a computer outside the network, a phone, and a choice with no other computer', async () => {
    await boot(['a', 'b']);
    world.peers.a.push(peer('phone', 'phone'), peer('sat', 'desktop', 'satellite'));
    await expect(on('a', (l) => l.chooseLead('ZZZ'))).rejects.toThrow('isn’t in this Annex Network');
    await expect(on('a', (l) => l.chooseLead('PHONE'))).rejects.toThrow('isn’t in this Annex Network');
    world.peers.a = [];
    await expect(on('a', (l) => l.chooseLead('A'))).rejects.toThrow('isn’t in an Annex Network with another computer');
    expect((await state('a')).available).toBe(false);
  });

  it('drops a record whose authenticated pairing ended before it committed', async () => {
    await boot(['a', 'b']);
    const record = { lead: { v: 1, lead: 'b', rev: 5, changedAt: new Date().toISOString(), by: 'b' } };
    await on('a', (l) => l.learnLeadShare('B', record, { epoch: { sender: 'x', receiver: 'y' }, current: () => false }));
    expect((await state('a')).lead).toBeNull();
    await on('a', (l) => l.learnLeadShare('B', record, { epoch: { sender: 'x', receiver: 'y' }, current: () => true }));
    expect((await state('a')).lead?.machine).toBe('b');
  });

  it('ignores a record from a phone, a one-to-one pairing or a stranger', async () => {
    await boot(['a', 'b']);
    world.peers.a.push(peer('phone', 'phone'), peer('sat', 'desktop', 'satellite'));
    const forged = { lead: { v: 1, lead: 'phone', rev: 99, changedAt: new Date().toISOString(), by: 'phone' } };
    for (const from of ['PHONE', 'SAT', 'STRANGER']) await on('a', (l) => l.learnLeadShare(from, forged));
    expect((await record('a')).rev).toBe(0);
  });
});

describe('when the lead’s computer leaves (#3351)', () => {
  it('every member goes back to peers and names the computer that left', async () => {
    await boot(['a', 'b', 'c']);
    await on('a', (l) => l.chooseLead('C'));
    await settle();
    // C is removed: A sees it first and tells B.
    world.peers.a = [peer('b')];
    world.removals.a = [{ fingerprint: 'C', removedAt: new Date().toISOString() }];
    await on('a', async () => { for (const listener of world.membership.a) listener(); });
    await vi.waitFor(async () => expect((await record('a')).lead).toBeNull());
    machines.delete('c');
    await settle();
    for (const m of ['a', 'b']) {
      expect(await state(m)).toMatchObject({ role: 'peer', lead: null, clearedFor: 'C' });
    }
  });

  it('in a two-computer network, still says the lead left once it was the only other computer', async () => {
    await boot(['a', 'b']);
    await on('a', (l) => l.chooseLead('B'));
    await settle();
    world.peers.a = [];
    world.removals.a = [{ fingerprint: 'B', removedAt: new Date().toISOString() }];
    await on('a', (l) => l.reconcileMembership());
    expect(await state('a')).toMatchObject({ available: true, canChoose: false, role: 'peer', clearedFor: 'B' });
  });

  it('a lead that is only offline stays the lead', async () => {
    await boot(['a', 'b']);
    await on('a', (l) => l.chooseLead('B'));
    await settle();
    online.delete('b');
    await on('a', (l) => l.reconcileMembership());
    expect(await state('a')).toMatchObject({ role: 'follower', lead: { machine: 'b', online: false } });
  });

  it('a computer that leaves the network forgets the record, so it can’t overrule its next network', async () => {
    await boot(['a', 'b']);
    await on('a', (l) => l.chooseLead('B'));
    await settle();
    world.peers.a = [];
    world.paired.a = false;
    await on('a', (l) => l.reconcileMembership());
    expect(await record('a')).toEqual(NO_LEAD);
  });
});

describe('no agent can change the lead (#3351)', () => {
  it('only the Settings IPC handler chooses one, and no MCP tool imports the lead module', () => {
    const root = path.resolve(__dirname, '..');
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) sources.push(full);
      }
    };
    walk(root);
    const callers = sources.filter((f) => /\bchooseLead\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f).split(path.sep).join('/')).sort();
    expect(callers).toEqual(['ipc/dispatcher-handlers.ts', 'services/dispatcher-federation-lead.ts']);
    const tools = sources.filter((f) => f.split(path.sep).join('/').includes('/clubhouse-mcp/')
      && fs.readFileSync(f, 'utf8').includes('dispatcher-federation-lead'));
    expect(tools).toEqual([]);
  });
});

describe('Take back (#3353)', () => {
  it('changes only the computer that takes back, lasts until a new choice, and can be undone', async () => {
    await boot(['a', 'b', 'c']);
    await on('a', (l) => l.chooseLead('B'));
    await settle();
    await on('c', (l) => l.takeBackFromLead());
    expect(await state('c')).toMatchObject({ role: 'follower', following: false, tookBack: true });
    expect(await state('a')).toMatchObject({ following: true, tookBack: false });
    expect((await record('b')).lead).toBe('b');
    // It never travels: B and A still see C as having the same record.
    await settle();
    expect((await state('a')).confirmedBy).toEqual(['B', 'C']);
    await on('c', (l) => l.followLeadAgain());
    expect(await state('c')).toMatchObject({ following: true, tookBack: false });
    // A new choice follows again, on its own.
    await on('c', (l) => l.takeBackFromLead());
    await on('a', (l) => l.chooseLead('A'));
    await settle();
    expect(await state('c')).toMatchObject({ role: 'follower', following: true, tookBack: false, lead: { machine: 'a' } });
  });

  it('is refused on the lead and on peers, and nothing takes back while the lead is offline', async () => {
    await boot(['a', 'b']);
    await expect(on('a', (l) => l.takeBackFromLead())).rejects.toThrow('isn’t following');
    await on('a', (l) => l.chooseLead('A'));
    await settle();
    await expect(on('a', (l) => l.takeBackFromLead())).rejects.toThrow('isn’t following');
    online.delete('a');
    await on('b', (l) => l.reconcileMembership());
    expect(await state('b')).toMatchObject({ role: 'follower', following: true, lead: { machine: 'a', online: false } });
  });
});
