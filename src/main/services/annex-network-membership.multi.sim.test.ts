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
  setUnknownPeerReasonProvider: vi.fn(),
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

it.each([false, true])('a phone introduction waits for both computers, including after identity reset (%s)', (reset) => {
  const PHONE_FP = fp('0f');
  // C is the existing Mac, A the new (or reset) Mac. X represents A's old identity.
  network(reset ? ['C', 'X'] : ['C']);
  for (const n of ['A', 'C'] as Name[]) as(n, () => {
    worlds[n].peers.set(PHONE_FP, { ...peer('P', T0, n), fingerprint: PHONE_FP, publicKey: `key-${PHONE_FP}`, kind: 'phone' });
    worlds[n].mod!.ensureOwnPairing();
  });
  const mini = as('C', () => self('C'));
  const fresh = as('A', () => self('A'));
  as('A', () => worlds.A.mod!.vouchFromPhone(PHONE_FP, [mini]));
  flush();
  expect(worlds.A.peers.get(FPS.C)?.networkPending).toBe(true);
  expect(has('C', 'A')).toBe(false);
  // The phone isn't connected to C yet. Reconnecting the membership channel alone cannot finish.
  open('A', 'C');
  expect(worlds.A.peers.get(FPS.C)?.networkPending).toBe(true);
  if (reset) expect(has('C', 'X')).toBe(true);
  // The existing phone contract's third step finally reaches C with A's new record.
  as('C', () => worlds.C.mod!.vouchFromPhone(PHONE_FP, [fresh]));
  open('A', 'C');
  expect(worlds.A.peers.get(FPS.C)?.networkPending).toBeUndefined();
  expect(worlds.C.peers.get(FPS.A)?.networkPending).toBeUndefined();
  expect(worlds.C.peers.get(FPS.A)?.pairingId).toBe(fresh.pairingId);
  expect(worlds.A.peers.get(FPS.C)?.pairingId).toBe(mini.pairingId);
});

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

/**
 * Two desktops pair as the app does it (annex-client asks, annex-server answers): the client offers its
 * pairing, the server keeps it or makes one, starts its own if it has none, and answers with both.
 */
function pairDesktops(client: Name, server: Name) {
  const offered = as(client, () => worlds[client].mod!.ownPairing());
  const joiner = as(server, () => worlds[server].mod!.pairingForJoiner(FPS[client], offered));
  const own = as(server, () => worlds[server].mod!.ensureOwnPairing());
  as(server, () => { worlds[server].peers.set(FPS[client], peer(client, joiner.joinedAt, server, joiner.id)); worlds[server].mod!.noteLocalJoin(FPS[client]); });
  as(client, () => {
    worlds[client].peers.set(FPS[server], peer(server, own.joinedAt, client, own.id));
    worlds[client].mod!.adoptOwnPairing(joiner);
    worlds[client].mod!.noteLocalJoin(FPS[server]);
  });
}

const selfOf = (n: Name) => as(n, () => worlds[n].mod!.ownPairing());
const removeOn = (who: Name, gone: Name) => as(who, () => { worlds[who].mod!.noteLocalRemoval(FPS[gone]); worlds[who].peers.delete(FPS[gone]); });
const offline = (n: Name) => { for (const o of NAMES) if (o !== n) down.add(linkKey(n, o)); };

describe('four desktops (#3107)', () => {
  it('a new desktop pairing with a member doesn\'t move that member\'s pairing, so a removal from a member that missed it still takes everywhere', () => {
    network(['P', 'A', 'C']);
    offline('C');
    pairDesktops('X', 'P');
    open('P', 'X'); open('P', 'A'); open('A', 'X');
    for (const n of ['A', 'X'] as Name[]) expect(as(n, () => worlds[n].peers.get(FPS.P))).toMatchObject({ pairedAt: T0, pairingId: PAIRING.P });
    // C wakes, and the person removes P there before C has heard anything.
    removeOn('C', 'P');
    down.clear();
    open('C', 'A'); open('C', 'X');
    for (const n of ['C', 'A', 'X'] as Name[]) expect(has(n, 'P')).toBe(false);
  });

  it('an existing member pairing as the client with a new desktop keeps its pairing (it says which it has)', () => {
    network(['P', 'A', 'C']);
    offline('C');
    pairDesktops('P', 'X');
    open('P', 'X'); open('P', 'A'); open('A', 'X');
    expect(selfOf('P')).toEqual({ id: PAIRING.P, joinedAt: T0 });
    for (const n of ['A', 'X'] as Name[]) expect(as(n, () => worlds[n].peers.get(FPS.P)?.pairingId)).toBe(PAIRING.P);
    removeOn('C', 'P');
    down.clear();
    open('C', 'A'); open('C', 'X');
    for (const n of ['C', 'A', 'X'] as Name[]) expect(has(n, 'P')).toBe(false);
  });

  it('a new desktop pairing as the client gets one pairing, the one the member made, and a removal of it takes everywhere', () => {
    network(['P', 'A', 'C']);
    pairDesktops('X', 'P');
    open('P', 'X');
    // A hears of X from P, then is cut off.
    open('P', 'A');
    expect(selfOf('X')?.id).toBe(as('P', () => worlds.P.peers.get(FPS.X)?.pairingId));
    expect(as('A', () => worlds.A.peers.get(FPS.X)?.pairingId)).toBe(selfOf('X')?.id);
    removeOn('A', 'X');
    open('A', 'P'); open('A', 'C');
    expect(has('P', 'X')).toBe(false);
    expect(has('C', 'X')).toBe(false);
  });

  it('a device paired again on a computer with a slow clock keeps its new pairing', () => {
    network(['P', 'A', 'C']);
    offline('P');
    removeOn('A', 'P');
    open('A', 'C');
    expect(has('C', 'P')).toBe(false);
    // P, which was off, pairs again with C moments later; C's clock is a minute behind A's.
    const removedAt = as('A', () => worlds.A.mod!.currentView().removals[0].removedAt);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(Date.parse(removedAt) - 60_000));
      down.clear();
      pairDesktops('P', 'C');
    } finally {
      vi.useRealTimers();
    }
    open('P', 'C'); open('A', 'C'); open('A', 'P');
    for (const n of ['C', 'A'] as Name[]) expect(has(n, 'P')).toBe(true);
    expect(worlds.P.ended).toEqual([]);
  });

  it('a removed machine paired again as the server keeps its new pairing', () => {
    network(['P', 'A', 'C']);
    removeOn('A', 'P');
    flush();
    // P heard it and left; its pairing ended with it.
    expect(selfOf('P')).toBeUndefined();
    expect(has('C', 'P')).toBe(false);
    pairDesktops('C', 'P');
    open('C', 'P');
    open('A', 'C');
    expect(has('C', 'P')).toBe(true);
    expect(has('A', 'P')).toBe(true);
  });

  it('a machine removed while off, paired again as the client, doesn\'t leave when the old removal reaches it first', () => {
    network(['P', 'A', 'C']);
    offline('P');
    removeOn('A', 'P');
    open('A', 'C');
    down.clear();
    down.add(linkKey('P', 'C'));
    pairDesktops('P', 'C');
    // A's view, with the old removal, reaches P before C's does.
    as('P', () => worlds.P.listener!(FPS.A, { v: 1, type: 'members', ...as('A', () => worlds.A.provider!()) }));
    expect(worlds.P.ended).toEqual([]);
    down.clear();
    open('P', 'C');
    expect(has('C', 'P')).toBe(true);
  });

  it('a phone joining a new desktop to the network leaves every member\'s pairing as it is', () => {
    network(['P', 'A', 'C']);
    // The phone is a member of P, and pairs with new desktop Y, then vouches P's view to it.
    const PHONE_FP = fp('0f');
    as('X', () => {
      worlds.X.peers.set(PHONE_FP, { ...peer('P', T0, 'X', 'pairing-phone-001'), fingerprint: PHONE_FP, kind: 'phone', alias: 'Phone' });
      worlds.X.mod!.ensureOwnPairing();
    });
    const view = as('P', () => worlds.P.provider!()) as { members: Array<{ fingerprint: string }> };
    as('X', () => worlds.X.mod!.vouchFromPhone(PHONE_FP, view.members as never));
    for (const n of ['P', 'A', 'C'] as Name[]) expect(as('X', () => worlds.X.peers.get(FPS[n])?.pairingId)).toBe(PAIRING[n]);
    offline('C');
    open('X', 'P'); open('X', 'A');
    for (const n of ['P', 'A', 'C'] as Name[]) expect(selfOf(n)?.id).toBe(PAIRING[n]);
    removeOn('C', 'P');
    down.clear();
    open('C', 'A'); open('C', 'X');
    for (const n of ['C', 'A', 'X'] as Name[]) expect(has(n, 'P')).toBe(false);
  });

  it('a member phone pairing with a new desktop offers its kept pairing, so a removal of it made elsewhere still takes', () => {
    network(['P', 'A', 'C']);
    // The phone is a member on P, A and C with one pairing; it keeps that pairing from its first answer.
    const PHONE_FP = fp('0f');
    const phonePairing = { id: 'pairing-phone-001', joinedAt: T0 };
    const phonePeer = (owner: Name) => ({ ...peer('P', T0, owner, phonePairing.id), fingerprint: PHONE_FP, publicKey: `key-${PHONE_FP}`, kind: 'phone', alias: 'Phone' });
    for (const n of ['P', 'A', 'C'] as Name[]) as(n, () => worlds[n].peers.set(PHONE_FP, phonePeer(n)));
    // It pairs with new desktop X, sending its kept pairing: X keeps it.
    const joined = as('X', () => worlds.X.mod!.pairingForJoiner(PHONE_FP, phonePairing));
    expect(joined).toEqual(phonePairing);
    as('X', () => { worlds.X.peers.set(PHONE_FP, phonePeer('X')); worlds.X.mod!.ensureOwnPairing(); });
    const view = as('P', () => worlds.P.provider!()) as { members: unknown[] };
    as('X', () => worlds.X.mod!.vouchFromPhone(PHONE_FP, view.members as never));
    offline('C');
    open('X', 'P'); open('X', 'A');
    for (const n of ['P', 'A', 'X'] as Name[]) expect(as(n, () => worlds[n].peers.get(PHONE_FP)?.pairingId)).toBe(phonePairing.id);
    as('C', () => { worlds.C.mod!.noteLocalRemoval(PHONE_FP); worlds.C.peers.delete(PHONE_FP); });
    down.clear();
    open('C', 'A'); open('C', 'X'); open('C', 'P');
    for (const n of ['P', 'A', 'C', 'X'] as Name[]) expect(as(n, () => worlds[n].peers.has(PHONE_FP))).toBe(false);
  });

  it('a machine that learns of its removal inside a view takes nothing else from it', () => {
    network(['P', 'A', 'C']);
    offline('P');
    removeOn('A', 'P');
    // A's view, with the removal of P, reaches P.
    as('P', () => worlds.P.listener!(FPS.A, { v: 1, type: 'members', ...as('A', () => worlds.A.provider!()) }));
    expect(worlds.P.ended.sort()).toEqual(['A', 'C']);
    expect(has('P', 'A')).toBe(false);
    expect(has('P', 'C')).toBe(false);
    expect(selfOf('P')).toBeUndefined();
  });

  it('a removed machine leaves quietly: a member that hadn\'t heard of the removal stays', () => {
    network(['A', 'C', 'X']);
    down.add(linkKey('A', 'C'));
    removeOn('A', 'X');
    flush();
    expect(worlds.X.ended.sort()).toEqual(['A', 'C']);
    expect(worlds.C.ended).toEqual([]);
    expect(has('C', 'A')).toBe(true);
  });
});
