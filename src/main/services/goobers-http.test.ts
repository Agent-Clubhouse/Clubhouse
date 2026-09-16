/**
 * Tests for the hand-rolled Goobers HTTP client (spec §7.6/§7.3/§7.9/§9.2).
 *
 * Mocks at the `http` module boundary (node's `http.get`) rather than
 * mocking this module or `process.platform` — the timeout/destroy/teardown
 * behaviour under test is Node socket semantics, not a platform branch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

class FakeClientRequest extends EventEmitter {
  destroyed = false;
  timeoutMs: number | null = null;
  private timeoutCb: (() => void) | null = null;

  setTimeout(ms: number, cb: () => void): this {
    this.timeoutMs = ms;
    this.timeoutCb = cb;
    return this;
  }

  /** Simulates the underlying socket firing its idle timeout, exactly as
   *  node would invoke the callback passed to `req.setTimeout()`. */
  fireTimeout(): void {
    this.timeoutCb?.();
  }

  destroy(err?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (err) this.emit('error', err);
    this.emit('close');
    return this;
  }
}

class FakeIncomingMessage extends EventEmitter {
  statusCode: number | undefined;
  constructor(statusCode: number) {
    super();
    this.statusCode = statusCode;
  }
  respond(body: string): void {
    this.emit('data', Buffer.from(body));
    this.emit('end');
  }
}

interface FakeRequestOptions {
  host: string;
  port: number;
  path: string;
  headers?: Record<string, string>;
}

type FakeCallback = (res: FakeIncomingMessage) => void;

const httpGetMock = vi.fn();

vi.mock('http', () => ({
  get: (...args: unknown[]) => httpGetMock(...args),
}));

import { httpGetJson, parseJsonBody, destroyAllRequests, activeRequestCountForTests, type HttpResult } from './goobers-http';

interface StartedRequest {
  promise: Promise<HttpResult>;
  req: FakeClientRequest;
  options: FakeRequestOptions;
  respond: (res: FakeIncomingMessage) => void;
}

/** Drives one `httpGetJson()` call: captures the fake request node created
 *  and the options it was called with, without resolving/rejecting it. */
function startRequest(timeoutMs = 2000): StartedRequest {
  let capturedOptions!: FakeRequestOptions;
  let capturedReq!: FakeClientRequest;
  let capturedCallback!: FakeCallback;
  httpGetMock.mockImplementationOnce((options: FakeRequestOptions, callback: FakeCallback) => {
    capturedOptions = options;
    capturedCallback = callback;
    capturedReq = new FakeClientRequest();
    return capturedReq;
  });
  const promise = httpGetJson('127.0.0.1', 8080, '/readyz', timeoutMs);
  return {
    promise,
    req: capturedReq,
    options: capturedOptions,
    respond: (res: FakeIncomingMessage) => capturedCallback(res),
  };
}

beforeEach(() => {
  httpGetMock.mockReset();
  // Drain any requests left registered from a prior test so
  // activeRequestCountForTests() starts clean.
  destroyAllRequests();
});

describe('httpGetJson', () => {
  it('resolves with status and body on a successful GET, and the body parses as JSON', async () => {
    const { promise, options, respond } = startRequest();
    expect(options.host).toBe('127.0.0.1');
    expect(options.port).toBe(8080);
    expect(options.path).toBe('/readyz');

    const res = new FakeIncomingMessage(200);
    respond(res);
    res.respond('{"ok":true}');

    const result = await promise;
    expect(result).toEqual({ status: 200, body: '{"ok":true}' });
    expect(parseJsonBody(result.body)).toEqual({ ok: true });
  });

  it('resolves (does not reject) on a non-2xx status, carrying the status through', async () => {
    const { promise, respond } = startRequest();
    const res = new FakeIncomingMessage(503);
    respond(res);
    res.respond('{"error":"not ready"}');

    const result = await promise;
    expect(result.status).toBe(503);
    expect(parseJsonBody(result.body)).toEqual({ error: 'not ready' });
  });

  it('destroys the request when the socket idle-timeout fires, within the given connectTimeoutMs', async () => {
    const { promise, req } = startRequest(2500);
    expect(req.timeoutMs).toBe(2500);

    const destroySpy = vi.spyOn(req, 'destroy');
    req.fireTimeout();

    expect(destroySpy).toHaveBeenCalledTimes(1);
    const [err] = destroySpy.mock.calls[0];
    expect(err).toBeInstanceOf(Error);

    await expect(promise).rejects.toThrow();
  });

  it('rejects on ECONNREFUSED (daemon not listening / stale address file)', async () => {
    const { promise, req } = startRequest();
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), { code: 'ECONNREFUSED' });
    req.emit('error', err);

    await expect(promise).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('removes the request from the active set once it closes', async () => {
    const { promise, req, respond } = startRequest();
    expect(activeRequestCountForTests()).toBe(1);

    const res = new FakeIncomingMessage(200);
    respond(res);
    res.respond('{}');
    await promise;

    // http.ClientRequest emits 'close' after the response completes in real
    // Node; simulate that so the tracking Set is exercised end-to-end.
    req.emit('close');
    expect(activeRequestCountForTests()).toBe(0);
  });
});

describe('parseJsonBody', () => {
  it('parses valid JSON', () => {
    expect(parseJsonBody<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null for malformed JSON rather than throwing', () => {
    expect(parseJsonBody('not json{')).toBeNull();
  });

  it('returns null for truncated JSON (a body cut short mid-write) rather than throwing', () => {
    expect(parseJsonBody('{"instance":{"instanceRoot":"/foo"')).toBeNull();
  });

  it('returns null for an empty body rather than throwing', () => {
    expect(parseJsonBody('')).toBeNull();
  });
});

describe('destroyAllRequests', () => {
  it('destroys every in-flight request and drains the active set to zero', () => {
    const first = startRequest();
    const second = startRequest();
    expect(activeRequestCountForTests()).toBe(2);

    const firstDestroy = vi.spyOn(first.req, 'destroy');
    const secondDestroy = vi.spyOn(second.req, 'destroy');

    destroyAllRequests();

    expect(firstDestroy).toHaveBeenCalledTimes(1);
    expect(secondDestroy).toHaveBeenCalledTimes(1);
    expect(activeRequestCountForTests()).toBe(0);
  });

  it('is a no-op when there are no in-flight requests', () => {
    expect(activeRequestCountForTests()).toBe(0);
    expect(() => destroyAllRequests()).not.toThrow();
    expect(activeRequestCountForTests()).toBe(0);
  });
});
