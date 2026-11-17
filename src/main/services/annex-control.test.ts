/**
 * The Annex control connection (#3613 P3): capability hello, reverse
 * request/response authorized by the P1 authorizer, the refusal matrix over
 * the connection, mid-session revocation, dedup and replay, cancellation,
 * indeterminate outcomes and mixed versions.
 *
 * One module instance plays both computers: an `in` connection (this machine
 * accepted it and requests) wired to an `out` one (this machine opened it and
 * is the target).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/annex-control-test' } }));
vi.mock('ws', () => ({ WebSocket: { OPEN: 1, CLOSED: 3 }, WebSocketServer: vi.fn() }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-tls', () => ({ extractPeerFingerprint: vi.fn(), extractPeerCertificateFingerprint: vi.fn() }));

import * as control from './annex-control';
import { authorize, stillAuthorized, type AnnexAuthorizerDeps, type AnnexPrincipal } from './annex-authorizer';
import type { ControlHttpRequest } from '../../shared/annex-control-protocol';
import { CONTROL_CLOSE_PROTOCOL, CONTROL_CLOSE_REVOKED, CONTROL_CLOSE_VERSION, CONTROL_FRAME_MAX_BYTES } from '../../shared/annex-control-protocol';
import type { AnnexPeer } from '../../shared/types';

/** B: the computer with no route back. It accepted the connection and sends requests. */
const REQUESTER = 'b0:b0:b0:b0';
const REQUESTER_PIN = 'BB:BB:BB:01';
/** A: the computer that opened the connection over its route. It is the target. */
const TARGET = 'a0:a0:a0:a0';
const TARGET_PIN = 'AA:AA:AA:01';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  pings = 0;
  closed: { code: number; reason: string } | null = null;
  peer: FakeSocket | null = null;
  ping() { this.pings++; }
  send(data: string) {
    this.sent.push(JSON.parse(data));
    const peer = this.peer;
    if (peer) queueMicrotask(() => { if (peer.readyState === 1) peer.emit('message', Buffer.from(data), false); });
  }
  close(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.closed = { code, reason };
    this.readyState = 3;
    const peer = this.peer;
    queueMicrotask(() => {
      this.emit('close');
      if (peer && peer.readyState !== 3) { peer.readyState = 3; peer.closed = { code, reason }; peer.emit('close'); }
    });
  }
  terminate() { this.close(1006, ''); }
  deliver(value: unknown, binary = false) { this.emit('message', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), binary); }
}

function peer(overrides: Partial<AnnexPeer> = {}): AnnexPeer {
  return {
    fingerprint: REQUESTER, publicKey: 'pk', alias: 'Studio', icon: 'computer', color: 'indigo',
    pairedAt: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z',
    role: 'member', kind: 'desktop', tlsCertificateFingerprint: REQUESTER_PIN, ...overrides,
  };
}

/** What the target (A) knows about the requester (B). */
interface World { peer?: AnnexPeer; sessionOnly?: boolean; networkEnabled?: boolean }
let world: World;
/** Whether the requester (B) still allows the target (A) on the connection it accepted. */
let inboundAllowed: boolean;

const deps: AnnexAuthorizerDeps = {
  findPeer: (fp) => (world.peer?.fingerprint === fp ? world.peer : undefined),
  isSessionOnly: (fp) => !!world.sessionOnly && world.peer?.fingerprint === fp,
  networkEnabled: () => world.networkEnabled !== false,
};

type Handler = (principal: AnnexPrincipal, request: ControlHttpRequest, ctx: control.DispatchContext) => Promise<control.ControlResult>;
let handler: Handler;
const dispatch = vi.fn((principal: AnnexPrincipal, request: ControlHttpRequest, ctx: control.DispatchContext) => handler(principal, request, ctx));

function ok(body: unknown, status = 200): control.ControlResult {
  return { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function installServer(): void {
  control.setControlTarget({
    // Passed through as sent: the module itself must ask as a reverse caller.
    authorize: (caller) => authorize(caller, deps),
    stillAuthorized: (principal) => stillAuthorized(principal, deps),
    dispatch,
  });
  control.setInboundAuthority({ accept: () => ({ ok: false, status: 401, error: 'unauthorized', message: '' }), stillAllowed: () => inboundAllowed });
}

/** Both ends of one connection, hellos exchanged. */
async function connected(features?: string[]): Promise<{ requesterWs: FakeSocket; targetWs: FakeSocket }> {
  const requesterWs = new FakeSocket();
  const targetWs = new FakeSocket();
  requesterWs.peer = targetWs;
  targetWs.peer = requesterWs;
  control._attachForTesting(requesterWs as never, TARGET, TARGET_PIN, 'in');
  control._attachForTesting(targetWs as never, REQUESTER, REQUESTER_PIN, 'out');
  control._sendHelloForTesting(REQUESTER, features);
  await flush();
  return { requesterWs, targetWs };
}

function sentOfType(ws: FakeSocket, type: string) {
  return ws.sent.filter((m) => m.type === type);
}

beforeEach(() => {
  world = { peer: peer() };
  inboundAllowed = true;
  handler = async () => ok({ hello: 'from A' });
  dispatch.mockClear();
  installServer();
});

afterEach(() => {
  vi.useRealTimers();
  control.resetControlForTests();
});

describe('capability hello and mixed versions', () => {
  it('the accepting side sends nothing until the opener says hello, then only what both support', async () => {
    const ws = new FakeSocket();
    control._attachForTesting(ws as never, TARGET, TARGET_PIN, 'in');
    await flush();
    expect(ws.sent).toEqual([]);
    expect(control.hasReverseLink(TARGET)).toBe(false);
    await expect(control.request(TARGET, { method: 'GET', path: '/api/v1/status' })).rejects.toMatchObject({ code: 'transport_unavailable', indeterminate: false });
    expect(ws.sent).toEqual([]);
    ws.deliver({ v: 1, type: 'hello', features: ['request', 'subscribe-from-the-future'] });
    expect(ws.sent).toEqual([{ v: 1, type: 'hello', features: ['request'] }]);
    expect(control.hasReverseLink(TARGET)).toBe(true);
  });

  it('an opener that offers nothing this side knows gets nothing new: no request frame is ever sent', async () => {
    const ws = new FakeSocket();
    control._attachForTesting(ws as never, TARGET, TARGET_PIN, 'in');
    ws.deliver({ v: 1, type: 'hello', features: ['something-newer'] });
    expect(ws.sent).toEqual([{ v: 1, type: 'hello', features: [] }]);
    await expect(control.request(TARGET, { method: 'POST', path: '/api/v1/network/agent-call', body: '{}' })).rejects.toMatchObject({ code: 'not_supported', indeterminate: false });
    expect(control.hasReverseLink(TARGET)).toBe(false);
    expect(sentOfType(ws, 'request')).toEqual([]);
  });

  it('a target that agreed to no features answers a request not_supported and never runs it', async () => {
    const { targetWs } = await connected([]);
    targetWs.deliver({ v: 1, type: 'request', id: 'r1', method: 'GET', path: '/api/v1/status' });
    await flush();
    expect(sentOfType(targetWs, 'error')).toEqual([{ v: 1, type: 'error', id: 'r1', code: 'not_supported' }]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('the opener refuses an answer that claims more than it offered', async () => {
    const ws = new FakeSocket();
    control._attachForTesting(ws as never, REQUESTER, REQUESTER_PIN, 'out');
    control._sendHelloForTesting(REQUESTER, []);
    ws.deliver({ v: 1, type: 'hello', features: ['request'] });
    expect(ws.closed?.code).toBe(CONTROL_CLOSE_PROTOCOL);
  });

  it('closes a connection that never says hello', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const ws = new FakeSocket();
    control._attachForTesting(ws as never, TARGET, TARGET_PIN, 'in');
    vi.advanceTimersByTime(control.HELLO_TIMEOUT_MS + 1);
    expect(ws.closed?.code).toBe(CONTROL_CLOSE_PROTOCOL);
    expect(ws.sent).toEqual([]);
  });

  it('negotiates per connection: a new connection starts with nothing agreed', async () => {
    await connected();
    expect(control.hasReverseLink(TARGET)).toBe(true);
    const fresh = new FakeSocket();
    // A reconnect replaces the old one, and has agreed nothing until its own hello.
    control.closeFor(TARGET, 'in');
    control._attachForTesting(fresh as never, TARGET, TARGET_PIN, 'in');
    expect(control.hasReverseLink(TARGET)).toBe(false);
  });

  it('nothing is opened while this machine is not serving', () => {
    control.setControlTarget(null);
    expect(control.canServe()).toBe(false);
    control.connectTo(REQUESTER, '127.0.0.1', 9443, {}, REQUESTER_PIN);
    // No server, no target: connectTo returns before creating a socket (the ws mock has no constructor).
    expect(control.hasReverseLink(REQUESTER)).toBe(false);
  });
});

describe('protocol: anything out of place closes the connection', () => {
  async function expectClosed(direction: 'in' | 'out', frame: unknown, code = CONTROL_CLOSE_PROTOCOL, binary = false) {
    const ws = new FakeSocket();
    control._attachForTesting(ws as never, direction === 'in' ? TARGET : REQUESTER, direction === 'in' ? TARGET_PIN : REQUESTER_PIN, direction);
    if (direction === 'in') ws.deliver({ v: 1, type: 'hello', features: ['request'] });
    else { control._sendHelloForTesting(REQUESTER); ws.deliver({ v: 1, type: 'hello', features: ['request'] }); }
    ws.deliver(frame, binary);
    expect(ws.closed?.code).toBe(code);
  }

  it('a request sent to the side that accepted (only the target takes requests)', () => expectClosed('in', { v: 1, type: 'request', id: 'x', method: 'GET', path: '/api/v1/status' }));
  it('a cancel sent to the side that accepted', () => expectClosed('in', { v: 1, type: 'cancel', id: 'x' }));
  it('a response sent to the target', () => expectClosed('out', { v: 1, type: 'response', id: 'x', status: 200, headers: {}, body: '', encoding: 'utf8' }));
  it('an error sent to the target', () => expectClosed('out', { v: 1, type: 'error', id: 'x', code: 'busy' }));
  it('a second hello', () => expectClosed('out', { v: 1, type: 'hello', features: [] }));
  it('a binary frame', () => expectClosed('out', '{}', CONTROL_CLOSE_PROTOCOL, true));
  it('not JSON', () => expectClosed('out', 'nope'));
  it('another version', () => expectClosed('out', { v: 2, type: 'cancel', id: 'x' }, CONTROL_CLOSE_VERSION));

  it('a first frame that is not hello', async () => {
    const ws = new FakeSocket();
    control._attachForTesting(ws as never, TARGET, TARGET_PIN, 'in');
    ws.deliver({ v: 1, type: 'response', id: 'x', status: 200, headers: {}, body: '', encoding: 'utf8' });
    expect(ws.closed?.code).toBe(CONTROL_CLOSE_PROTOCOL);
  });

  it('a malformed request on a negotiated connection is answered invalid_request, not run', async () => {
    const { targetWs } = await connected();
    targetWs.deliver({ v: 1, type: 'request', id: 'bad-header', method: 'GET', path: '/api/v1/status', headers: { cookie: 'x' } });
    targetWs.deliver({ v: 1, type: 'request', id: 'bad-path', method: 'GET', path: 'http://elsewhere/api' });
    targetWs.deliver({ v: 1, type: 'request', id: 'bad-method', method: 'CONNECT', path: '/api/v1/status' });
    await flush();
    expect(sentOfType(targetWs, 'error').map((e) => [e.id, e.code])).toEqual([
      ['bad-header', 'invalid_request'], ['bad-path', 'invalid_request'], ['bad-method', 'invalid_request'],
    ]);
    expect(targetWs.closed).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('reverse request and response', () => {
  it('carries a request to the target, which runs it as the requester via reverse, and the answer back', async () => {
    await connected();
    handler = async (principal, request) => ok({ principal, request });
    const result = await control.request(TARGET, { method: 'POST', path: '/api/v1/network/agent-call', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(result.status).toBe(200);
    const echoed = JSON.parse(result.body.toString());
    // The requester's identity and the certificate this connection verified; never the target's own.
    expect(echoed.principal).toEqual({ fingerprint: REQUESTER, pin: REQUESTER_PIN, role: 'member', via: 'reverse' });
    expect(echoed.request).toMatchObject({ method: 'POST', path: '/api/v1/network/agent-call', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  });

  it('carries binary bodies byte for byte both ways', async () => {
    await connected();
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0xc3]);
    handler = async (_p, request) => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: Buffer.concat([Buffer.from(request.body ?? '', request.encoding === 'base64' ? 'base64' : 'utf8'), Buffer.from([0x99])]) });
    const result = await control.request(TARGET, { method: 'POST', path: '/x', body: bytes });
    expect(result.body.equals(Buffer.concat([bytes, Buffer.from([0x99])]))).toBe(true);
  });

  it('refuses locally a request that cannot fit in a frame, without sending it', async () => {
    const { requesterWs } = await connected();
    await expect(control.request(TARGET, { method: 'POST', path: '/x', body: Buffer.alloc(CONTROL_FRAME_MAX_BYTES) }))
      .rejects.toMatchObject({ code: 'request_too_large', indeterminate: false });
    expect(sentOfType(requesterWs, 'request')).toEqual([]);
  });

  it('answers response_too_large for an answer that cannot fit in a frame', async () => {
    await connected();
    handler = async () => ({ status: 200, headers: {}, body: Buffer.alloc(CONTROL_FRAME_MAX_BYTES, 0x61) });
    await expect(control.request(TARGET, { method: 'GET', path: '/big' })).rejects.toMatchObject({ code: 'response_too_large', indeterminate: false });
  });

  it('answers busy beyond the in-flight limit, and runs none of the extra', async () => {
    const { targetWs } = await connected();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    handler = async () => { await gate; return ok({}); };
    for (let i = 0; i <= control.MAX_IN_FLIGHT; i++) targetWs.deliver({ v: 1, type: 'request', id: `r${i}`, method: 'GET', path: '/slow' });
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(control.MAX_IN_FLIGHT);
    expect(sentOfType(targetWs, 'error')).toEqual([{ v: 1, type: 'error', id: `r${control.MAX_IN_FLIGHT}`, code: 'busy' }]);
    release();
    await flush();
  });

  it('a handler that throws answers 500, not a hang', async () => {
    await connected();
    handler = async () => { throw new Error('boom'); };
    const result = await control.request(TARGET, { method: 'GET', path: '/x' });
    expect(result.status).toBe(500);
    expect(JSON.parse(result.body.toString())).toEqual({ error: 'internal_error' });
  });
});

describe('refusal matrix over the control connection', () => {
  // The same classes as the P1 matrix: only an active desktop member reaches a route handler.
  const ROWS: Array<{ name: string; world: World; expect: 'run' | [number, string] }> = [
    { name: 'active desktop member', world: { peer: peer() }, expect: 'run' },
    { name: 'unknown or removed peer', world: {}, expect: [401, 'peer_not_paired'] },
    { name: 'older pairing with no role', world: { peer: peer({ role: undefined }) }, expect: [401, 'needs_pairing'] },
    { name: 'older pairing with no pin', world: { peer: peer({ tlsCertificateFingerprint: undefined }) }, expect: [401, 'needs_pairing'] },
    { name: 'pin mismatch (re-pinned)', world: { peer: peer({ tlsCertificateFingerprint: 'BB:BB:BB:02' }) }, expect: [401, 'peer_not_paired'] },
    { name: 'pending member', world: { peer: peer({ networkPending: true }) }, expect: [403, 'peer_role_not_allowed'] },
    { name: 'one-to-one satellite (this machine controls it)', world: { peer: peer({ role: 'satellite', kind: undefined }) }, expect: [403, 'peer_role_not_allowed'] },
    { name: 'one-to-one controller (keeps its direction)', world: { peer: peer({ role: 'controller', kind: undefined }) }, expect: [403, 'peer_role_not_allowed'] },
    { name: 'phone network member', world: { peer: peer({ kind: 'phone' }) }, expect: [403, 'peer_role_not_allowed'] },
    { name: 'member with no kind', world: { peer: peer({ kind: undefined }) }, expect: [403, 'peer_role_not_allowed'] },
    { name: 'session-only entry', world: { peer: peer(), sessionOnly: true }, expect: [403, 'peer_role_not_allowed'] },
    { name: 'desktop member with Annex Network off', world: { peer: peer(), networkEnabled: false }, expect: [403, 'peer_role_not_allowed'] },
  ];

  for (const row of ROWS) {
    it(`${row.name}: ${row.expect === 'run' ? 'runs' : `${row.expect[0]} ${row.expect[1]}`}`, async () => {
      await connected();
      world = row.world;
      const result = await control.request(TARGET, { method: 'POST', path: '/api/v1/projects/p/git/push', body: '{}' });
      if (row.expect === 'run') {
        expect(result.status).toBe(200);
        expect(dispatch).toHaveBeenCalledTimes(1);
      } else {
        expect(result.status).toBe(row.expect[0]);
        expect(JSON.parse(result.body.toString())).toMatchObject({ error: row.expect[1], message: expect.any(String) });
        expect(dispatch).not.toHaveBeenCalled();
      }
    });
  }

  it('a refused request leaves nothing for a retry to replay once access returns', async () => {
    await connected();
    world = { peer: peer({ networkPending: true }) };
    const refused = await control.request(TARGET, { method: 'POST', path: '/p', body: '{}' }, { requestId: 'once' });
    expect(refused.status).toBe(403);
    world = { peer: peer() };
    const allowed = await control.request(TARGET, { method: 'POST', path: '/p', body: '{}' }, { requestId: 'once' });
    expect(allowed.status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('mid-session revocation', () => {
  for (const [name, change] of [
    ['removed', () => { world.peer = undefined; }],
    ['re-pinned', () => { world.peer = peer({ tlsCertificateFingerprint: 'BB:BB:BB:02' }); }],
    ['made pending', () => { world.peer = peer({ networkPending: true }); }],
    ['re-paired as a satellite', () => { world.peer = peer({ role: 'satellite' }); }],
    ['became a phone', () => { world.peer = peer({ kind: 'phone' }); }],
    ['network turned off', () => { world.networkEnabled = false; }],
  ] as const) {
    it(`target: a requester ${name} while its request runs gets no answer, and the connection closes`, async () => {
      const { targetWs } = await connected();
      handler = async () => { change(); return ok({ secret: 'not for a revoked peer' }); };
      const pending = control.request(TARGET, { method: 'GET', path: '/api/v1/projects/p/files/read?path=a' });
      await expect(pending).rejects.toMatchObject({ code: 'authorization_revoked' });
      expect(sentOfType(targetWs, 'response')).toEqual([]);
      expect(targetWs.closed?.code).toBe(CONTROL_CLOSE_REVOKED);
    });
  }

  it('target: a requester revoked between requests is refused on its next one', async () => {
    await connected();
    expect((await control.request(TARGET, { method: 'GET', path: '/a' })).status).toBe(200);
    world.peer = undefined;
    expect((await control.request(TARGET, { method: 'GET', path: '/a' })).status).toBe(401);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('requester: a target no longer allowed here ends the connection on its next frame, and waiting requests fail as revoked', async () => {
    const { targetWs, requesterWs } = await connected();
    let release!: () => void;
    handler = async () => { await new Promise<void>((resolve) => { release = resolve; }); return ok({}); };
    const pending = control.request(TARGET, { method: 'POST', path: '/p', body: '{}' });
    await flush();
    inboundAllowed = false;
    release();
    await expect(pending).rejects.toMatchObject({ code: 'authorization_revoked', indeterminate: true });
    expect(requesterWs.closed?.code).toBe(CONTROL_CLOSE_REVOKED);
    expect(targetWs.readyState).toBe(3);
  });

  it('requester: no request goes to a target no longer allowed here', async () => {
    const { requesterWs } = await connected();
    inboundAllowed = false;
    await expect(control.request(TARGET, { method: 'GET', path: '/a' })).rejects.toMatchObject({ code: 'authorization_revoked', indeterminate: false });
    expect(sentOfType(requesterWs, 'request')).toEqual([]);
  });

  it('removal closes the connection both ways, failing what was waiting as revoked and aborting what was running', async () => {
    await connected();
    let seenSignal: AbortSignal | undefined;
    handler = async (_p, _r, ctx) => { seenSignal = ctx.signal; await new Promise(() => {}); return ok({}); };
    const pending = control.request(TARGET, { method: 'POST', path: '/p', body: '{}' });
    await flush();
    control.closeFor(TARGET, 'both', true);
    control.closeFor(REQUESTER, 'both', true);
    await expect(pending).rejects.toMatchObject({ code: 'authorization_revoked', indeterminate: true });
    expect(seenSignal?.aborted).toBe(true);
  });
});

describe('request ids, dedup and replay', () => {
  it('a retry with the same id after a lost answer gets the original answer without running again', async () => {
    const { targetWs } = await connected();
    let runs = 0;
    handler = async () => ok({ run: ++runs });
    targetWs.deliver({ v: 1, type: 'request', id: 'commit-1', method: 'POST', path: '/api/v1/projects/p/git/commit', body: '{"message":"m"}' });
    await flush();
    // The answer was lost (the connection dropped). The requester reconnects and retries with the same id.
    control.closeFor(TARGET, 'in');
    control.closeFor(REQUESTER, 'out');
    await flush();
    await connected();
    const retried = await control.request(TARGET, { method: 'POST', path: '/api/v1/projects/p/git/commit', body: '{"message":"m"}' }, { requestId: 'commit-1' });
    expect(JSON.parse(retried.body.toString())).toEqual({ run: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('the same id with a different request is a conflict, and does not run', async () => {
    await connected();
    await control.request(TARGET, { method: 'POST', path: '/p', body: '{"a":1}' }, { requestId: 'same' });
    const conflict = await control.request(TARGET, { method: 'POST', path: '/p', body: '{"a":2}' }, { requestId: 'same' });
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.body.toString())).toMatchObject({ error: 'request_conflict' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('a retry while the original is still running waits for it, and it runs once', async () => {
    const { targetWs } = await connected();
    let release!: () => void;
    handler = async () => { await new Promise<void>((resolve) => { release = resolve; }); return ok({ done: true }); };
    targetWs.deliver({ v: 1, type: 'request', id: 'slow', method: 'POST', path: '/p', body: '{}' });
    await flush();
    // The old connection is gone; the original keeps running on the target.
    control.closeFor(REQUESTER, 'out');
    control.closeFor(TARGET, 'in');
    await flush();
    await connected();
    const retry = control.request(TARGET, { method: 'POST', path: '/p', body: '{}' }, { requestId: 'slow' });
    await flush();
    release();
    expect(JSON.parse((await retry).body.toString())).toEqual({ done: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('reads are not remembered: the same id runs again', async () => {
    await connected();
    await control.request(TARGET, { method: 'GET', path: '/a' }, { requestId: 'g' });
    await control.request(TARGET, { method: 'GET', path: '/a' }, { requestId: 'g' });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(control._seenSizeForTesting()).toBe(0);
  });

  it('an answer too large to keep goes out once; a retry is told it cannot be replayed, and nothing runs again', async () => {
    await connected();
    const big = Buffer.alloc(control.SEEN_RETAIN_MAX_BYTES + 10, 0x61);
    handler = async () => ({ status: 200, headers: {}, body: big });
    const first = await control.request(TARGET, { method: 'POST', path: '/p', body: '{}' }, { requestId: 'big' });
    expect(first.body.length).toBe(big.length);
    await expect(control.request(TARGET, { method: 'POST', path: '/p', body: '{}' }, { requestId: 'big' })).rejects.toMatchObject({ code: 'replay_unavailable', indeterminate: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('remembers a finished request for a limited time', async () => {
    let now = 1_000_000;
    const cache = new control.SeenCache(() => now);
    const principal = { fingerprint: REQUESTER, pin: REQUESTER_PIN };
    const first = cache.begin(control.SeenCache.key(principal, 'x'), REQUESTER, 'd');
    expect(first.kind).toBe('new');
    if (first.kind === 'new') first.finish({ kind: 'error', code: 'cancelled' });
    expect(cache.begin(control.SeenCache.key(principal, 'x'), REQUESTER, 'd').kind).toBe('same');
    now += control.SEEN_TTL_MS + 1;
    expect(cache.begin(control.SeenCache.key(principal, 'x'), REQUESTER, 'd').kind).toBe('new');
  });

  it('keys by the requester and its certificate: another peer or a new pin never gets an earlier answer', () => {
    const cache = new control.SeenCache();
    const first = cache.begin(control.SeenCache.key({ fingerprint: REQUESTER, pin: REQUESTER_PIN }, 'x'), REQUESTER, 'd');
    if (first.kind === 'new') first.finish({ kind: 'error', code: 'cancelled' });
    expect(cache.begin(control.SeenCache.key({ fingerprint: REQUESTER, pin: 'BB:BB:BB:02' }, 'x'), REQUESTER, 'd').kind).toBe('new');
    expect(cache.begin(control.SeenCache.key({ fingerprint: 'c0:c0', pin: REQUESTER_PIN }, 'x'), 'c0:c0', 'd').kind).toBe('new');
  });

  it('keeps a bounded number per requester, dropping the oldest finished first', () => {
    const cache = new control.SeenCache();
    const key = (i: number) => control.SeenCache.key({ fingerprint: REQUESTER, pin: REQUESTER_PIN }, `k${i}`);
    for (let i = 0; i < control.SEEN_MAX_PER_PEER + 5; i++) {
      const slot = cache.begin(key(i), REQUESTER, 'd');
      if (slot.kind === 'new') slot.finish({ kind: 'error', code: 'cancelled' });
    }
    expect(cache.size).toBe(control.SEEN_MAX_PER_PEER);
    expect(cache.begin(key(0), REQUESTER, 'd').kind).toBe('new');
  });

  it('forgets a revoked requester', async () => {
    await connected();
    await control.request(TARGET, { method: 'POST', path: '/p', body: '{}' }, { requestId: 'r' });
    expect(control._seenSizeForTesting()).toBe(1);
    control.closeFor(REQUESTER, 'both', true);
    expect(control._seenSizeForTesting()).toBe(0);
  });

  it('refuses a second request with an id already in flight on the connection', async () => {
    await connected();
    handler = async () => { await new Promise(() => {}); return ok({}); };
    void control.request(TARGET, { method: 'GET', path: '/a' }, { requestId: 'dup' }).catch(() => {});
    await expect(control.request(TARGET, { method: 'GET', path: '/a' }, { requestId: 'dup' })).rejects.toMatchObject({ code: 'duplicate_id', indeterminate: false });
  });
});

describe('cancellation, timeouts and indeterminate outcomes', () => {
  it('cancelling sends cancel, aborts the handler, and a non-read request is indeterminate', async () => {
    const { requesterWs, targetWs } = await connected();
    let signal: AbortSignal | undefined;
    handler = async (_p, _r, ctx) => { signal = ctx.signal; await new Promise(() => {}); return ok({}); };
    const abort = new AbortController();
    const pending = control.request(TARGET, { method: 'POST', path: '/api/v1/projects/p/git/push', body: '{}' }, { signal: abort.signal });
    await flush();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled', indeterminate: true });
    expect(sentOfType(requesterWs, 'cancel')).toHaveLength(1);
    await flush();
    expect(signal?.aborted).toBe(true);
    // The target sends nothing for a cancelled request.
    expect(sentOfType(targetWs, 'response')).toEqual([]);
    expect(sentOfType(targetWs, 'error')).toEqual([]);
  });

  it('a cancelled read is not indeterminate', async () => {
    await connected();
    handler = async () => { await new Promise(() => {}); return ok({}); };
    const abort = new AbortController();
    const pending = control.request(TARGET, { method: 'GET', path: '/api/v1/projects/p/git/diff' }, { signal: abort.signal });
    await flush();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled', indeterminate: false });
  });

  it('cancel after completion is a no-op, and cancel for an unknown id too', async () => {
    const { targetWs } = await connected();
    const result = await control.request(TARGET, { method: 'POST', path: '/p', body: '{}' }, { requestId: 'done' });
    expect(result.status).toBe(200);
    targetWs.deliver({ v: 1, type: 'cancel', id: 'done' });
    targetWs.deliver({ v: 1, type: 'cancel', id: 'never-sent' });
    await flush();
    expect(targetWs.closed).toBeNull();
    expect(control.hasReverseLink(TARGET)).toBe(true);
  });

  it('a request cancelled on the requester still runs to its end on the target, so a retry learns what happened', async () => {
    await connected();
    let release!: () => void;
    let runs = 0;
    handler = async () => { runs++; await new Promise<void>((resolve) => { release = resolve; }); return ok({ applied: true }); };
    const abort = new AbortController();
    const pending = control.request(TARGET, { method: 'POST', path: '/p', body: '{}' }, { signal: abort.signal, requestId: 'apply' });
    await flush();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled', indeterminate: true });
    release();
    await flush();
    const retry = await control.request(TARGET, { method: 'POST', path: '/p', body: '{}' }, { requestId: 'apply' });
    expect(JSON.parse(retry.body.toString())).toEqual({ applied: true });
    expect(runs).toBe(1);
  });

  it('closing the connection fails everything waiting as transport_unavailable, indeterminate only for non-reads', async () => {
    await connected();
    handler = async () => { await new Promise(() => {}); return ok({}); };
    const write = control.request(TARGET, { method: 'POST', path: '/p', body: '{}' });
    const read = control.request(TARGET, { method: 'GET', path: '/a' });
    await flush();
    control.closeFor(TARGET, 'in');
    await expect(write).rejects.toMatchObject({ code: 'transport_unavailable', indeterminate: true });
    await expect(read).rejects.toMatchObject({ code: 'transport_unavailable', indeterminate: false });
  });

  it('times out on the requester, sending cancel; a non-read is indeterminate', async () => {
    const { requesterWs } = await connected();
    handler = async () => { await new Promise(() => {}); return ok({}); };
    const pending = control.request(TARGET, { method: 'DELETE', path: '/api/v1/group-projects/g/bulletin/topics/t' }, { timeoutMs: 20 });
    await expect(pending).rejects.toMatchObject({ code: 'timeout', indeterminate: true });
    expect(sentOfType(requesterWs, 'cancel')).toHaveLength(1);
  });

  it('the target bounds how long one request may run, and says so', async () => {
    const { targetWs } = await connected();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    handler = async () => { await new Promise(() => {}); return ok({}); };
    targetWs.deliver({ v: 1, type: 'request', id: 'stuck', method: 'GET', path: '/a' });
    await Promise.resolve();
    vi.advanceTimersByTime(control.TARGET_TIMEOUT_MS + 1);
    vi.useRealTimers();
    await flush();
    expect(sentOfType(targetWs, 'error')).toEqual([{ v: 1, type: 'error', id: 'stuck', code: 'timeout' }]);
  });

  it('an answer that arrives after the requester stopped waiting is dropped', async () => {
    const { requesterWs } = await connected();
    requesterWs.deliver({ v: 1, type: 'response', id: 'nobody-waits', status: 200, headers: {}, body: '', encoding: 'utf8' });
    expect(requesterWs.closed).toBeNull();
  });

  it('an error that says the request never ran is not indeterminate', async () => {
    const { targetWs } = await connected();
    handler = async () => { await new Promise(() => {}); return ok({}); };
    for (let i = 0; i < control.MAX_IN_FLIGHT; i++) targetWs.deliver({ v: 1, type: 'request', id: `fill${i}`, method: 'GET', path: '/a' });
    await flush();
    await expect(control.request(TARGET, { method: 'POST', path: '/p', body: '{}' })).rejects.toMatchObject({ code: 'busy', indeterminate: false });
  });
});
