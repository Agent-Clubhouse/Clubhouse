import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnnexPeer } from '../../shared/types';
import type { NetworkMember, NetworkMessage } from '../../shared/annex-network-protocol';

const fp = (n: string) => Array.from({ length: 16 }, () => n).join(':');
const cert = (n: string) => Array.from({ length: 32 }, () => n).join(':');
const SELF = fp('01');
const A = fp('0a');
const B = fp('0b');
const N = fp('0e');

const peers = new Map<string, AnnexPeer>();
let stored: Record<string, unknown> = {};
let listener: ((from: string, message: NetworkMessage) => void) | null = null;
const broadcasts: Array<{ message: NetworkMessage; to: string[] }> = [];
let open: string[] = [];

vi.mock('./settings-store', () => ({
  createSettingsStore: (_file: string, defaults: Record<string, unknown>) => ({
    get: () => (Object.keys(stored).length ? stored : defaults),
    save: (v: Record<string, unknown>) => { stored = JSON.parse(JSON.stringify(v)); },
  }),
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-device-signal', () => ({ devicesChanged: vi.fn() }));
vi.mock('./annex-settings', () => ({
  getSettings: vi.fn(() => ({ enableClient: true })),
  networkEnabled: vi.fn(() => true),
}));
vi.mock('./annex-identity', () => ({
  getIdentity: vi.fn(() => ({ fingerprint: SELF })),
  // A test key "key-<fp>" hashes to <fp>.
  computeFingerprint: vi.fn((key: string) => (key.startsWith('key-') ? key.slice(4) : 'nope')),
}));
vi.mock('./annex-tls', () => ({
  // A test certificate "PEM-<cert>" hashes to <cert>.
  certificateFingerprint: vi.fn((pem: string) => pem.replace('-----BEGIN CERTIFICATE-----PEM-', '')),
  sameCertificateFingerprint: (a?: string, b?: string) => !!a && a === b,
}));
vi.mock('./annex-peers', () => ({
  listPeers: vi.fn(() => [...peers.values()]),
  getPeer: vi.fn((f: string) => peers.get(f.toLowerCase())),
  addPeer: vi.fn((p: AnnexPeer) => { peers.set(p.fingerprint.toLowerCase(), { ...p }); }),
  peerNeedsPairing: vi.fn((p: AnnexPeer) => !p.role || !p.tlsCertificateFingerprint),
}));
vi.mock('./annex-network-channel', () => ({
  localMember: vi.fn(() => member(SELF, '01', 'This Mac')),
  setMembersProvider: vi.fn(),
  onNetworkMessage: vi.fn((l: (from: string, message: NetworkMessage) => void) => { listener = l; return () => { listener = null; }; }),
  broadcast: vi.fn((message: NetworkMessage, to: (f: string) => boolean = () => true) => {
    const reached = open.filter(to);
    broadcasts.push({ message, to: reached });
    return reached.length;
  }),
}));

import * as membership from './annex-network-membership';
import * as annexSettings from './annex-settings';

function member(f: string, c: string, name: string, extra: Partial<NetworkMember> = {}): NetworkMember {
  return {
    fingerprint: f, publicKey: `key-${f}`, certFingerprint: cert(c), certPem: `-----BEGIN CERTIFICATE-----PEM-${cert(c)}`,
    name, icon: 'computer', color: 'indigo', kind: 'desktop', hosts: ['10.0.0.9'], port: 9443, joinedAt: '2026-11-08T10:00:00.000Z', ...extra,
  };
}

function memberPeer(f: string, c: string, name: string, extra: Partial<AnnexPeer> = {}): AnnexPeer {
  const m = member(f, c, name);
  return {
    fingerprint: f, publicKey: m.publicKey, alias: name, icon: 'computer', color: 'indigo', pairedAt: m.joinedAt, lastSeen: '',
    role: 'member', kind: 'desktop', tlsCertificateFingerprint: m.certFingerprint, tlsCertificatePem: m.certPem, knownHosts: ['10.0.0.2'], mainPort: 9443, ...extra,
  };
}

const view = (members: NetworkMember[], removals: Array<{ fingerprint: string; removedAt: string }> = []): NetworkMessage =>
  ({ v: 1, type: 'members', members, removals });

const hooks = { connect: vi.fn(), endDevice: vi.fn((f: string) => { peers.delete(f.toLowerCase()); }) };

describe('Annex Network membership (#3061)', () => {
  beforeEach(() => {
    peers.clear();
    stored = {};
    broadcasts.length = 0;
    open = [];
    vi.clearAllMocks();
    vi.mocked(annexSettings.networkEnabled).mockReturnValue(true);
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableClient: true } as never);
    membership.resetMembershipForTests();
    membership.initNetworkMembership(hooks);
    peers.set(A.toLowerCase(), memberPeer(A, '0a', 'Studio'));
    peers.set(B.toLowerCase(), memberPeer(B, '0b', 'Laptop'));
  });

  it('tells others its view: itself, its members with their certificates, and removals', () => {
    const v = membership.currentView();
    expect(v.members.map((m) => m.name)).toEqual(['This Mac', 'Studio', 'Laptop']);
    expect(v.members[1]).toMatchObject({ certPem: expect.stringContaining('PEM-'), hosts: ['10.0.0.2'], port: 9443 });
    expect(v.removals).toEqual([]);
  });

  it('adds a device a member vouches for, pins it, connects to it, and tells the other members', () => {
    open = [A, B];
    listener!(A, view([member(A, '0a', 'Studio'), member(N, '0e', 'New Mac')]));
    expect(peers.get(N.toLowerCase())).toMatchObject({
      role: 'member', alias: 'New Mac', addedBy: A, tlsCertificatePem: expect.stringContaining('PEM-'), knownHosts: ['10.0.0.9'], mainPort: 9443,
    });
    expect(hooks.connect).toHaveBeenCalledWith(N.toLowerCase());
    // The new view goes to every member that's connected.
    expect(broadcasts.at(-1)).toMatchObject({ message: { type: 'members' }, to: [A, B] });
    // The same view again changes nothing and sends nothing.
    broadcasts.length = 0;
    listener!(A, view([member(A, '0a', 'Studio'), member(N, '0e', 'New Mac')]));
    expect(broadcasts).toHaveLength(0);
  });

  it('refuses a vouched-for record that does not prove itself', () => {
    listener!(A, view([member(N, '0e', 'Liar', { publicKey: 'key-someone-else' })]));
    listener!(A, view([member(N, '0e', 'Liar', { certFingerprint: cert('ff') })]));
    listener!(A, view([member(N, '0e', 'No cert', { certPem: undefined })]));
    expect(peers.has(N.toLowerCase())).toBe(false);
  });

  it('follows only members: a one-to-one pairing is heard, not followed', () => {
    peers.set(A.toLowerCase(), memberPeer(A, '0a', 'Studio', { role: 'satellite' }));
    listener!(A, view([member(N, '0e', 'New Mac')]));
    expect(peers.has(N.toLowerCase())).toBe(false);
  });

  it('leaves an existing one-to-one pairing as it is until it is paired again', () => {
    peers.set(N.toLowerCase(), memberPeer(N, '0e', 'Old pairing', { role: 'satellite' }));
    listener!(A, view([member(N, '0e', 'New Mac')]));
    expect(peers.get(N.toLowerCase())?.role).toBe('satellite');
  });

  it('removes a device everywhere when a member says so, and remembers the removal for members that were off', () => {
    peers.set(N.toLowerCase(), memberPeer(N, '0e', 'New Mac'));
    open = [A, B];
    listener!(A, { v: 1, type: 'member-removed', removal: { fingerprint: N, removedAt: '2026-11-08T12:00:00.000Z' } });
    expect(hooks.endDevice).toHaveBeenCalledWith(N);
    expect(membership.currentView().removals).toEqual([{ fingerprint: N, removedAt: '2026-11-08T12:00:00.000Z' }]);
    // A member that was off and still lists it doesn't bring it back.
    listener!(B, view([member(B, '0b', 'Laptop'), member(N, '0e', 'New Mac')]));
    expect(peers.has(N.toLowerCase())).toBe(false);
  });

  it('a later join beats an earlier removal', () => {
    listener!(A, view([], [{ fingerprint: N, removedAt: '2026-11-08T09:00:00.000Z' }]));
    listener!(A, view([member(N, '0e', 'Back again', { joinedAt: '2026-11-08T11:00:00.000Z' })]));
    expect(peers.get(N.toLowerCase())?.alias).toBe('Back again');
  });

  it('catches up a member that was off: its view brings joins it missed, and ours carries removals it missed', () => {
    // We know of a removal; B comes back with an older view.
    listener!(A, view([], [{ fingerprint: fp('0f'), removedAt: '2026-11-08T12:00:00.000Z' }]));
    broadcasts.length = 0;
    open = [A, B];
    listener!(B, view([member(B, '0b', 'Laptop'), member(N, '0e', 'Joined while we were off')]));
    expect(peers.has(N.toLowerCase())).toBe(true);
    const sent = broadcasts.at(-1)!.message as Extract<NetworkMessage, { type: 'members' }>;
    expect(sent.removals.map((r) => r.fingerprint)).toContain(fp('0f'));
  });

  it('leaves the network when told this machine was removed', () => {
    listener!(A, { v: 1, type: 'member-removed', removal: { fingerprint: SELF, removedAt: '2026-11-08T12:00:00.000Z' } });
    expect(hooks.endDevice).toHaveBeenCalledWith(A);
    expect(hooks.endDevice).toHaveBeenCalledWith(B);
  });

  it('removing a member here tells every member, the removed one included, and tracks where it is confirmed', () => {
    peers.set(N.toLowerCase(), memberPeer(N, '0e', 'New Mac'));
    open = [A, B, N];
    membership.noteLocalRemoval(N);
    expect(broadcasts[0]).toMatchObject({ message: { type: 'member-removed', removal: { fingerprint: N.toLowerCase() } }, to: [A, B, N] });
    peers.delete(N.toLowerCase());
    expect(membership.pendingRemovals()).toEqual([{ fingerprint: N.toLowerCase(), name: 'New Mac', confirmedBy: [], waitingOn: [A, B] }]);
    // A's view shows the removal: confirmed there.
    const removal = (stored.removals as Array<{ fingerprint: string; removedAt: string }>)[0];
    listener!(A, view([member(A, '0a', 'Studio')], [removal]));
    expect(membership.pendingRemovals()[0]).toMatchObject({ confirmedBy: [A], waitingOn: [B] });
    listener!(B, view([member(B, '0b', 'Laptop')], [removal]));
    expect(membership.pendingRemovals()).toEqual([]);
  });

  it('tracks where a join made here is confirmed', () => {
    peers.set(N.toLowerCase(), memberPeer(N, '0e', 'New Mac'));
    open = [A, B];
    membership.noteLocalJoin(N);
    expect(broadcasts.at(-1)!.message.type).toBe('members');
    expect(membership.joinConfirmation(N)).toEqual({ fingerprint: N, confirmedBy: [], waitingOn: [A, B] });
    listener!(A, view([member(A, '0a', 'Studio'), member(N, '0e', 'New Mac')]));
    expect(membership.joinConfirmation(N)).toMatchObject({ confirmedBy: [A], waitingOn: [B] });
  });

  it('renames everywhere, and an older rename never wins', () => {
    open = [A];
    expect(membership.renameMember(B, 'Travel laptop')).toBe(true);
    expect(broadcasts.at(-1)!.message).toMatchObject({ type: 'member-renamed', fingerprint: B, name: 'Travel laptop' });
    listener!(A, { v: 1, type: 'member-renamed', fingerprint: B, name: 'Old name', at: '2020-01-01T00:00:00.000Z' });
    expect(peers.get(B.toLowerCase())?.alias).toBe('Travel laptop');
  });

  it('does nothing while Annex Network is off here', () => {
    vi.mocked(annexSettings.networkEnabled).mockReturnValue(false);
    listener!(A, view([member(N, '0e', 'New Mac')]));
    expect(peers.has(N.toLowerCase())).toBe(false);
  });

  it("learns a member's address from its own hello, and connects only to desktops while the client is on", () => {
    peers.set(A.toLowerCase(), memberPeer(A, '0a', 'Studio', { knownHosts: [], mainPort: undefined }));
    listener!(A, { v: 1, type: 'hello', member: member(A, '0a', 'Studio', { hosts: ['192.168.1.4'], port: 7000 }) });
    expect(peers.get(A.toLowerCase())).toMatchObject({ knownHosts: ['192.168.1.4'], mainPort: 7000 });
    expect(hooks.connect).toHaveBeenCalledWith(A.toLowerCase());
    hooks.connect.mockClear();
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enableClient: false } as never);
    listener!(A, view([member(N, '0e', 'New Mac')]));
    expect(peers.has(N.toLowerCase())).toBe(true);
    expect(hooks.connect).not.toHaveBeenCalled();
  });
});
