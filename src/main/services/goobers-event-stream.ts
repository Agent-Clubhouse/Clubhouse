/**
 * SSE client for the Goobers daemon's invalidation feed (spec §12/M26),
 * `GET /api/v1/events`. Modeled on `goobers-http.ts` (plain node `http`,
 * loopback-only, never TLS) but long-lived and incremental rather than
 * one-shot.
 *
 * The payload is `Invalidation{cursor, models[], runIds[], workflows[]}`
 * (`goobers/internal/apicontract/wiretypes.go:4-9`) — it tells a client WHAT
 * to refetch, not a human-readable log. Frames are `text/event-stream` with
 * three possible `event:` types (`goobers/internal/httpapi/feedstream.go`):
 * `snapshot` (catch-up on resume, same payload shape as a live change),
 * `invalidate` (a live change), and `heartbeat` (`{cursor}` only, no models).
 *
 * Contractual liveness (`feedstream.go:50-52`): the server sends a heartbeat
 * every `HEARTBEAT_INTERVAL_MS` specifically so the client can arm a
 * deadline against it. A half-open TCP connection reads as open forever —
 * `read()` simply never returns — so "the socket hasn't errored" is not
 * evidence the stream is alive. This module treats ANY frame (heartbeat or
 * invalidation) as a liveness signal and declares the stream dead if none
 * arrives within the deadline, closing and reconnecting through backoff.
 *
 * Polling is not a fallback path this module reaches for on failure — it is
 * the state the caller is already in, and this module's whole job is to
 * report "connected" / "invalidation" / "disconnected" / "terminal" clearly
 * enough that the caller (`GoobersService`) never has a reason to believe a
 * dead stream is still doing its job. See M21's postmortem (a one-shot
 * `fs.watch` with no polling fallback that froze the panel at "Starting…"
 * forever) for why that property is non-negotiable here.
 */
import * as http from 'http';
import { parseJsonBody } from './goobers-http';
import type { ModelInvalidation } from '../../shared/goobers-api-types';

/** Contractual (feedstream.go:50-52); actual interval from
 *  internal/readmodel/feed.go:187. */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** 2x the heartbeat interval: tolerates one delayed/lost heartbeat from
 *  ordinary network jitter without flapping the connection, while still
 *  catching a genuinely dead half-open socket within a bounded 30s rather
 *  than "eventually." */
const LIVENESS_DEADLINE_MS = HEARTBEAT_INTERVAL_MS * 2;

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Conditions under which further SSE attempts are pointless until something
 * external changes — the caller should stop reconnecting and rely on the
 * normal poll indefinitely, not retry every backoff tick forever:
 * - `auth-required`: 401. The route sits behind `Authenticate`
 *   (unlike `/readyz`); we don't source/send a credential this phase, same
 *   as the existing `/instance`/`/health` 401 handling.
 * - `no-read-model`: 404. A topology with no read model registers no
 *   `/api/v1/events` route at all (`internal/httpapi/router.go:599-600`,
 *   `:997-1002`) — this daemon will never provide live updates.
 * - `schema-changed`: 409 `schema_changed`. The server's own message is
 *   "reload the client" — unlike the other two 409 conditions, this is not
 *   safe to just refetch-and-reconnect from, since our own parsing code may
 *   now be wrong for the new schema.
 */
export type StreamTerminalReason = 'auth-required' | 'no-read-model' | 'schema-changed';

export interface EventStreamCallbacks {
  /** The stream delivered its first frame (heartbeat or invalidation) on a
   *  fresh connection — confirmed live, not just "connected." */
  onConnected(): void;
  /** A `snapshot` or `invalidate` frame arrived. */
  onInvalidation(invalidation: ModelInvalidation): void;
  /** 409 `epoch_changed`/`feed_truncated`/`stale_cursor` — the server's own
   *  message for all three: "refetch current read endpoints and reconnect
   *  without Last-Event-ID." Not terminal; the module already drops the
   *  cursor and reconnects through backoff on its own — this callback is
   *  only the refetch instruction. */
  onRefetchRequired(): void;
  /** The stream is not currently live — a dead-stream (watchdog), refused,
   *  or errored connection. The module will keep retrying through backoff
   *  unless/until a terminal condition is hit. Caller should narrow any
   *  widened poll interval back to normal immediately. */
  onDisconnected(): void;
  /** See `StreamTerminalReason`. The module stops attempting reconnects for
   *  this handle's lifetime once this fires. */
  onTerminal(reason: StreamTerminalReason): void;
}

export interface EventStreamHandle {
  close(): void;
}

/** Overridable for tests — production call sites should not pass this,
 *  letting the contractual defaults above apply. Real short (tens-of-ms)
 *  timeouts against a real local server are more honest than mocking the
 *  clock underneath real socket I/O would be. */
export interface EventStreamTiming {
  livenessDeadlineMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

interface ParsedErrorBody {
  error?: { code?: string; message?: string };
}

function readBody(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve(body));
  });
}

/**
 * Starts (and, until `.close()` is called, keeps alive across reconnects) a
 * subscription to `GET /api/v1/events`. Never throws — every failure mode is
 * reported through `callbacks`.
 */
export function startEventStream(
  host: string,
  port: number,
  callbacks: EventStreamCallbacks,
  timing: EventStreamTiming = {},
): EventStreamHandle {
  const livenessDeadlineMs = timing.livenessDeadlineMs ?? LIVENESS_DEADLINE_MS;
  const initialBackoffMs = timing.initialBackoffMs ?? INITIAL_BACKOFF_MS;
  const maxBackoffMs = timing.maxBackoffMs ?? MAX_BACKOFF_MS;

  let closed = false;
  let cursor: string | undefined;
  let backoffMs = initialBackoffMs;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let currentRequest: http.ClientRequest | null = null;
  let connectedThisAttempt = false;

  function clearWatchdog(): void {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  }

  function armWatchdog(): void {
    clearWatchdog();
    watchdog = setTimeout(() => {
      // No frame within the deadline. The socket may still look open — a
      // half-open TCP connection blocks forever on read() — but the
      // contract's own heartbeat guarantee means silence this long can only
      // mean the stream is dead. Destroying the request drives its 'error'
      // (or 'close' with no prior 'end') handler, which routes to the same
      // disconnect/reconnect path as any other transport failure.
      currentRequest?.destroy(new Error('sse-liveness-deadline-exceeded'));
    }, livenessDeadlineMs);
  }

  function scheduleReconnect(): void {
    if (closed) return;
    const cap = Math.min(backoffMs, maxBackoffMs);
    const delay = Math.random() * cap; // full jitter
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function handleTerminal(reason: StreamTerminalReason): void {
    closed = true;
    clearWatchdog();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    currentRequest?.destroy();
    callbacks.onTerminal(reason);
  }

  function handleDisconnect(): void {
    clearWatchdog();
    callbacks.onDisconnected();
    scheduleReconnect();
  }

  function handleFrame(raw: string): void {
    let id: string | undefined;
    let type = 'message';
    let dataLine = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLine = line.slice(5).trim();
    }

    // Any frame at all is a liveness signal — reset the deadline before
    // doing anything else with it.
    armWatchdog();
    if (!connectedThisAttempt) {
      connectedThisAttempt = true;
      backoffMs = initialBackoffMs;
      callbacks.onConnected();
    }

    if (type === 'heartbeat') {
      const parsed = parseJsonBody<{ cursor?: string }>(dataLine);
      if (parsed?.cursor) cursor = parsed.cursor;
      return;
    }

    // 'snapshot' or 'invalidate' — both carry an Invalidation payload.
    const invalidation = parseJsonBody<ModelInvalidation>(dataLine);
    if (!invalidation) return;
    cursor = invalidation.cursor || id || cursor;
    callbacks.onInvalidation(invalidation);
  }

  function connect(): void {
    if (closed) return;
    connectedThisAttempt = false;
    let buffer = '';

    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (cursor) headers['Last-Event-ID'] = cursor;

    const req = http.request({ host, port, path: '/api/v1/events', headers }, (res) => {
      const status = res.statusCode ?? 0;

      if (status === 200) {
        // Arm the watchdog on the response itself, not just per-frame — a
        // resume whose cursor is already current can go up to one full
        // heartbeat interval before its first frame (the server flushes
        // headers immediately per eventstream.go, but sends no synthetic
        // frame just to say "connected").
        armWatchdog();
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const rawFrame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (rawFrame.trim()) handleFrame(rawFrame);
          }
        });
        res.on('end', () => handleDisconnect());
        res.on('error', () => handleDisconnect());
        return;
      }

      void readBody(res).then((body) => {
        const parsed = parseJsonBody<ParsedErrorBody>(body);
        const code = parsed?.error?.code;

        if (status === 401) {
          handleTerminal('auth-required');
          return;
        }
        if (status === 404) {
          handleTerminal('no-read-model');
          return;
        }
        if (status === 409 && code === 'schema_changed') {
          handleTerminal('schema-changed');
          return;
        }
        if (status === 409 && (code === 'epoch_changed' || code === 'feed_truncated' || code === 'stale_cursor')) {
          cursor = undefined;
          callbacks.onRefetchRequired();
          handleDisconnect();
          return;
        }
        if (status === 400) {
          // invalid_cursor — a cursor we ourselves sent was rejected; drop
          // it and retry without one rather than repeating the same 400.
          cursor = undefined;
          handleDisconnect();
          return;
        }
        // 503 (daemon recovering, or the stream shutting down) or anything
        // else unrecognized — transient, retry through backoff.
        handleDisconnect();
      });
    });

    currentRequest = req;
    req.on('error', () => {
      if (closed) return;
      handleDisconnect();
    });
    req.end();
  }

  connect();

  return {
    close(): void {
      closed = true;
      clearWatchdog();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      currentRequest?.destroy();
    },
  };
}
