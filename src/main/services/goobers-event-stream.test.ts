import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import { startEventStream, type EventStreamCallbacks, type EventStreamHandle, type StreamTerminalReason } from './goobers-event-stream';
import type { ModelInvalidation } from '../../shared/goobers-api-types';

/** Real local server per test — high-fidelity over mocking `http`, per the
 *  M21 lesson: this module's whole job is behavior under real socket
 *  conditions (silence, mid-stream drops, refused connections), which a
 *  mock can't reproduce honestly. */
function listen(handler: http.RequestListener): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, server });
    });
  });
}

function writeSSEFrame(res: http.ServerResponse, event: string, data: unknown, id?: string): void {
  if (id) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseHeaders(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
}

const FAST_TIMING = { livenessDeadlineMs: 60, initialBackoffMs: 10, maxBackoffMs: 40 };

function collectCallbacks(): EventStreamCallbacks & {
  connected: number;
  invalidations: ModelInvalidation[];
  refetchRequired: number;
  disconnected: number;
  terminal: StreamTerminalReason[];
} {
  const record = {
    connected: 0,
    invalidations: [] as ModelInvalidation[],
    refetchRequired: 0,
    disconnected: 0,
    terminal: [] as StreamTerminalReason[],
    onConnected() { record.connected += 1; },
    onInvalidation(inv: ModelInvalidation) { record.invalidations.push(inv); },
    onRefetchRequired() { record.refetchRequired += 1; },
    onDisconnected() { record.disconnected += 1; },
    onTerminal(reason: StreamTerminalReason) { record.terminal.push(reason); },
  };
  return record;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

let activeServer: http.Server | null = null;
let activeHandle: EventStreamHandle | null = null;

afterEach(async () => {
  activeHandle?.close();
  activeHandle = null;
  if (activeServer) {
    // Several tests deliberately leave a response open forever (the
    // watchdog-silence case) or hanging (a reconnect target the test never
    // exercises) — server.close() alone waits for those sockets to close on
    // their own, which they never will. Force them shut first.
    activeServer.closeAllConnections();
    await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
    activeServer = null;
  }
});

describe('startEventStream — connection and invalidation frames', () => {
  it('reports onConnected on the first frame and parses invalidation payloads', async () => {
    let requestCount = 0;
    const { port, server } = await listen((req, res) => {
      requestCount += 1;
      sseHeaders(res);
      writeSSEFrame(res, 'heartbeat', { cursor: 'c1' });
      writeSSEFrame(res, 'invalidate', { cursor: 'c2', models: ['run'], runIds: ['run-1'] }, 'evt-1');
    });
    activeServer = server;

    const cb = collectCallbacks();
    activeHandle = startEventStream('127.0.0.1', port, cb, FAST_TIMING);

    await waitUntil(() => cb.invalidations.length === 1);
    expect(cb.connected).toBe(1);
    expect(cb.invalidations[0]).toEqual({ cursor: 'c2', models: ['run'], runIds: ['run-1'] });
    expect(requestCount).toBe(1);
  });

  it('treats a heartbeat-only connection as connected without invoking onInvalidation', async () => {
    const { port, server } = await listen((req, res) => {
      sseHeaders(res);
      writeSSEFrame(res, 'heartbeat', { cursor: 'c1' });
    });
    activeServer = server;

    const cb = collectCallbacks();
    activeHandle = startEventStream('127.0.0.1', port, cb, FAST_TIMING);

    await waitUntil(() => cb.connected === 1);
    // Give it a moment to prove no invalidation arrives from a heartbeat.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cb.invalidations).toEqual([]);
  });

  it('sends Last-Event-ID on reconnect using the last cursor observed', async () => {
    const seenLastEventId: (string | undefined)[] = [];
    let attempt = 0;
    const { port, server } = await listen((req, res) => {
      seenLastEventId.push(req.headers['last-event-id'] as string | undefined);
      attempt += 1;
      if (attempt === 1) {
        sseHeaders(res);
        writeSSEFrame(res, 'invalidate', { cursor: 'cursor-abc', models: ['instance'] });
        res.end(); // first connection ends normally -> disconnect + reconnect
        return;
      }
      // Second attempt: just hang (test only cares about the headers sent).
      sseHeaders(res);
    });
    activeServer = server;

    const cb = collectCallbacks();
    activeHandle = startEventStream('127.0.0.1', port, cb, FAST_TIMING);

    await waitUntil(() => seenLastEventId.length >= 2);
    expect(seenLastEventId[0]).toBeUndefined();
    expect(seenLastEventId[1]).toBe('cursor-abc');
  });
});

describe('startEventStream — the liveness watchdog (M21-shaped failure)', () => {
  it('declares the stream dead and reconnects if no frame (not even a heartbeat) arrives within the deadline', async () => {
    // Connects, delivers exactly one frame, then goes silent forever without
    // closing the connection — a half-open stream that looks open at the
    // TCP level. This is precisely the case chirpy-mole asked for: without
    // the watchdog, nothing here would ever call onDisconnected.
    let connectionCount = 0;
    const { port, server } = await listen((req, res) => {
      connectionCount += 1;
      sseHeaders(res);
      if (connectionCount === 1) {
        writeSSEFrame(res, 'heartbeat', { cursor: 'c1' });
        // Never write again, never end — silence.
      } else {
        writeSSEFrame(res, 'heartbeat', { cursor: 'c2' });
      }
    });
    activeServer = server;

    const cb = collectCallbacks();
    activeHandle = startEventStream('127.0.0.1', port, cb, FAST_TIMING);

    await waitUntil(() => cb.connected === 1);
    expect(cb.disconnected).toBe(0);

    // Past the liveness deadline with no second frame — the watchdog must fire.
    await waitUntil(() => cb.disconnected >= 1, 2000);
    await waitUntil(() => connectionCount >= 2, 2000);
  });

  it('does NOT disconnect a stream that keeps sending heartbeats within the deadline', async () => {
    const { port, server } = await listen((req, res) => {
      sseHeaders(res);
      writeSSEFrame(res, 'heartbeat', { cursor: 'c0' });
      const interval = setInterval(() => {
        writeSSEFrame(res, 'heartbeat', { cursor: 'cN' });
      }, FAST_TIMING.livenessDeadlineMs / 2);
      res.on('close', () => clearInterval(interval));
    });
    activeServer = server;

    const cb = collectCallbacks();
    activeHandle = startEventStream('127.0.0.1', port, cb, FAST_TIMING);

    await waitUntil(() => cb.connected === 1);
    // Wait well past one deadline window — a healthy, still-beating stream
    // must never be treated as dead.
    await new Promise((resolve) => setTimeout(resolve, FAST_TIMING.livenessDeadlineMs * 3));
    expect(cb.disconnected).toBe(0);
    expect(cb.terminal).toEqual([]);
  });
});

describe('startEventStream — terminal conditions (no reconnect attempted after)', () => {
  it('401 -> onTerminal("auth-required"), never retries', async () => {
    let requestCount = 0;
    const { port, server } = await listen((req, res) => {
      requestCount += 1;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'nope' } }));
    });
    activeServer = server;

    const cb = collectCallbacks();
    activeHandle = startEventStream('127.0.0.1', port, cb, FAST_TIMING);

    await waitUntil(() => cb.terminal.length === 1);
    expect(cb.terminal).toEqual(['auth-required']);

    await new Promise((resolve) => setTimeout(resolve, FAST_TIMING.maxBackoffMs * 2));
    expect(requestCount).toBe(1); // no retry after terminal
  });

  it('404 -> onTerminal("no-read-model"), never retries', async () => {
    let requestCount = 0;
    const { port, server } = await listen((req, res) => {
      requestCount += 1;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'no route' } }));
    });
    activeServer = server;

    const cb = collectCallbacks();
    activeHandle = startEventStream('127.0.0.1', port, cb, FAST_TIMING);

    await waitUntil(() => cb.terminal.length === 1);
    expect(cb.terminal).toEqual(['no-read-model']);

    await new Promise((resolve) => setTimeout(resolve, FAST_TIMING.maxBackoffMs * 2));
    expect(requestCount).toBe(1);
  });

  it('409 schema_changed -> onTerminal("schema-changed"), never retries', async () => {
    let requestCount = 0;
    const { port, server } = await listen((req, res) => {
      requestCount += 1;
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'schema_changed', message: 'reload the client' } }));
    });
    activeServer = server;

    const cb = collectCallbacks();
    activeHandle = startEventStream('127.0.0.1', port, cb, FAST_TIMING);

    await waitUntil(() => cb.terminal.length === 1);
    expect(cb.terminal).toEqual(['schema-changed']);

    await new Promise((resolve) => setTimeout(resolve, FAST_TIMING.maxBackoffMs * 2));
    expect(requestCount).toBe(1);
  });
});

describe('startEventStream — non-terminal 409s and 400 (refetch + reconnect without cursor)', () => {
  it.each(['epoch_changed', 'feed_truncated', 'stale_cursor'])(
    '409 %s -> onRefetchRequired + onDisconnected, reconnects without Last-Event-ID',
    async (code) => {
      let attempt = 0;
      const seenLastEventId: (string | undefined)[] = [];
      const { port, server } = await listen((req, res) => {
        attempt += 1;
        seenLastEventId.push(req.headers['last-event-id'] as string | undefined);
        if (attempt === 1) {
          sseHeaders(res);
          writeSSEFrame(res, 'invalidate', { cursor: 'stale-cursor-value', models: ['run'] });
          res.end();
          return;
        }
        if (attempt === 2) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code, message: 'refetch and reconnect' } }));
          return;
        }
        sseHeaders(res); // third attempt: just hang, test is done by here
      });
      activeServer = server;

      const cb = collectCallbacks();
      activeHandle = startEventStream('127.0.0.1', port, cb, FAST_TIMING);

      await waitUntil(() => cb.refetchRequired >= 1);
      expect(cb.terminal).toEqual([]);
      await waitUntil(() => seenLastEventId.length >= 3);
      expect(seenLastEventId[1]).toBe('stale-cursor-value'); // sent on the attempt that got refused
      expect(seenLastEventId[2]).toBeUndefined(); // dropped after the refusal
    },
  );

  it('400 invalid_cursor -> reconnects without Last-Event-ID, not terminal', async () => {
    let attempt = 0;
    const seenLastEventId: (string | undefined)[] = [];
    const { port, server } = await listen((req, res) => {
      attempt += 1;
      seenLastEventId.push(req.headers['last-event-id'] as string | undefined);
      if (attempt === 1) {
        sseHeaders(res);
        writeSSEFrame(res, 'invalidate', { cursor: 'bad-cursor', models: ['run'] });
        res.end();
        return;
      }
      if (attempt === 2) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'invalid_cursor', message: 'Last-Event-ID is invalid' } }));
        return;
      }
      sseHeaders(res);
    });
    activeServer = server;

    const cb = collectCallbacks();
    activeHandle = startEventStream('127.0.0.1', port, cb, FAST_TIMING);

    await waitUntil(() => seenLastEventId.length >= 3);
    expect(cb.terminal).toEqual([]);
    expect(seenLastEventId[1]).toBe('bad-cursor');
    expect(seenLastEventId[2]).toBeUndefined();
  });
});

describe('startEventStream — transient failures (503, connection refused, mid-stream error)', () => {
  it('503 -> onDisconnected, reconnects through backoff (covers both recovering and stream_unavailable)', async () => {
    let attempt = 0;
    const { port, server } = await listen((req, res) => {
      attempt += 1;
      if (attempt === 1) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'stream_unavailable', message: 'shutting down' } }));
        return;
      }
      sseHeaders(res);
      writeSSEFrame(res, 'heartbeat', { cursor: 'c1' });
    });
    activeServer = server;

    const cb = collectCallbacks();
    activeHandle = startEventStream('127.0.0.1', port, cb, FAST_TIMING);

    await waitUntil(() => cb.disconnected >= 1);
    expect(cb.terminal).toEqual([]);
    await waitUntil(() => cb.connected === 1);
  });

  it('connection refused -> onDisconnected, keeps retrying through backoff until it succeeds', async () => {
    // Reserve a port, close the server so nothing is listening yet, then
    // start listening again shortly after — proves the module survives a
    // real ECONNREFUSED and reconnects once something is there.
    const { port, server } = await listen((_req, res) => {
      sseHeaders(res);
      writeSSEFrame(res, 'heartbeat', { cursor: 'c1' });
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const cb = collectCallbacks();
    activeHandle = startEventStream('127.0.0.1', port, cb, FAST_TIMING);

    await waitUntil(() => cb.disconnected >= 1);

    const relisten = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((_req, res) => {
        sseHeaders(res);
        writeSSEFrame(res, 'heartbeat', { cursor: 'c1' });
      });
      s.listen(port, '127.0.0.1', () => resolve(s));
    });
    activeServer = relisten;

    await waitUntil(() => cb.connected === 1, 3000);
  });

  it('stream ending mid-flight (server closes the connection) -> onDisconnected, reconnects', async () => {
    let attempt = 0;
    const { port, server } = await listen((req, res) => {
      attempt += 1;
      sseHeaders(res);
      writeSSEFrame(res, 'heartbeat', { cursor: `c${attempt}` });
      if (attempt === 1) {
        setTimeout(() => res.end(), 10); // abrupt but clean end
      }
    });
    activeServer = server;

    const cb = collectCallbacks();
    activeHandle = startEventStream('127.0.0.1', port, cb, FAST_TIMING);

    await waitUntil(() => cb.disconnected >= 1);
    await waitUntil(() => attempt >= 2);
  });
});

describe('startEventStream — close()', () => {
  it('stops all further activity once closed, even past the backoff window', async () => {
    // Deliberately generous backoff here, unlike the rest of this file's
    // FAST_TIMING: this test's assertion depends on close() winning a race
    // against the client's own reconnect pipeline (503 response -> parse ->
    // scheduleReconnect -> timer fires -> connect()) — with FAST_TIMING's
    // 10-40ms window, that whole round trip can complete inside the gap
    // between the server observing the first request and the test's own
    // close() call actually executing, especially under a loaded/slow CI
    // runner (observed flaky on Windows CI). A ~250ms floor makes that race
    // essentially unwinnable for the reconnect side while keeping the test
    // itself well under a second.
    const timing = { livenessDeadlineMs: 60, initialBackoffMs: 250, maxBackoffMs: 250 };
    let requestCount = 0;
    const { port, server } = await listen((req, res) => {
      requestCount += 1;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'stream_unavailable', message: 'shutting down' } }));
    });
    activeServer = server;

    const cb = collectCallbacks();
    const handle = startEventStream('127.0.0.1', port, cb, timing);

    await waitUntil(() => requestCount >= 1);
    handle.close();
    const countAtClose = requestCount;

    await new Promise((resolve) => setTimeout(resolve, timing.maxBackoffMs * 3));
    expect(requestCount).toBe(countAtClose);
  });
});
