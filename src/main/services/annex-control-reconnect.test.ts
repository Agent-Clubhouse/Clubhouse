import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as tls from 'tls';
import { Socket as NetSocket } from 'net';
import { WebSocket } from 'ws';
import type { AnnexPeer } from '../../shared/types';
import { CONTROL_CLOSE_REVOKED } from '../../shared/annex-control-protocol';
import * as control from './annex-control';
import * as annexTls from './annex-tls';
import { authorize, stillAuthorized, type AnnexAuthorizerDeps } from './annex-authorizer';
import { peerRoutes, type AnnexRoute } from './annex-routes';

const { WebSocketMock } = vi.hoisted(() => ({ WebSocketMock: Object.assign(vi.fn(), { OPEN: 1, CLOSED: 3 }) }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/annex-control-reconnect-test' } }));
vi.mock('ws', () => ({ WebSocket: WebSocketMock, WebSocketServer: vi.fn() }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-tls', () => ({
  PIN_MISMATCH_CODE: 'ERR_ANNEX_PIN_MISMATCH',
  extractPeerFingerprint: vi.fn(),
  extractPeerCertificateFingerprint: vi.fn(),
}));

const LOCAL = 'local';
const REMOTE = 'remote';
const PIN = 'AA:BB';

class Socket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent: unknown[] = [];
  constructor(readonly url: string, readonly options: tls.ConnectionOptions) { super(); }
  send(text: string, written?: () => void): void { this.sent.push(JSON.parse(text)); written?.(); }
  ping(): void { this.emit('pong'); }
  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code);
  }
  terminate = vi.fn(() => this.close(1006));
}

let sockets: Socket[];
let peers: AnnexPeer[];
let networkEnabled: boolean;
let autoReconnect: boolean;
let plans: control.ControlConnectionPlan[];

function peer(overrides: Partial<AnnexPeer> = {}): AnnexPeer {
  return {
    fingerprint: REMOTE, publicKey: 'key', alias: 'Studio', icon: 'computer', color: 'indigo',
    role: 'member', kind: 'desktop', pairedAt: '2026-01-01', lastSeen: '2026-01-01',
    tlsCertificateFingerprint: PIN, tlsCertificatePem: 'pem', knownHosts: ['studio.local'], mainPort: 9443,
    ...overrides,
  };
}

const deps: AnnexAuthorizerDeps = {
  findPeer: (fp) => peers.find((entry) => entry.fingerprint === fp),
  isSessionOnly: () => false,
  networkEnabled: () => networkEnabled,
};

function installServer(): void {
  control.setControlTarget({
    authorize: (caller) => authorize(caller, deps),
    stillAuthorized: (principal) => stillAuthorized(principal, deps),
    dispatch: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0), complete: true }),
  });
}

function plan(entry = peers[0], routes = peerRoutes(entry, { localFingerprint: LOCAL })): control.ControlConnectionPlan {
  return {
    fingerprint: entry.fingerprint, pin: entry.tlsCertificateFingerprint!, trust: JSON.stringify(entry),
    localFingerprint: LOCAL, routes, tlsOptions: () => ({ ca: 'pinned-peer', cert: 'local-cert', rejectUnauthorized: true }),
  };
}

function maintain(): void {
  control.setConnectionSource({
    plans: () => plans.filter((item) => peers.some((entry) => entry.fingerprint === item.fingerprint)),
    autoReconnect: () => autoReconnect,
  });
}

function latest(): Socket {
  const socket = sockets[sockets.length - 1];
  if (!socket) throw new Error('Expected a control dial');
  return socket;
}

function open(socket = latest(), features = ['request']): void {
  const tlsSocket = new tls.TLSSocket(new NetSocket());
  socket.emit('upgrade', { socket: tlsSocket });
  tlsSocket.destroy();
  if (socket.readyState === 3) return;
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ v: 1, type: 'hello', features })), false);
}

function fail(socket = latest(), code = 'ECONNREFUSED'): void {
  socket.emit('error', Object.assign(new Error(code), { code }));
  socket.close(1006);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.setSystemTime(0);
  sockets = [];
  peers = [peer()];
  plans = [plan()];
  autoReconnect = true;
  networkEnabled = true;
  WebSocketMock.mockImplementation(function (url: string, options: tls.ConnectionOptions) {
    const socket = new Socket(url, options);
    sockets.push(socket);
    return socket;
  });
  vi.mocked(annexTls.extractPeerFingerprint).mockReturnValue(REMOTE);
  vi.mocked(annexTls.extractPeerCertificateFingerprint).mockReturnValue(PIN);
  installServer();
});

afterEach(() => {
  control.resetControlForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('proactive control connections', () => {
  it('starts a pinned control route without opening a view, /ws or /network', () => {
    maintain();
    expect(sockets.map((socket) => socket.url)).toEqual(['wss://studio.local:9443/control']);
    expect(sockets[0].options).toMatchObject({ ca: 'pinned-peer', cert: 'local-cert', rejectUnauthorized: true });
    open();
    expect(sockets[0].sent).toMatchObject([{ v: 1, type: 'hello', features: expect.arrayContaining(['request']) }]);
  });

  it('starts when the server becomes available after the client', () => {
    control.setControlTarget(null);
    maintain();
    expect(sockets).toHaveLength(0);
    installServer();
    expect(sockets).toHaveLength(1);
  });

  it('recovers after a drop independently of /ws and renegotiates capabilities', () => {
    maintain();
    open();
    sockets[0].close(1006);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].sent).toEqual([]);
    open();
    expect(sockets[1].sent).toHaveLength(1);
    expect(sockets.map((socket) => socket.url)).toEqual(Array(2).fill('wss://studio.local:9443/control'));
  });

  it('backs off exponentially and caps the final jittered delay at 30 seconds', () => {
    maintain();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const count = sockets.length;
      fail();
      for (let burst = 0; burst < 20; burst++) control.refreshConnections();
      vi.advanceTimersByTime(delay - 1);
      expect(sockets).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(count + 1);
    }
    vi.mocked(Math.random).mockReturnValue(0.999);
    fail();
    vi.advanceTimersByTime(29_999);
    expect(sockets).toHaveLength(8);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(9);
  });

  it.each([[0, 500], [0.999, 1499]])('applies deterministic jitter %s to the first retry', (random, delay) => {
    vi.mocked(Math.random).mockReturnValue(random);
    maintain();
    fail();
    vi.advanceTimersByTime(delay - 1);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
  });

  it('does not reset backoff for a peer that repeatedly says hello then drops', () => {
    maintain();
    for (const delay of [1000, 2000, 4000, 8000]) {
      open();
      latest().close(1006);
      const count = sockets.length;
      vi.advanceTimersByTime(delay - 1);
      expect(sockets).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(count + 1);
    }
  });

  it('resets backoff only after a stable 30-second connection', () => {
    maintain();
    fail();
    vi.advanceTimersByTime(1000);
    fail();
    vi.advanceTimersByTime(2000);
    open();
    vi.advanceTimersByTime(30_000);
    latest().close(1006);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4);
  });

  it('keeps one socket despite refresh/error/close bursts and stale callbacks', () => {
    maintain();
    for (let i = 0; i < 50; i++) control.refreshConnections();
    expect(sockets).toHaveLength(1);
    const old = sockets[0];
    fail(old);
    old.emit('close', 1006);
    old.emit('error', new Error('late error'));
    for (let i = 0; i < 50; i++) control.refreshConnections();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    open();
    old.emit('error', Object.assign(new Error('stale pin error'), { code: 'ERR_ANNEX_PIN_MISMATCH' }));
    old.emit('close', CONTROL_CLOSE_REVOKED);
    for (let i = 0; i < 50; i++) control.refreshConnections();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].readyState).toBe(WebSocket.OPEN);
  });

  it('tries only existing routes serially, including a locally saved forward', () => {
    peers = [peer({ typedHost: 'localhost:7555', announcedReach: { hosts: ['other.local'], port: 8443 } })];
    plans = [plan()];
    maintain();
    expect(sockets[0].url).toBe('wss://localhost:7555/control');
    fail();
    vi.advanceTimersByTime(1000);
    expect(sockets[1].url).toBe('wss://other.local:8443/control');
    fail();
    vi.advanceTimersByTime(2000);
    expect(sockets[2].url).toBe('wss://studio.local:9443/control');
  });

  it('re-reads routes before retry instead of using a removed endpoint', () => {
    maintain();
    fail();
    plans = [plan(peers[0], [{ fingerprint: REMOTE, host: 'new.local', port: 8443, source: 'announced' }])];
    vi.advanceTimersByTime(1000);
    expect(sockets.map((socket) => socket.url)).toEqual(['wss://studio.local:9443/control', 'wss://new.local:8443/control']);
  });

  it('fences a route removed during a handshake and recovers over its replacement', () => {
    maintain();
    plans = [plan(peers[0], [{ fingerprint: REMOTE, host: 'new.local', port: 8443, source: 'announced' }])];
    open(sockets[0]);
    expect(sockets[0].sent).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(sockets[1].url).toBe('wss://new.local:8443/control');
    open();
    expect(sockets[1].sent).toHaveLength(1);
  });

  it('retires a negotiated control socket when its endpoint is withdrawn', () => {
    maintain();
    open();
    const old = sockets[0];
    plans = [plan(peers[0], [{ fingerprint: REMOTE, host: 'replacement.local', port: 8443, source: 'announced' }])];
    control.refreshConnections();
    expect(old.readyState).toBe(WebSocket.CLOSED);
    expect(sockets.map((socket) => socket.url)).toEqual([
      'wss://studio.local:9443/control', 'wss://replacement.local:8443/control',
    ]);
    open(sockets[1]);
    old.emit('error', Object.assign(new Error('stale pin error'), { code: 'ERR_ANNEX_PIN_MISMATCH' }));
    old.emit('close', CONTROL_CLOSE_REVOKED);
    for (let i = 0; i < 20; i++) control.refreshConnections();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].readyState).toBe(WebSocket.OPEN);
  });

  it('preserves a negotiated control socket when unrelated routes are added or reordered', () => {
    maintain();
    open();
    plans = [plan(peers[0], [
      { fingerprint: REMOTE, host: 'alternative.local', port: 8443, source: 'announced' },
      ...plans[0].routes,
    ])];
    for (let i = 0; i < 20; i++) control.refreshConnections();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].readyState).toBe(WebSocket.OPEN);
  });

  it('closes negotiated control when its last route becomes private to another observer', () => {
    maintain();
    open();
    plans = [plan(peers[0], [{ ...plans[0].routes[0], privateTo: 'another-observer' }])];
    for (let i = 0; i < 20; i++) control.refreshConnections();
    expect(sockets[0].readyState).toBe(WebSocket.CLOSED);
    control.retryConnection(REMOTE);
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('never dials held, wrong-peer or wrong-observer private routes, including on retry', () => {
    const heldPeer = peer({
      fingerprint: 'other-peer', knownHosts: [], mainPort: undefined,
      heldRoutes: { heldAt: '2026-01-01', typedHost: 'localhost:7888', knownHosts: ['held.local'], hostPorts: { 'held.local': 8443 } },
    });
    peers.push(heldPeer);
    const wrongRoutes: AnnexRoute[] = [
      { fingerprint: 'other-peer', host: 'localhost', port: 7666, source: 'known', privateTo: LOCAL },
      { fingerprint: REMOTE, host: 'localhost', port: 7777, source: 'typed', privateTo: 'another-observer' },
    ];
    plans = [plan(peers[0], [...wrongRoutes, ...plans[0].routes]), plan(heldPeer)];
    maintain();
    fail();
    vi.advanceTimersByTime(1000);
    expect(sockets.map((socket) => socket.url)).toEqual(Array(2).fill('wss://studio.local:9443/control'));
    plans = [plan(peers[0], wrongRoutes), plan(heldPeer)];
    fail();
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(2);
  });
});

describe('reconnect stop conditions', () => {
  function stop(reason: string): void {
    if (reason === 'forget') { peers = []; control.refreshConnections(); }
    if (reason === 'revocation') control.closeFor(REMOTE, 'both', true);
    if (reason === 'network-off') { networkEnabled = false; control.refreshConnections(); }
    if (reason === 'server-off') control.setControlTarget(null);
    if (reason === 'client-off') control.setConnectionSource(null);
    if (reason === 'explicit-stop') control.closeFor(REMOTE, 'out');
  }

  it.each(['forget', 'revocation', 'network-off', 'server-off', 'client-off'])('closes a live connection and stops reconnect on %s', (reason) => {
    maintain();
    open();
    const closed = vi.fn();
    sockets[0].on('close', closed);
    stop(reason);
    expect(sockets[0].readyState).toBe(3);
    if (['forget', 'revocation', 'network-off'].includes(reason)) expect(closed).toHaveBeenCalledWith(CONTROL_CLOSE_REVOKED);
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });

  it.each(['forget', 'revocation', 'network-off', 'server-off', 'client-off', 'explicit-stop'])('cancels a pending retry on %s', (reason) => {
    maintain();
    fail();
    stop(reason);
    for (let i = 0; i < 10; i++) control.refreshConnections();
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('rechecks forget at the timer even before a lifecycle notification', () => {
    maintain();
    fail();
    peers = [];
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('cancels an unupgraded socket on forget and fences its late upgrade', () => {
    maintain();
    const old = sockets[0];
    peers = [];
    control.refreshConnections();
    expect(old.terminate).toHaveBeenCalledOnce();
    open(old);
    expect(old.sent).toEqual([]);
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('closeFor cancels a pending legacy handshake without a route source', () => {
    control.connectTo(REMOTE, 'studio.local', 9443, {}, PIN);
    control.closeFor(REMOTE, 'out', true);
    expect(sockets[0].terminate).toHaveBeenCalledOnce();
    open(sockets[0]);
    expect(sockets[0].sent).toEqual([]);
  });

  it('checks role/pending eligibility again before a handshake completes', () => {
    maintain();
    peers[0] = peer({ networkPending: true });
    open();
    expect(sockets[0].terminate).toHaveBeenCalled();
    expect(sockets[0].sent).toEqual([]);
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });

  it.each(['ERR_ANNEX_PIN_MISMATCH', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'ERR_ANNEX_NEEDS_PAIRING'])('stops rather than trying another endpoint on %s', (code) => {
    plans = [plan(peers[0], [...plans[0].routes, { fingerprint: REMOTE, host: 'other.local', port: 8443, source: 'announced' }])];
    maintain();
    fail(sockets[0], code);
    for (let i = 0; i < 20; i++) control.refreshConnections();
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('stops when pinned TLS setup itself detects a pin mismatch', () => {
    plans[0].tlsOptions = () => { throw Object.assign(new Error('Stored certificate does not match'), { code: 'ERR_ANNEX_PIN_MISMATCH' }); };
    maintain();
    for (let i = 0; i < 20; i++) control.refreshConnections();
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(0);
  });

  it.each(['identity', 'pin'])('rejects a mismatched presented %s before hello and stops', (field) => {
    maintain();
    if (field === 'identity') vi.mocked(annexTls.extractPeerFingerprint).mockReturnValue('another-peer');
    else vi.mocked(annexTls.extractPeerCertificateFingerprint).mockReturnValue('OTHER-PIN');
    open();
    expect(sockets[0].sent).toEqual([]);
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('never retries previous trust after a pin/pairing changes while waiting', () => {
    maintain();
    fail();
    peers[0] = peer({ tlsCertificateFingerprint: 'NEW-PIN', pairingId: 'new-pairing' });
    plans = [plan()];
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
    control.refreshConnections();
    expect(sockets).toHaveLength(2);
    expect(sockets[1].sent).toEqual([]);
  });

  it('honors autoReconnect without allowing presence updates to cause retries', () => {
    autoReconnect = false;
    maintain();
    fail();
    for (let i = 0; i < 20; i++) control.refreshConnections();
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
    autoReconnect = true;
    control.refreshConnections();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });

  it.each([true, false])('rechecks switched-off autoReconnect with refresh %s', (refresh) => {
    maintain();
    fail();
    autoReconnect = false;
    if (refresh) control.refreshConnections();
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('allows explicit retry while autoReconnect is off', () => {
    maintain();
    fail();
    autoReconnect = false;
    control.retryConnection(REMOTE);
    expect(sockets).toHaveLength(2);
    fail();
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(2);
  });
});

describe('mixed versions and eligibility', () => {
  function reachLongTail(): void {
    maintain();
    for (const delay of [1000, 2000, 4000, 8000, 16000]) {
      fail(latest(), 'ECONNRESET');
      vi.advanceTimersByTime(delay);
    }
    fail(latest(), 'ECONNRESET');
    expect(sockets).toHaveLength(6);
  }

  it('probes an old resetting server about once per ten minutes after six failures', () => {
    reachLongTail();
    for (let i = 0; i < 3; i++) {
      const count = sockets.length;
      for (let burst = 0; burst < 20; burst++) control.refreshConnections();
      vi.advanceTimersByTime(599_999);
      expect(sockets).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(count + 1);
      fail(latest(), 'ECONNRESET');
    }
    expect(sockets.every((socket) => socket.url.endsWith('/control') && socket.sent.length === 0)).toBe(true);
  });

  it.each([[0, 300_000], [0.999, 899_400]])('keeps jitter on long-tail probes (%s)', (random, delay) => {
    reachLongTail();
    vi.advanceTimersByTime(600_000);
    vi.mocked(Math.random).mockReturnValue(random);
    fail(latest(), 'ECONNRESET');
    vi.advanceTimersByTime(delay - 1);
    expect(sockets).toHaveLength(7);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(8);
  });

  it('recovers normally from a transient reset and never applies old-peer backoff after hello', () => {
    maintain();
    fail(sockets[0], 'ECONNRESET');
    vi.advanceTimersByTime(1000);
    open();
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000, 30000]) {
      fail(latest(), 'ECONNRESET');
      vi.advanceTimersByTime(delay);
    }
    expect(sockets).toHaveLength(9);
    open();
    expect(latest().sent).toHaveLength(1);
  });

  it.each(['new-route', 'new-trust', 'direct-handshake', 'explicit-retry'])('leaves long-tail backoff on %s', (event) => {
    reachLongTail();
    if (event === 'new-route') {
      plans = [plan(peers[0], [{ fingerprint: REMOTE, host: 'new.local', port: 9443, source: 'announced' }])];
      control.refreshConnections();
    }
    if (event === 'new-trust') {
      peers[0] = peer({ pairingId: 'new-pairing' });
      plans = [plan()];
      control.refreshConnections();
    }
    if (event === 'direct-handshake') control.connectTo(REMOTE, 'studio.local', 9443, {}, PIN);
    if (event === 'explicit-retry') control.retryConnection(REMOTE);
    expect(sockets).toHaveLength(7);
    fail(latest(), 'ECONNRESET');
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(7);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(8);
  });

  it('counts consecutive pre-upgrade resets, not unrelated failures', () => {
    maintain();
    for (const [code, delay] of [
      ['ECONNRESET', 1000], ['ECONNRESET', 2000], ['ECONNREFUSED', 4000],
      ['ECONNRESET', 8000], ['ECONNRESET', 16000], ['ECONNRESET', 30000],
    ] as const) {
      fail(latest(), code);
      vi.advanceTimersByTime(delay);
    }
    expect(sockets).toHaveLength(7);
  });

  it.each([401, 403, 404, 405, 426])('does not loop after a terminal HTTP refusal %s', (statusCode) => {
    maintain();
    const resume = vi.fn();
    sockets[0].emit('unexpected-response', {}, { statusCode, resume });
    expect(resume).toHaveBeenCalledOnce();
    for (let i = 0; i < 20; i++) {
      control.refreshConnections();
      control.connectTo(REMOTE, 'studio.local', 9443, {}, PIN);
    }
    vi.advanceTimersByTime(300_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent).toEqual([]);
  });

  it('does not reconnect a peer that negotiates no reverse-request capability', () => {
    maintain();
    open(sockets[0], []);
    expect(sockets[0].readyState).toBe(3);
    vi.advanceTimersByTime(120_000);
    control.refreshConnections();
    expect(sockets).toHaveLength(1);
    expect(control.hasReverseLink(REMOTE)).toBe(false);
  });

  it('may re-probe an unsupported peer on explicit Retry without saving capabilities', () => {
    maintain();
    sockets[0].emit('unexpected-response', {}, { statusCode: 404, resume: vi.fn() });
    control.retryConnection(REMOTE);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].sent).toEqual([]);
    open();
    expect(sockets[1].sent).toHaveLength(1);
  });

  it.each([
    { role: 'satellite' as const }, { role: 'controller' as const }, { kind: 'phone' as const },
    { networkPending: true }, { tlsCertificateFingerprint: undefined },
  ])('opens no control socket for an ineligible peer: %j', (overrides) => {
    peers = [peer(overrides)];
    plans = [{ ...plan(), pin: peers[0].tlsCertificateFingerprint ?? '' }];
    maintain();
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(0);
  });
});
