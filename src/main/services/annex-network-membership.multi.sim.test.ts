/**
 * Four desktops gossiping membership (#3107, #3061): each machine runs its own
 * copy of the membership module with its own peers and stored state, and
 * messages go through an outbox that a test can cut between any two machines.
 * Kept from the review that found join times moving between members.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fp = (n: string) => Array.from({ length: 16 }, () => n).join(':');
const cert = (n: string) => Array.from({ length: 32 }, () => n).join(':');
type Name = 'P' | 'A' | 'C' | 'X';
const NAMES: Name[] = ['P', 'A', 'C', 'X'];
const CODE: Record<Name, string> = { P: '0a', A: '0b', C: '0c', X: '0d' };
const FPS = Object.fromEntries(NAMES.map((n) => [n, fp(CODE[n])])) as Record<Name, string>;
const nameOf = (f: string) => NAMES.find((n) => FPS[n] === f.toLowerCase())!;

interface World {
  peers: Map<string, Record<string, unknown>>;
  stored: Record<string, unknown>;
  listener: ((from: string, message: unknown) => void) | null;
  provider: (() => { members: unknown[]; removals: unknown[] }) | null;
  selfPairing: (() => { id: string; joinedAt: string } | undefined) | null;
  mod?: typeof import('./annex-network-membership');
  ended: Name[];
}
const worlds = Object.fromEntries(NAMES.map((n) => [n, { peers: new Map(), stored: {}, listener: null, provider: null, selfPairing: null, ended: [] }])) as unknown as Record<Name, World>;
let current: Name = 'P';
const down = new Set<string>();
const linkKey = (a: Name, b: Name) => [a, b].sort().join('-');
const outbox: Array<{ to: Name; from: Name; message: unknown }> = [];
function as<T>(who: Name, fn: () => T): T { const was = current; current = who; try { return fn(); } finally { current = was; } }

vi.mock('./settings-store', () => ({
  createSettingsStore: (_f: string, d: unknown) => ({
    get: () => (Object.keys(worlds[current].stored).length ? worlds[current].stored : d),
    save: (v: unknown) => { worlds[current].stored = JSON.parse(JSON.stringify(v)); },
  }),
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-device-signal', () => ({ devicesChanged: vi.fn() }));
vi.mock('./annex-settings', () => ({ getSettings: () => ({ enableClient: true }), networkEnabled: () => true }));
vi.mock('./annex-identity', () => ({ getIdentity: () => ({ fingerprint: FPS[current] }), computeFingerprint: (k: string) => (k.startsWith('key-') ? k.slice(4) : 'nope') }));
vi.mock('./annex-tls', () => ({
  certificateFingerprint: (pem: string) => pem.replace('PEM-', ''),
  sameCertificateFingerprint: (a?: string, b?: string) => !!a && a.toLowerCase() === b?.toLowerCase(),
}));
vi.mock('./annex-peers', () => ({
  listPeers: () => [...worlds[current].peers.values()],
  getPeer: (f: string) => worlds[current].peers.get(f.toLowerCase()),
  addPeer: (p: { fingerprint: string }) => { worlds[current].peers.set(p.fingerprint.toLowerCase(), { ...p }); },
  peerNeedsPairing: (p: { role?: string; tlsCertificateFingerprint?: string }) => !p.role || !p.tlsCertificateFingerprint,
}));
vi.mock('./annex-network-channel', () => ({
  localMember: () => self(current),
  setMembersProvider: (p: World['provider']) => { worlds[current].provider = p; },
  setSelfPairingProvider: (p: World['selfPairing']) => { worlds[current].selfPairing = p; },
  onNetworkMessage: (l: World['listener']) => { worlds[current].listener = l; return () => {}; },
  broadcast: (message: unknown, to: (f: string) => boolean = () => true) => {
    const from = current;
    for (const who of NAMES) if (who !== from && to(FPS[who]) && !down.has(linkKey(from, who))) outbox.push({ to: who, from, message });
    return 1;
  },
}));

const IDENTITY_CREATED = '2026-01-01T00:00:00.000Z';

function record(n: Name, joinedAt: string, pairingId?: string) {
  return {
    fingerprint: FPS[n], publicKey: `key-${FPS[n]}`, certFingerprint: cert(CODE[n]), certPem: `PEM-${cert(CODE[n])}`,
    name: n, icon: 'computer', color: 'indigo', kind: 'desktop' as const, hosts: ['127.0.0.1'], port: 9443, joinedAt,
    ...(pairingId && { pairingId }),
  };
}

/** This machine's own record, as the channel builds it: its pairing once known, else its identity's age. */
function self(n: Name) {
  const pairing = worlds[n].selfPairing?.();
  return pairing ? record(n, pairing.joinedAt, pairing.id) : record(n, IDENTITY_CREATED);
}

function peer(n: Name, pairedAt: string, addedBy: Name, pairingId?: string) {
  const m = record(n, pairedAt, pairingId);
  return {
    fingerprint: m.fingerprint, publicKey: m.publicKey, alias: n, icon: 'computer', color: 'indigo', pairedAt, lastSeen: '', role: 'member',
    kind: 'desktop', addedBy: FPS[addedBy], tlsCertificateFingerprint: m.certFingerprint, tlsCertificatePem: m.certPem, knownHosts: m.hosts, mainPort: m.port,
    ...(pairingId && { pairingId }),
  };
}

function flush() {
  for (let i = 0; i < 500 && outbox.length; i++) {
    const { to, from, message } = outbox.shift()!;
    if (down.has(linkKey(from, to))) continue;
    as(to, () => worlds[to].listener?.(FPS[from], message));
  }
}

/** The channel opens between two machines that have each other as members: a hello and a view each way. */
function open(a: Name, b: Name) {
  for (const [from, to] of [[a, b], [b, a]] as Array<[Name, Name]>) {
    if (!as(to, () => worlds[to].peers.has(FPS[from]))) continue;
    outbox.push({ to, from, message: { v: 1, type: 'hello', member: as(from, () => self(from)) } });
    outbox.push({ to, from, message: { v: 1, type: 'members', ...as(from, () => worlds[from].provider!()) } });
  }
  flush();
}

const has = (who: Name, other: Name) => as(who, () => worlds[who].peers.has(FPS[other]));

beforeEach(async () => {
  outbox.length = 0;
  down.clear();
  for (const n of NAMES) {
    const w = worlds[n];
    w.peers.clear(); w.stored = {}; w.ended = [];
    vi.resetModules();
    current = n;
    w.mod = await import('./annex-network-membership');
    // As the app ends a device: its pairing goes, which records a removal unless the machine is leaving.
    w.mod.initNetworkMembership({
      connect: () => {},
      endDevice: (f: string) => as(n, () => { w.ended.push(nameOf(f)); w.mod!.noteLocalRemoval(f); w.peers.delete(f.toLowerCase()); }),
    });
  }
});

const T0 = '2026-11-01T09:00:00.000Z';
const PAIRING: Record<Name, string> = { P: 'pairing-p-000001', A: 'pairing-a-000001', C: 'pairing-c-000001', X: 'pairing-x-000001' };

/** Every machine in `names` has every other as a member, with that member's one pairing. */
function network(names: Name[]) {
  for (const a of names) for (const b of names) if (a !== b) as(a, () => worlds[a].peers.set(FPS[b], peer(b, T0, a, PAIRING[b])));
  for (const n of names) worlds[n].stored = { removals: [], confirmations: {}, renamedAt: {}, removedNames: {}, selfPairing: { id: PAIRING[n], joinedAt: T0 } };
}

describe('four desktops (#3107)', () => {
  it('a new desktop pairing with a member doesn\'t move that member\'s pairing, so a removal from a member that missed it still takes everywhere', () => {
    network(['P', 'A', 'C']);
    // C is off.
    down.add(linkKey('C', 'P')); down.add(linkKey('C', 'A')); down.add(linkKey('C', 'X'));
    // X pairs with P. P makes X's pairing; X stamps P with its own clock and no id until P's own record arrives.
    as('P', () => { worlds.P.peers.set(FPS.X, peer('X', '2026-11-08T10:00:00.000Z', 'P', PAIRING.X)); worlds.P.mod!.noteLocalJoin(FPS.X); });
    as('X', () => { worlds.X.peers.set(FPS.P, peer('P', '2026-11-08T10:00:01.000Z', 'X')); worlds.X.mod!.noteLocalJoin(FPS.P); });
    open('P', 'X'); open('P', 'A'); open('A', 'X');
    // Everyone has P's one pairing, X included.
    expect(as('A', () => worlds.A.peers.get(FPS.P))).toMatchObject({ pairedAt: T0, pairingId: PAIRING.P });
    expect(as('X', () => worlds.X.peers.get(FPS.P))).toMatchObject({ pairedAt: T0, pairingId: PAIRING.P });
    // C wakes, and the person removes P there before C has heard anything.
    as('C', () => { worlds.C.mod!.noteLocalRemoval(FPS.P); worlds.C.peers.delete(FPS.P); });
    down.clear();
    open('C', 'A'); open('C', 'X');
    expect(has('C', 'P')).toBe(false);
    expect(has('A', 'P')).toBe(false);
    expect(has('X', 'P')).toBe(false);
  });

  it('a device paired again on a computer with a slow clock keeps its new pairing', () => {
    network(['P', 'A', 'C']);
    // P is removed on A.
    as('A', () => { worlds.A.mod!.noteLocalRemoval(FPS.P); worlds.A.peers.delete(FPS.P); });
    open('A', 'C');
    expect(has('C', 'P')).toBe(false);
    // Then paired again on C moments later, but C's clock runs behind A's: the new pairing is stamped before A's
    // removal (which carries A's clock), though after the pairing that removal ended.
    const removedAt = as('A', () => worlds.A.mod!.currentView().removals[0].removedAt);
    const stamped = new Date(Date.parse(removedAt) - 60_000).toISOString();
    as('C', () => { worlds.C.peers.set(FPS.P, peer('P', stamped, 'C', 'pairing-p-000002')); worlds.C.mod!.noteLocalJoin(FPS.P); });
    open('A', 'C');
    expect(has('C', 'P')).toBe(true);
    expect(has('A', 'P')).toBe(true);
  });

  it('a removed machine leaves quietly: a member that hadn\'t heard of the removal stays', () => {
    network(['A', 'C', 'X']);
    // A can't reach C directly.
    down.add(linkKey('A', 'C'));
    as('A', () => { worlds.A.mod!.noteLocalRemoval(FPS.X); worlds.A.peers.delete(FPS.X); });
    flush();
    expect(worlds.X.ended.sort()).toEqual(['A', 'C']);
    expect(worlds.C.ended).toEqual([]);
    expect(has('C', 'A')).toBe(true);
  });
});
