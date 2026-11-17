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
import { CONTROL_CLOSE_BACKLOG, CONTROL_CLOSE_PROTOCOL, CONTROL_CLOSE_REVOKED, CONTROL_CLOSE_VERSION, CONTROL_FRAME_MAX_BYTES } from '../../shared/annex-control-protocol';
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
  /** Bytes queued but not written, as ws reports it. */
  bufferedAmount = 0;
  /** While set, write callbacks wait for `drain()`: the frame is queued but not yet written. */
  holdWrites = false;
  private heldWrites: Array<() => void> = [];
  ping() { this.pings++; }
  drain() { const held = this.heldWrites; this.heldWrites = []; for (const cb of held) cb(); }
  send(data: string, cb?: () => void) {
    this.sent.push(JSON.parse(data));
    if (cb) { if (this.holdWrites) this.heldWrites.push(cb); else queueMicrotask(cb); }
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

type Handler = (principal: AnnexPrincipal, request: ControlHttpRequest, ctx: control.DispatchContext) => Promise<control.ControlResult & { complete?: boolean }>;
let handler: Handler;
/** A handler's answer is complete unless it says otherwise (a response cut off before end()). */
const dispatch = vi.fn(async (principal: AnnexPrincipal, request: ControlHttpRequest, ctx: control.DispatchContext): Promise<control.DispatchResult> => ({ complete: true, ...(await handler(principal, request, ctx)) }));

function ok(body: unknown, status = 200): control.ControlResult {
  return { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The server's side of subscriptions: each one's sink, principal and close. */
interface Served { principal: AnnexPrincipal; sink: control.SubscriptionSink; close: ReturnType<typeof vi.fn>; receive: ReturnType<typeof vi.fn> }
let served: Served[] = [];
const subscribeOnServer = vi.fn((principal: AnnexPrincipal, sink: control.SubscriptionSink): control.SubscriptionHandle => {
  const close = vi.fn();
  const receive = vi.fn();
  served.push({ principal, sink, close, receive });
  return { close, receive };
});

function installServer(): void {
  control.setControlTarget({
    // Passed through as sent: the module itself must ask as a reverse caller.
    authorize: (caller) => authorize(caller, deps),
    stillAuthorized: (principal) => stillAuthorized(principal, deps),
    dispatch,
    subscribe: subscribeOnServer,
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
  served = [];
  subscribeOnServer.mockClear();
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

  it('forgets every remembered request when the server stops', async () => {
    await connected();
    await control.request(TARGET, { method: 'POST', path: '/p', body: '{}' }, { requestId: 'before-stop' });
    expect(control._seenSizeForTesting()).toBe(1);
    control.setControlTarget(null);
    expect(control._seenSizeForTesting()).toBe(0);
    installServer();
    await connected();
    await control.request(TARGET, { method: 'POST', path: '/p', body: '{}' }, { requestId: 'before-stop' });
    expect(dispatch).toHaveBeenCalledTimes(2);
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

describe('bounds on lingering work, unfinished answers and unread output (#3613 P3 QA)', () => {
  /** A handler that ignores every signal and finishes only when released. */
  function stubborn() {
    const releases: Array<() => void> = [];
    handler = async () => { await new Promise<void>((resolve) => releases.push(resolve)); return ok({ finished: true }); };
    return { releaseAll: () => { for (const r of releases.splice(0)) r(); } };
  }

  it('a cancelled run that ignores its signal keeps its slot: unique POST and cancel cycles hit busy, then free once handlers finish', async () => {
    await connected();
    const { releaseAll } = stubborn();
    for (let i = 0; i < control.MAX_IN_FLIGHT; i++) {
      const abort = new AbortController();
      const pending = control.request(TARGET, { method: 'POST', path: `/p/${i}`, body: '{}' }, { signal: abort.signal });
      await flush();
      abort.abort();
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    }
    expect(control._activeRunsForTesting(REQUESTER, REQUESTER_PIN)).toBe(control.MAX_IN_FLIGHT);
    await expect(control.request(TARGET, { method: 'POST', path: '/p/next', body: '{}' })).rejects.toMatchObject({ code: 'busy', indeterminate: false });
    await expect(control.request(TARGET, { method: 'GET', path: '/read' })).rejects.toMatchObject({ code: 'busy' });
    expect(dispatch).toHaveBeenCalledTimes(control.MAX_IN_FLIGHT);
    releaseAll();
    await flush();
    expect(control._activeRunsForTesting(REQUESTER, REQUESTER_PIN)).toBe(0);
    handler = async () => ok({ ran: true });
    expect((await control.request(TARGET, { method: 'POST', path: '/p/after', body: '{}' })).status).toBe(200);
  });

  it('closing or replacing the connection frees no slot while the old work still runs', async () => {
    const first = await connected();
    const { releaseAll } = stubborn();
    for (let i = 0; i < control.MAX_IN_FLIGHT; i++) void control.request(TARGET, { method: 'POST', path: `/old/${i}`, body: '{}' }).catch(() => {});
    await flush();
    first.requesterWs.close(1000, 'gone');
    await flush();
    await connected();
    await expect(control.request(TARGET, { method: 'POST', path: '/new', body: '{}' })).rejects.toMatchObject({ code: 'busy' });
    releaseAll();
    await flush();
    handler = async () => ok({ ran: true });
    expect((await control.request(TARGET, { method: 'POST', path: '/new-again', body: '{}' })).status).toBe(200);
  });

  it('unfinished entries count toward the remembered bound and are never dropped: at the bound a new non-read is busy', () => {
    const cache = new control.SeenCache();
    const key = (i: number) => control.SeenCache.key({ fingerprint: REQUESTER, pin: REQUESTER_PIN }, `run${i}`);
    const slots = [];
    for (let i = 0; i < control.SEEN_MAX_PER_PEER; i++) slots.push(cache.begin(key(i), REQUESTER, 'd'));
    expect(cache.begin(key(-1), REQUESTER, 'd').kind).toBe('full');
    expect(cache.size).toBe(control.SEEN_MAX_PER_PEER);
    const one = slots[3];
    if (one.kind === 'new') one.finish({ kind: 'error', code: 'cancelled' });
    expect(cache.begin(key(-1), REQUESTER, 'd').kind).toBe('new');
    // The running ones are all still there.
    expect(cache.begin(key(0), REQUESTER, 'd').kind).toBe('same');
  });

  it('a response cut off before end() is never replayed: a retry gets replay_unavailable, indeterminate', async () => {
    await connected();
    handler = async (_p, _r, ctx) => {
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 200, headers: {}, body: Buffer.alloc(0), complete: false };
    };
    const abort = new AbortController();
    const pending = control.request(TARGET, { method: 'POST', path: '/patch', body: '{}' }, { signal: abort.signal, requestId: 'cut-off' });
    await flush();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled', indeterminate: true });
    await flush();
    await expect(control.request(TARGET, { method: 'POST', path: '/patch', body: '{}' }, { requestId: 'cut-off' }))
      .rejects.toMatchObject({ code: 'replay_unavailable', indeterminate: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('a handler that never ends gets timeout at the deadline, and nothing is remembered as an answer', async () => {
    await connected();
    control._setTargetTimeoutForTesting(30);
    handler = async (_p, _r, ctx) => {
      await new Promise<void>((resolve) => ctx.deadline.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 200, headers: {}, body: Buffer.alloc(0), complete: false };
    };
    await expect(control.request(TARGET, { method: 'POST', path: '/never', body: '{}' }, { requestId: 'never-ends' }))
      .rejects.toMatchObject({ code: 'timeout', indeterminate: true });
    await flush();
    await expect(control.request(TARGET, { method: 'POST', path: '/never', body: '{}' }, { requestId: 'never-ends' }))
      .rejects.toMatchObject({ code: 'replay_unavailable', indeterminate: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(control._activeRunsForTesting(REQUESTER, REQUESTER_PIN)).toBe(0);
  });

  it('holds the slot until the route\'s own work settles, even after its answer went out', async () => {
    await connected();
    let finishWork!: () => void;
    const work = new Promise<void>((resolve) => { finishWork = resolve; });
    handler = async () => ({ ...ok({ answered: true }), operations: work });
    expect((await control.request(TARGET, { method: 'POST', path: '/p', body: '{}' })).status).toBe(200);
    expect(control._activeRunsForTesting(REQUESTER, REQUESTER_PIN)).toBe(1);
    finishWork();
    await flush();
    expect(control._activeRunsForTesting(REQUESTER, REQUESTER_PIN)).toBe(0);
  });

  it('closes the connection when the other side stops reading, failing what waits as transport_unavailable', async () => {
    const { targetWs, requesterWs } = await connected();
    targetWs.bufferedAmount = control.CONTROL_SEND_BUFFER_MAX_BYTES;
    await expect(control.request(TARGET, { method: 'POST', path: '/p', body: '{}' })).rejects.toMatchObject({ code: 'transport_unavailable', indeterminate: true });
    expect(targetWs.closed?.code).toBe(CONTROL_CLOSE_BACKLOG);
    expect(requesterWs.readyState).toBe(3);
    // Closed, not dropped: no answer frame was queued past the bound.
    expect(sentOfType(targetWs, 'response')).toEqual([]);
  });

  it('closes as soon as one answer would take the unwritten bytes past the bound', async () => {
    const { targetWs } = await connected();
    targetWs.bufferedAmount = control.CONTROL_SEND_BUFFER_MAX_BYTES - 100;
    handler = async () => ({ status: 200, headers: {}, body: Buffer.alloc(1000, 0x61) });
    await expect(control.request(TARGET, { method: 'GET', path: '/a' })).rejects.toMatchObject({ code: 'transport_unavailable' });
    expect(targetWs.closed?.code).toBe(CONTROL_CLOSE_BACKLOG);
  });

  it('holds a connection\'s answer slot until the answer is written, not just queued', async () => {
    const { targetWs } = await connected();
    targetWs.holdWrites = true;
    for (let i = 0; i < control.MAX_IN_FLIGHT; i++) targetWs.deliver({ v: 1, type: 'request', id: `w${i}`, method: 'GET', path: '/a' });
    await flush();
    expect(sentOfType(targetWs, 'response')).toHaveLength(control.MAX_IN_FLIGHT);
    expect(control._activeRunsForTesting(REQUESTER, REQUESTER_PIN)).toBe(0);
    targetWs.deliver({ v: 1, type: 'request', id: 'one-more', method: 'GET', path: '/a' });
    await flush();
    expect(sentOfType(targetWs, 'error')).toEqual([{ v: 1, type: 'error', id: 'one-more', code: 'busy' }]);
    targetWs.drain();
    targetWs.deliver({ v: 1, type: 'request', id: 'after-drain', method: 'GET', path: '/a' });
    await flush();
    expect(sentOfType(targetWs, 'response').map((m) => m.id)).toContain('after-drain');
  });
});

describe('reverse subscription (P4)', () => {
  function listen() {
    const frames: Array<Record<string, unknown>> = [];
    const ends: string[] = [];
    return { frames, ends, handlers: { onFrame: (f: Record<string, unknown>) => frames.push(f), onEnd: (c: string) => ends.push(c) } };
  }

  it('subscribes as the requester via reverse, and carries each /ws frame as it was serialized, in order', async () => {
    await connected();
    const heard = listen();
    control.subscribe(TARGET, heard.handlers);
    await flush();
    expect(subscribeOnServer).toHaveBeenCalledTimes(1);
    expect(served[0].principal).toEqual({ fingerprint: REQUESTER, pin: REQUESTER_PIN, role: 'member', via: 'reverse' });
    expect(served[0].sink.send('{"type":"snapshot","payload":{"lastSeq":7}}')).toBe(true);
    expect(served[0].sink.send('{"type":"chat:event","payload":{"agentId":"a"},"seq":8}')).toBe(true);
    await flush();
    expect(heard.frames).toEqual([{ type: 'snapshot', payload: { lastSeq: 7 } }, { type: 'chat:event', payload: { agentId: 'a' }, seq: 8 }]);
    expect(heard.ends).toEqual([]);
  });

  it('sends nothing for a subscription the other side did not agree to', async () => {
    const { requesterWs } = await connected(['request']);
    expect(control.hasReverseLink(TARGET, 'subscribe')).toBe(false);
    expect(() => control.subscribe(TARGET, listen().handlers)).toThrow(expect.objectContaining({ code: 'not_supported' }));
    expect(sentOfType(requesterWs, 'subscribe')).toEqual([]);
  });

  it('a target that agreed to no subscribe answers not_supported and starts nothing', async () => {
    const { targetWs } = await connected(['request']);
    targetWs.deliver({ v: 1, type: 'subscribe', id: 's1' });
    await flush();
    expect(sentOfType(targetWs, 'error')).toEqual([{ v: 1, type: 'error', id: 's1', code: 'not_supported' }]);
    expect(subscribeOnServer).not.toHaveBeenCalled();
  });

  it('one subscription per connection', async () => {
    const { targetWs } = await connected();
    control.subscribe(TARGET, listen().handlers);
    expect(() => control.subscribe(TARGET, listen().handlers)).toThrow(expect.objectContaining({ code: 'busy' }));
    await flush();
    targetWs.deliver({ v: 1, type: 'subscribe', id: 'second' });
    await flush();
    expect(sentOfType(targetWs, 'error')).toEqual([{ v: 1, type: 'error', id: 'second', code: 'busy' }]);
    expect(subscribeOnServer).toHaveBeenCalledTimes(1);
  });

  for (const [name, world_] of [
    ['pending member', { peer: peer({ networkPending: true }) }],
    ['one-to-one controller', { peer: peer({ role: 'controller', kind: undefined }) }],
    ['phone member', { peer: peer({ kind: 'phone' }) }],
    ['removed', {}],
  ] as const) {
    it(`refuses a ${name}, and the server starts nothing`, async () => {
      await connected();
      world = world_ as World;
      const heard = listen();
      control.subscribe(TARGET, heard.handlers);
      await flush();
      expect(heard.ends).toEqual(['authorization_revoked']);
      expect(subscribeOnServer).not.toHaveBeenCalled();
    });
  }

  it('checks every frame: once the subscriber loses access, nothing more goes and the connection closes', async () => {
    const { targetWs } = await connected();
    const heard = listen();
    control.subscribe(TARGET, heard.handlers);
    await flush();
    expect(served[0].sink.send('{"type":"snapshot","payload":{}}')).toBe(true);
    world.peer = undefined;
    expect(served[0].sink.send('{"type":"chat:event","payload":{"secret":true}}')).toBe(false);
    await flush();
    expect(heard.frames).toEqual([{ type: 'snapshot', payload: {} }]);
    expect(heard.ends).toEqual(['authorization_revoked']);
    expect(targetWs.closed?.code).toBe(CONTROL_CLOSE_REVOKED);
    expect(JSON.stringify(targetWs.sent)).not.toContain('secret');
  });

  it('ends a subscription whose frame is too large for the connection, and the subscriber may subscribe again', async () => {
    await connected();
    const heard = listen();
    control.subscribe(TARGET, heard.handlers);
    await flush();
    const big = `{"type":"snapshot","payload":{"x":"${'a'.repeat(CONTROL_FRAME_MAX_BYTES + 128 * 1024)}"}}`;
    expect(served[0].sink.send(big)).toBe(false);
    await flush();
    expect(heard.ends).toEqual(['frame_too_large']);
    control.subscribe(TARGET, listen().handlers);
    await flush();
    expect(subscribeOnServer).toHaveBeenCalledTimes(2);
  });

  it('carries a frame up to the event cap, past the request/response cap', async () => {
    await connected();
    const heard = listen();
    control.subscribe(TARGET, heard.handlers);
    await flush();
    const near = `{"type":"snapshot","payload":{"x":"${'a'.repeat(CONTROL_FRAME_MAX_BYTES - 100)}"}}`;
    expect(served[0].sink.send(near)).toBe(true);
    await flush();
    expect(heard.frames).toHaveLength(1);
  });

  it('the server ending it tells the subscriber why', async () => {
    await connected();
    const heard = listen();
    control.subscribe(TARGET, heard.handlers);
    await flush();
    served[0].sink.end('closed');
    await flush();
    expect(heard.ends).toEqual(['closed']);
    expect(served[0].sink.send('{"type":"snapshot"}')).toBe(false);
  });

  it('unsubscribing stops the server side and is not reported back', async () => {
    await connected();
    const heard = listen();
    const sub = control.subscribe(TARGET, heard.handlers);
    await flush();
    sub.close();
    await flush();
    expect(served[0].close).toHaveBeenCalledTimes(1);
    expect(heard.ends).toEqual([]);
  });

  it('the connection closing ends both sides', async () => {
    await connected();
    const heard = listen();
    control.subscribe(TARGET, heard.handlers);
    await flush();
    control.closeFor(TARGET, 'in');
    await flush();
    expect(served[0].close).toHaveBeenCalledTimes(1);
    expect(heard.ends).toEqual(['transport_unavailable']);
  });

  it('a subscriber that stops reading has its connection closed (4429), not frames dropped', async () => {
    const { targetWs } = await connected();
    const heard = listen();
    control.subscribe(TARGET, heard.handlers);
    await flush();
    targetWs.bufferedAmount = control.CONTROL_SEND_BUFFER_MAX_BYTES;
    expect(served[0].sink.send('{"type":"chat:event","payload":{}}')).toBe(false);
    await flush();
    expect(targetWs.closed?.code).toBe(CONTROL_CLOSE_BACKLOG);
    expect(heard.ends).toEqual(['transport_unavailable']);
    expect(served[0].close).toHaveBeenCalledTimes(1);
  });

  it('a target that serves no stream answers unavailable', async () => {
    control.setControlTarget({ authorize: (caller) => authorize(caller, deps), stillAuthorized: (p) => stillAuthorized(p, deps), dispatch });
    await connected();
    const heard = listen();
    control.subscribe(TARGET, heard.handlers);
    await flush();
    expect(heard.ends).toEqual(['unavailable']);
  });

  it('frames in the wrong direction close the connection', async () => {
    const { requesterWs, targetWs } = await connected();
    requesterWs.deliver({ v: 1, type: 'subscribe', id: 'x' });
    expect(requesterWs.closed?.code).toBe(CONTROL_CLOSE_PROTOCOL);
    const again = await connected();
    again.targetWs.deliver({ v: 1, type: 'event', id: 'x', frame: { type: 'snapshot' } });
    expect(again.targetWs.closed?.code).toBe(CONTROL_CLOSE_PROTOCOL);
    expect(targetWs.readyState).toBe(3);
  });
});

describe('inbound frame caps by type (P4 QA)', () => {
  const pad = (bytes: number) => 'a'.repeat(bytes);

  it('the target refuses a request over 8 MiB and closes 1009, running nothing', async () => {
    const { targetWs } = await connected();
    targetWs.deliver({ v: 1, type: 'request', id: 'big', method: 'POST', path: '/p', body: pad(CONTROL_FRAME_MAX_BYTES + 1) });
    expect(targetWs.closed?.code).toBe(1009);
    await flush();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('the requester refuses a response over 8 MiB and closes 1009; what waited fails as transport_unavailable', async () => {
    const { requesterWs } = await connected();
    handler = async () => { await new Promise(() => {}); return ok({}); };
    const pending = control.request(TARGET, { method: 'GET', path: '/a' }, { requestId: 'r-big' });
    await flush();
    requesterWs.deliver({ v: 1, type: 'response', id: 'r-big', status: 200, headers: {}, body: pad(CONTROL_FRAME_MAX_BYTES + 1), encoding: 'utf8' });
    expect(requesterWs.closed?.code).toBe(1009);
    await expect(pending).rejects.toMatchObject({ code: 'transport_unavailable' });
  });

  it('the requester takes a subscription event up to the event cap', async () => {
    const { requesterWs } = await connected();
    const frames: unknown[] = [];
    const sub = control.subscribe(TARGET, { onFrame: (f) => frames.push(f), onEnd: () => {} });
    requesterWs.deliver({ v: 1, type: 'event', id: sub.id, frame: { type: 'snapshot', payload: { x: pad(CONTROL_FRAME_MAX_BYTES + 32 * 1024) } } });
    expect(requesterWs.closed).toBeNull();
    expect(frames).toHaveLength(1);
  });

  it('the target refuses even an event-shaped frame over 8 MiB: events only go the other way', async () => {
    const { targetWs } = await connected();
    targetWs.deliver({ v: 1, type: 'event', id: 'x', frame: { type: 'snapshot', payload: { x: pad(CONTROL_FRAME_MAX_BYTES + 32 * 1024) } } });
    expect(targetWs.closed?.code).toBe(1009);
  });
});

describe('reverse /ws control frames over a subscription (P5)', () => {
  const noop = { onFrame: () => {}, onEnd: () => {} };

  it('hands an allowed control frame to the server for the subscription, as /ws text', async () => {
    await connected();
    const sub = control.subscribe(TARGET, noop);
    await flush();
    expect(sub.send({ type: 'pty:input', payload: { agentId: 's1', data: 'ls\r' } })).toBe(true);
    await flush();
    expect(served[0].receive).toHaveBeenCalledWith(JSON.stringify({ type: 'pty:input', payload: { agentId: 's1', data: 'ls\r' } }));
  });

  it('sends no control frame unless the other side agreed to ws-control, and a target that did not closes on one', async () => {
    const { requesterWs } = await connected(['request', 'subscribe']);
    const sub = control.subscribe(TARGET, noop);
    await flush();
    expect(sub.send({ type: 'pty:input', payload: {} })).toBe(false);
    expect(sentOfType(requesterWs, 'client')).toEqual([]);
    const other = await connected(['request', 'subscribe']);
    control.subscribe(TARGET, noop);
    await flush();
    other.targetWs.deliver({ v: 1, type: 'client', id: 'x', frame: { type: 'pty:input', payload: {} } });
    expect(other.targetWs.closed?.code).toBe(CONTROL_CLOSE_PROTOCOL);
  });

  it('only the /ws control set: anything else is not sent, and a target answers it on the subscription without running it', async () => {
    const { targetWs } = await connected();
    const frames: Array<Record<string, unknown>> = [];
    const sub = control.subscribe(TARGET, { onFrame: (f) => frames.push(f), onEnd: () => {} });
    await flush();
    for (const type of ['telemetry:hello', 'replay', 'mobile:replay', 'made:up']) expect(sub.send({ type })).toBe(false);
    targetWs.deliver({ v: 1, type: 'client', id: sub.id, frame: { type: 'telemetry:hello', payload: {} } });
    targetWs.deliver({ v: 1, type: 'client', id: sub.id, frame: { type: 'replay', since: 0 } });
    await flush();
    expect(served[0].receive).not.toHaveBeenCalled();
    expect(frames).toEqual([
      { type: 'error', payload: { message: 'not_allowed_over_reverse', frameType: 'telemetry:hello' } },
      { type: 'error', payload: { message: 'not_allowed_over_reverse', frameType: 'replay' } },
    ]);
    expect(targetWs.closed).toBeNull();
  });

  it('a subscriber that lost access: its control frame never reaches the server, the subscription ends and the connection closes', async () => {
    const { targetWs } = await connected();
    const ends: string[] = [];
    const sub = control.subscribe(TARGET, { onFrame: () => {}, onEnd: (c) => ends.push(c) });
    await flush();
    world.peer = undefined;
    targetWs.deliver({ v: 1, type: 'client', id: sub.id, frame: { type: 'agent:kill', payload: { agentId: 'a' } } });
    await flush();
    expect(served[0].receive).not.toHaveBeenCalled();
    expect(served[0].close).toHaveBeenCalledTimes(1);
    expect(ends).toEqual(['authorization_revoked']);
    expect(targetWs.closed?.code).toBe(CONTROL_CLOSE_REVOKED);
  });

  it('drops a control frame for a subscription that is not the live one', async () => {
    const { targetWs } = await connected();
    control.subscribe(TARGET, noop);
    await flush();
    targetWs.deliver({ v: 1, type: 'client', id: 'stale', frame: { type: 'pty:input', payload: {} } });
    await flush();
    expect(served[0].receive).not.toHaveBeenCalled();
    expect(targetWs.closed).toBeNull();
  });

  it('a control frame over 8 MiB closes the connection 1009 before it is parsed', async () => {
    const { targetWs } = await connected();
    const sub = control.subscribe(TARGET, noop);
    await flush();
    targetWs.deliver({ v: 1, type: 'client', id: sub.id, frame: { type: 'clipboard:image', payload: { base64: 'a'.repeat(CONTROL_FRAME_MAX_BYTES) } } });
    expect(targetWs.closed?.code).toBe(1009);
    expect(served[0].receive).not.toHaveBeenCalled();
  });
});

