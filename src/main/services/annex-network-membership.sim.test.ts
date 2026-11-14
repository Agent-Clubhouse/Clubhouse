/**
 * Two real membership instances (desktops A and B) wired by a fake membership
 * channel, with a third member F known only as data: the same steps as
 * e2e/annex-v2/network-join.spec.ts, so convergence is checked without Electron.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnnexPeer } from '../../shared/types';
import { parseNetworkMessage, type NetworkMember, type NetworkMessage } from '../../shared/annex-network-protocol';
import { reachCandidates } from './annex-reach';

const fp = (n: string) => Array.from({ length: 16 }, () => n).join(':');
const cert = (n: string) => Array.from({ length: 32 }, () => n).join(':');

type Name = 'A' | 'B';
const FPS: Record<Name, string> = { A: fp('0a'), B: fp('0b') };

interface World {
  peers: Map<string, AnnexPeer>;
  stored: Record<string, unknown>;
  listener: ((from: string, m: NetworkMessage) => void) | null;
  provider: (() => unknown) | null;
}
const worlds: Record<Name, World> = {
  A: { peers: new Map(), stored: {}, listener: null, provider: null },
  B: { peers: new Map(), stored: {}, listener: null, provider: null },
};
let current: Name = 'A';
const online: Record<Name, boolean> = { A: true, B: true };
const outbox: Array<{ to: Name; from: Name; message: NetworkMessage }> = [];

function as<T>(who: Name, fn: () => T): T {
  const was = current;
  current = who;
  try { return fn(); } finally { current = was; }
}

vi.mock('./settings-store', () => ({
  createSettingsStore: (_f: string, defaults: Record<string, unknown>) => ({
    get: () => (Object.keys(worlds[current].stored).length ? worlds[current].stored : defaults),
    save: (v: Record<string, unknown>) => { worlds[current].stored = JSON.parse(JSON.stringify(v)); },
  }),
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-device-signal', () => ({ devicesChanged: vi.fn() }));
vi.mock('./annex-settings', () => ({ getSettings: vi.fn(() => ({ enableClient: true })), networkEnabled: vi.fn(() => true) }));
vi.mock('./annex-identity', () => ({
  getIdentity: vi.fn(() => ({ fingerprint: FPS[current] })),
  computeFingerprint: vi.fn((key: string) => (key.startsWith('key-') ? key.slice(4) : 'nope')),
}));
vi.mock('./annex-tls', () => ({
  certificateFingerprint: vi.fn((pem: string) => pem.replace('-----BEGIN CERTIFICATE-----PEM-', '')),
  sameCertificateFingerprint: (a?: string, b?: string) => !!a && a.toLowerCase() === b?.toLowerCase(),
}));
vi.mock('./annex-peers', () => ({
  listPeers: vi.fn(() => [...worlds[current].peers.values()]),
  getPeer: vi.fn((f: string) => worlds[current].peers.get(f.toLowerCase())),
  addPeer: vi.fn((p: AnnexPeer) => { worlds[current].peers.set(p.fingerprint.toLowerCase(), { ...p }); }),
  peerNeedsPairing: vi.fn((p: AnnexPeer) => !p.role || !p.tlsCertificateFingerprint),
}));
vi.mock('./annex-network-channel', () => ({
  setUnknownPeerReasonProvider: vi.fn(),
  localMember: vi.fn(() => member(FPS[current], current === 'A' ? '0a' : '0b', current, '2026-01-01T00:00:00.000Z')),
  setMembersProvider: vi.fn((p: () => unknown) => { worlds[current].provider = p; }),
  setSelfPairingProvider: vi.fn(),
  onNetworkMessage: vi.fn((l: (from: string, m: NetworkMessage) => void) => { worlds[current].listener = l; return () => {}; }),
  broadcast: vi.fn((message: NetworkMessage, to: (f: string) => boolean = () => true) => {
    const from = current;
    let n = 0;
    for (const who of ['A', 'B'] as Name[]) {
      if (who === from || !online[who] || !online[from] || !to(FPS[who])) continue;
      outbox.push({ to: who, from, message });
      n++;
    }
    return n;
  }),
}));

function member(f: string, c: string, name: string, joinedAt: string): NetworkMember {
  return { fingerprint: f, publicKey: `key-${f}`, certFingerprint: cert(c), certPem: `-----BEGIN CERTIFICATE-----PEM-${cert(c)}`,
    name, icon: 'computer', color: 'indigo', kind: 'desktop', hosts: ['127.0.0.1'], port: name === 'A' ? 9441 : name === 'B' ? 9442 : 9443, joinedAt };
}
function memberPeer(m: NetworkMember, addedBy: string): AnnexPeer {
  return { fingerprint: m.fingerprint, publicKey: m.publicKey, alias: m.name, icon: 'computer', color: 'indigo', pairedAt: m.joinedAt, lastSeen: '',
    role: 'member', kind: 'desktop', addedBy, tlsCertificateFingerprint: m.certFingerprint, tlsCertificatePem: m.certPem, knownHosts: m.hosts, mainPort: m.port };
}

/** Delivers queued messages until none are left. */
function flush(): void {
  for (let i = 0; i < 100 && outbox.length > 0; i++) {
    const { to, from, message } = outbox.shift()!;
    if (!online[to]) continue;
    const parsed = parseNetworkMessage(JSON.stringify(message));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) as(to, () => worlds[to].listener?.(FPS[from], parsed.message));
  }
}

/** A channel opening between the two: each sends hello and its view, as the channel does. */
function connect(): void {
  for (const [from, to] of [['A', 'B'], ['B', 'A']] as Array<[Name, Name]>) {
    const hello = as(from, () => member(FPS[from], from === 'A' ? '0a' : '0b', from, '2026-01-01T00:00:00.000Z'));
    outbox.push({ to, from, message: { v: 1, type: 'hello', member: hello } });
    const view = as(from, () => worlds[from].provider!()) as { members: NetworkMember[]; removals: Array<{ fingerprint: string; removedAt: string }> };
    outbox.push({ to, from, message: { v: 1, type: 'members', members: view.members, removals: view.removals } });
  }
  flush();
}

describe('membership between two desktops (simulating network-join.spec.ts)', () => {
  let membershipA: typeof import('./annex-network-membership');
  let membershipB: typeof import('./annex-network-membership');
  const hooks = (who: Name) => ({
    connect: vi.fn(),
    endDevice: vi.fn((f: string) => {
      // As the app's hooks do: revoke (which records a removal here if it's a member), then forget.
      as(who, () => {
        const mod = who === 'A' ? membershipA : membershipB;
        mod.noteLocalRemoval(f);
        worlds[who].peers.delete(f.toLowerCase());
        mod.noteLocalRemoval(f);
      });
    }),
  });

  beforeEach(async () => {
    for (const w of Object.values(worlds)) { w.peers.clear(); w.stored = {}; w.listener = null; w.provider = null; }
    outbox.length = 0;
    online.A = true; online.B = true;
    vi.resetModules();
    current = 'A';
    membershipA = await import('./annex-network-membership');
    membershipA.initNetworkMembership(hooks('A'));
    vi.resetModules();
    current = 'B';
    membershipB = await import('./annex-network-membership');
    membershipB.initNetworkMembership(hooks('B'));
    current = 'A';
    // A and B paired as members.
    const pairedAt = '2026-11-08T10:00:00.000Z';
    as('A', () => worlds.A.peers.set(FPS.B, memberPeer(member(FPS.B, '0b', 'B', pairedAt), FPS.A)));
    as('B', () => worlds.B.peers.set(FPS.A, memberPeer(member(FPS.A, '0a', 'A', pairedAt), FPS.B)));
  });

  it('a join through A reaches B when it comes back, and a removal on A is confirmed on both', () => {
    const F = fp('0e');
    // B goes off; F joins through A.
    online.B = false;
    const fJoin = member(F, '0e', 'Fake member', new Date().toISOString());
    as('A', () => { worlds.A.peers.set(F, memberPeer(fJoin, FPS.A)); membershipA.noteLocalJoin(F); });
    expect(as('A', () => membershipA.joinConfirmation(F))?.waitingOn).toEqual([FPS.B]);
    // B comes back.
    online.B = true;
    connect();
    expect(as('B', () => worlds.B.peers.get(F))).toMatchObject({ role: 'member' });
    expect(as('A', () => membershipA.joinConfirmation(F))?.waitingOn).toEqual([]);
    // F says hello to B with its own idea of when it joined, even one later than the removal to come.
    as('B', () => worlds.B.listener!(F, { v: 1, type: 'hello', member: member(F, '0e', 'Fake member', new Date(Date.now() + 60_000).toISOString()) }));
    // A removes F.
    as('A', () => { membershipA.noteLocalRemoval(F); worlds.A.peers.delete(F); });
    flush();
    expect(as('B', () => worlds.B.peers.has(F))).toBe(false);
    expect(as('B', () => membershipB.pendingRemovals())).toEqual([]);
    expect(as('A', () => membershipA.pendingRemovals())).toEqual([]);
  });

  it('passes F\'s self-announced loopback endpoint to B without borrowing another member\'s port', () => {
    const F = fp('0e');
    online.B = false;
    const fJoin = member(F, '0e', 'Fake member', new Date().toISOString());
    as('A', () => {
      // Like the E2E fake member, F pairs into A, then supplies its listening endpoint in its hello.
      worlds.A.peers.set(F, { ...memberPeer(fJoin, FPS.A), knownHosts: [], mainPort: undefined });
      membershipA.noteLocalJoin(F);
      worlds.A.listener!(F, { v: 1, type: 'hello', member: fJoin });
    });

    online.B = true;
    connect();
    const joined = worlds.B.peers.get(F)!;
    expect(joined.role).toBe('member');
    expect(reachCandidates({ known: joined.knownHosts, ports: joined.hostPorts, port: joined.mainPort })).toEqual([
      { host: '127.0.0.1', port: fJoin.port, source: 'known' },
    ]);
    expect(as('B', () => membershipB.currentView().members.find((m) => m.fingerprint === F))).toMatchObject({
      hosts: ['127.0.0.1'], port: 9443,
    });
  });
});
