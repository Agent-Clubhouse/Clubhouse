import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const FP = Array.from({ length: 16 }, () => 'ab').join(':');
const CERT = Array.from({ length: 32 }, () => 'cd').join(':');
const SELF_FP = Array.from({ length: 16 }, () => '01').join(':');
const SELF_CERT = Array.from({ length: 32 }, () => '02').join(':');

vi.mock('ws', () => ({ WebSocket: { OPEN: 1, CLOSED: 3 }, WebSocketServer: vi.fn() }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-identity', () => ({
  getIdentity: vi.fn(() => ({ fingerprint: SELF_FP, publicKey: 'self-pk', createdAt: '2026-11-01T00:00:00.000Z' })),
  computeFingerprint: vi.fn((key: string) => (key === 'peer-pk' ? FP : key === 'self-pk' ? SELF_FP : 'ff:ff')),
}));
vi.mock('./annex-settings', () => ({ getSettings: vi.fn(() => ({ alias: 'This Mac', deviceName: 'Clubhouse on This Mac', icon: 'computer', color: 'indigo' })) }));
vi.mock('./annex-tls', () => ({
  getOrCreateCert: vi.fn(() => ({ certPem: '-----BEGIN CERTIFICATE-----\nSELF\n-----END CERTIFICATE-----\n' })),
  certificateFingerprint: vi.fn(() => SELF_CERT),
  sameCertificateFingerprint: (a?: string, b?: string) => !!a && !!b && a.replace(/:/g, '').toLowerCase() === b.replace(/:/g, '').toLowerCase(),
  extractPeerFingerprint: vi.fn(),
  extractPeerCertificateFingerprint: vi.fn(),
}));
const peers = new Map<string, Record<string, unknown>>();
vi.mock('./annex-peers', () => ({
  getPeer: vi.fn((fp: string) => peers.get(fp)),
  peerNeedsPairing: vi.fn((p: { role?: string; tlsCertificateFingerprint?: string }) => !p.role || !p.tlsCertificateFingerprint),
}));

import * as channel from './annex-network-channel';
import { appLog } from './log-service';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: unknown[] = [];
  pings = 0;
  ping() { this.pings++; }
  closed: { code: number; reason: string } | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code: number, reason: string) { this.closed = { code, reason }; this.readyState = 3; }
  terminate() { this.readyState = 3; this.emit('close'); }
  /** Delivers a text frame. */
  deliver(value: unknown) { this.emit('message', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), false); }
}

const remote = {
  fingerprint: FP, publicKey: 'peer-pk', certFingerprint: CERT, name: 'Studio', icon: 'computer', color: 'teal',
  kind: 'desktop', hosts: ['192.168.1.9'], port: 9443, joinedAt: '2026-11-02T00:00:00.000Z',
};
const hello = { v: 1, type: 'hello', member: remote };

function open(direction: 'in' | 'out' = 'in') {
  const ws = new FakeSocket();
  channel._attachForTesting(ws as never, FP, CERT, direction);
  return ws;
}

describe('Annex Network channel (#3060)', () => {
  beforeEach(() => {
    peers.clear();
    peers.set(FP, { fingerprint: FP, role: 'satellite', tlsCertificateFingerprint: CERT });
    vi.clearAllMocks();
  });
  afterEach(() => channel.resetNetworkChannelForTests());

  it('describes this machine for its hello, with where its server is reached', () => {
    expect(channel.localMember()).toMatchObject({ fingerprint: SELF_FP, certFingerprint: SELF_CERT, name: 'This Mac', kind: 'desktop', hosts: [] });
    expect(channel.localMember()).not.toHaveProperty('port');
    channel.setReachProvider(() => ({ hosts: ['192.168.1.2'], port: 9000 }));
    expect(channel.localMember()).toMatchObject({ hosts: ['192.168.1.2'], port: 9000 });
  });

  it('records a matching hello and what the member says, and tells listeners', () => {
    const heard = vi.fn();
    channel.onNetworkMessage(heard);
    const ws = open();
    ws.deliver(hello);
    ws.deliver({ v: 1, type: 'members', members: [remote], removals: [] });
    expect(ws.closed).toBeNull();
    expect(channel.connectedMembers()).toEqual(new Set([FP]));
    expect(channel.memberViews().get(FP)).toMatchObject({ member: { name: 'Studio' }, members: [{ fingerprint: FP }] });
    expect(heard).toHaveBeenCalledTimes(2);
    expect(heard).toHaveBeenCalledWith(FP, expect.objectContaining({ type: 'members' }));
    expect(channel.localMembers().map((m) => m.fingerprint)).toEqual([SELF_FP, FP]);
  });

  describe('anything but membership is refused, and closes the channel', () => {
    const control = [
      { type: 'pty:input', payload: { agentId: 'a', data: 'rm -rf ~\n' } },
      { type: 'agent:spawn', payload: { projectId: 'p' } },
      { type: 'agent:kill', payload: { agentId: 'a' } },
      { type: 'canvas:mutation', payload: {} },
      { type: 'permission:response', payload: { requestId: 'r', decision: 'allow' } },
      { v: 1, type: 'hello', member: remote, payload: { data: 'x' } },
    ];

    it.each(control)('before hello: %j', (message) => {
      const heard = vi.fn();
      channel.onNetworkMessage(heard);
      const ws = open();
      ws.deliver(message);
      expect(ws.closed).toEqual({ code: 4400, reason: 'membership_only' });
      expect(heard).not.toHaveBeenCalled();
    });

    it.each(control)('after hello: %j', (message) => {
      const heard = vi.fn();
      const ws = open();
      ws.deliver(hello);
      channel.onNetworkMessage(heard);
      ws.deliver(message);
      expect(ws.closed).toEqual({ code: 4400, reason: 'membership_only' });
      expect(heard).not.toHaveBeenCalled();
      // And nothing more is read from it.
      ws.deliver({ v: 1, type: 'members', members: [], removals: [] });
      expect(heard).not.toHaveBeenCalled();
    });

    it('a binary frame', () => {
      const ws = open();
      ws.emit('message', Buffer.from('{}'), true);
      expect(ws.closed?.code).toBe(4400);
    });

    it('a message that is not JSON, and another version', () => {
      const a = open();
      a.deliver('not json');
      expect(a.closed?.code).toBe(4400);
      const b = open();
      b.deliver({ ...hello, v: 2 });
      expect(b.closed).toEqual({ code: 4426, reason: 'unsupported_version' });
    });
  });

  it('refuses a hello naming another device or another certificate', () => {
    const a = open();
    a.deliver({ v: 1, type: 'hello', member: { ...remote, fingerprint: SELF_FP } });
    expect(a.closed?.code).toBe(4400);
    const b = open();
    b.deliver({ v: 1, type: 'hello', member: { ...remote, certFingerprint: SELF_CERT } });
    expect(b.closed?.code).toBe(4400);
  });

  it('refuses a hello whose public key is not the one its fingerprint is the hash of', () => {
    const ws = open();
    ws.deliver({ v: 1, type: 'hello', member: { ...remote, publicKey: 'someone-elses-key' } });
    expect(ws.closed?.code).toBe(4400);
  });

  it('pings, keeps a channel that answers, and closes one that stops answering (sleep, a network change)', () => {
    vi.useFakeTimers();
    try {
      const ws = open();
      ws.deliver(hello);
      vi.advanceTimersByTime(30_000);
      expect(ws.pings).toBe(1);
      ws.emit('pong');
      vi.advanceTimersByTime(30_000);
      expect(ws.closed).toBeNull();
      vi.advanceTimersByTime(30_000);
      expect(ws.closed).toEqual({ code: 4400, reason: 'timeout' });
      expect(channel.connectedMembers().size).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('never passes on or lists a device once it is re-pinned or removed, even if it stays silent', () => {
    const ws = open();
    ws.deliver(hello);
    expect(channel.localMembers().map((m) => m.fingerprint)).toContain(FP);
    peers.set(FP, { fingerprint: FP, role: 'satellite', tlsCertificateFingerprint: SELF_CERT });
    expect(channel.localMembers().map((m) => m.fingerprint)).not.toContain(FP);
    peers.delete(FP);
    expect(channel.listMembers()).toEqual([]);
  });

  it('closes only the direction asked for', () => {
    const incoming = open('in');
    const outgoing = open('out');
    channel.closeFor(FP, 'out');
    expect(outgoing.closed).not.toBeNull();
    expect(incoming.closed).toBeNull();
    channel.closeAll('in');
    expect(incoming.closed).not.toBeNull();
  });

  it('forgets what a device said once it is removed and its channels closed', () => {
    const ws = open();
    ws.deliver(hello);
    expect(channel.memberViews().has(FP)).toBe(true);
    peers.delete(FP);
    channel.closeFor(FP);
    expect(channel.memberViews().has(FP)).toBe(false);
  });

  it('refuses a first message that is not hello, and a second hello', () => {
    const a = open();
    a.deliver({ v: 1, type: 'members', members: [], removals: [] });
    expect(a.closed?.code).toBe(4400);
    const b = open();
    b.deliver(hello);
    b.deliver(hello);
    expect(b.closed?.code).toBe(4400);
  });

  it('stops listening the moment the device is removed, or its pin replaced', () => {
    const heard = vi.fn();
    const ws = open();
    ws.deliver(hello);
    channel.onNetworkMessage(heard);
    peers.set(FP, { fingerprint: FP, role: 'satellite', tlsCertificateFingerprint: SELF_CERT });
    ws.deliver({ v: 1, type: 'members', members: [], removals: [] });
    expect(ws.closed).toEqual({ code: 4400, reason: 'peer_not_paired' });
    expect(heard).not.toHaveBeenCalled();
  });

  it('closes a channel that never says hello', () => {
    vi.useFakeTimers();
    try {
      const ws = open();
      vi.advanceTimersByTime(10_001);
      expect(ws.closed?.code).toBe(4400);
    } finally { vi.useRealTimers(); }
  });

  it('closes every channel for a device on request', () => {
    const ws = open();
    ws.deliver(hello);
    channel.closeFor(FP);
    expect(ws.closed).toEqual({ code: 4400, reason: 'peer_not_paired' });
    expect(channel.connectedMembers().size).toBe(0);
  });

  it('logs a refusal without the message content', () => {
    const ws = open();
    ws.deliver({ type: 'pty:input', payload: { data: 'secret-token' } });
    const logged = JSON.stringify(vi.mocked(appLog).mock.calls);
    expect(logged).not.toContain('secret-token');
  });

  describe('who may open it', () => {
    it('accepts a pinned peer of either role, and refuses the rest', async () => {
      const tlsMod = await import('./annex-tls');
      const { TLSSocket } = await import('tls');
      const make = (fp: string | null, cert: string | undefined) => {
        const s = Object.create(TLSSocket.prototype) as { encrypted: boolean };
        Object.defineProperty(s, 'encrypted', { value: true });
        vi.mocked(tlsMod.extractPeerFingerprint).mockReturnValueOnce(fp);
        vi.mocked(tlsMod.extractPeerCertificateFingerprint).mockReturnValueOnce(cert);
        return s;
      };
      peers.set('ctrl', { fingerprint: 'ctrl', role: 'controller', tlsCertificateFingerprint: CERT });
      peers.set('old', { fingerprint: 'old', alias: 'Old' });
      expect(channel.authenticateMember(make(FP, CERT))).toMatchObject({ ok: true, certFingerprint: CERT });
      expect(channel.authenticateMember(make('ctrl', CERT))).toMatchObject({ ok: true });
      expect(channel.authenticateMember(make(FP, SELF_CERT))).toEqual({ ok: false, status: 401, error: 'peer_not_paired' });
      expect(channel.authenticateMember(make('stranger', CERT))).toEqual({ ok: false, status: 401, error: 'peer_not_paired' });
      expect(channel.authenticateMember(make('old', CERT))).toEqual({ ok: false, status: 401, error: 'needs_pairing' });
      expect(channel.authenticateMember({})).toEqual({ ok: false, status: 401, error: 'unauthorized' });
    });
  });
});
