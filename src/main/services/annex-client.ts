/**
 * Annex V2 Client — Service Discovery & Connection (#862)
 *
 * Bonjour browser for `_clubhouse-annex._tcp` services, filtered against the
 * peer list. Manages per-satellite state machines and mTLS WebSocket connections.
 * Stores snapshots per satellite and forwards events to the renderer via IPC.
 */
import * as https from 'https';
import * as http from 'http';
import * as net from 'net';
import * as tls from 'tls';
import type Bonjour from 'bonjour-service';
import type { Browser, Service as RemoteService } from 'bonjour-service';
import { createBonjour } from './annex-mdns';
import { formatAddress, parseTypedHost, rankAddresses, reachCandidates, rememberHost, type ReachAddress } from './annex-reach';
import { WebSocket } from 'ws';
import * as annexIdentity from './annex-identity';
import * as annexTls from './annex-tls';
import * as annexPeers from './annex-peers';
import * as annexSettings from './annex-settings';
import * as headlessTerminal from './pty-headless-terminal';
import { appLog } from './log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { IPC } from '../../shared/ipc-channels';
import type { DigestSince } from '../../shared/group-project-types';
import { encodeDigestSince } from '../../shared/digest-since';
import { parsePairingUrl } from './annex-pairing-url';
import { devicesChanged } from './annex-device-signal';
import {
  annexProblemText,
  classifyConnectionError,
  classifyRefusal,
  describeAnnexProblem,
  type AnnexProblem,
  type AnnexProblemCode,
} from '../../shared/annex-problems';
import { ANNEX_PROTOCOL_VERSION } from '../../shared/types';
import { ANNEX_BUFFER_HEADERS, windowsPtyForHost } from '../../shared/annex-pty';
import { unseenPtySuffix } from '../../shared/pty-seq';
import type { WindowsPtyInfo } from '../../shared/windows-pty';
import { ATTR } from '../../shared/telemetry/attributes';
import { currentTraceparent, tel } from '../telemetry/facade';
import {
  connectAuthMode,
  connectFailed,
  connectStarted,
  connectSucceeded,
  disconnectReasonFor,
  connectErrorFor,
  pairFlow,
  pairResultFor,
  recordDisconnect,
  recordDiscover,
  recordHeartbeatRtt,
  recordReconnectScheduled,
} from '../telemetry/annex-telemetry';

/** Telemetry: when the last heartbeat ping was sent, per satellite connection. */
const pingSentAt = new WeakMap<object, number>();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SatelliteState = 'disconnected' | 'discovering' | 'connecting' | 'connected';

export interface SatelliteConnection {
  id: string; // fingerprint of the satellite
  alias: string;
  icon: string;
  color: string;
  fingerprint: string;
  state: SatelliteState;
  host: string;
  mainPort: number;
  pairingPort: number;
  snapshot: SatelliteSnapshot | null;
  lastError: string | null;
  /** This connection's satellite said it can't build a snapshot yet, and is retrying. `snapshot` is from before, if there is one. */
  snapshotUnavailable?: boolean;
  /** Refused as not (or no longer) paired: pair again to connect. */
  needsPairing?: boolean;
  /** Why the last attempt failed, and what to do. `lastError` is the same as one line. */
  problem?: AnnexProblem;
}

export interface SatelliteSnapshot {
  projects: unknown[];
  agents: Record<string, unknown[]>;
  quickAgents: Record<string, unknown[]>;
  theme: unknown;
  orchestrators: unknown;
  pendingPermissions: unknown[];
  lastSeq: number;
  plugins?: unknown[];
  protocolVersion?: number;
  groupProjects?: unknown[];
  bulletinDigests?: Record<string, unknown[]>;
  groupProjectMembers?: Record<string, Array<{ agentId: string; agentName: string; status: string }>>;
  /** Unvalidated; read through `windowsPtyForHost`. */
  ptyHost?: unknown;
  canvasState?: Record<string, unknown>;
  appCanvasState?: unknown;
  /** The satellite left these out for size. A field here is unknown, not empty. */
  snapshotTruncated?: { omitted?: string[] };
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let bonjourBrowser: Browser | null = null;
let bonjourInstance: InstanceType<typeof Bonjour> | null = null;
const satellites = new Map<string, SatelliteConnectionInternal>();

/** Discovered but unpaired services visible on the LAN. */
export interface DiscoveredService {
  fingerprint: string;
  alias: string;
  icon: string;
  color: string;
  host: string;
  mainPort: number;
  pairingPort: number;
  publicKey: string;
}

const discoveredServices = new Map<string, DiscoveredService>();

interface SatelliteConnectionInternal {
  snapshotUnavailable?: boolean;
  id: string;
  alias: string;
  icon: string;
  color: string;
  fingerprint: string;
  state: SatelliteState;
  host: string;
  mainPort: number;
  pairingPort: number;
  snapshot: SatelliteSnapshot | null;
  lastError: string | null;
  /** The classified reason behind `lastError`. */
  problem?: { code: AnnexProblemCode; status?: number } | null;
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  /** Refused as not (or no longer) paired: no automatic reconnects until it's paired again. */
  needsPairing: boolean;
  /** Why automatic reconnects stopped, if they did. A mismatch may still try a newly announced address once. */
  halt?: 'pairing' | 'mismatch' | 'clock' | null;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  pongTimeout: ReturnType<typeof setTimeout> | null;
  /** What Bonjour announced for it while this machine has been running (#3058). */
  discovered?: ReachAddress | null;
  /** Which of its candidate addresses the current attempt uses. */
  candidateIndex?: number;
}

// Heartbeat constants
const HEARTBEAT_INTERVAL_MS = 30_000;  // 30s ping
const PONG_TIMEOUT_MS = 10_000;        // 10s pong timeout → dead

// ---------------------------------------------------------------------------
// Remote PTY buffer cache
//
// The controller caches remote agent PTY data locally using headless terminals
// so that switching away from a remote agent tab and back restores the terminal
// instantly without a network round-trip to the satellite. Without this cache,
// the HTTPS buffer fetch to the satellite may fail silently (timeout, TLS issue,
// etc.), leaving the terminal blank.
// ---------------------------------------------------------------------------

/** Namespace prefix for remote buffer keys to avoid collision with local agents. */
function remoteBufferKey(satelliteId: string, agentId: string): string {
  return `remote:${satelliteId}:${agentId}`;
}

/** Track which remote agents have had their local cache seeded from the satellite. */
const seededBuffers = new Set<string>();

/** A remote agent's buffer as the renderer replays it (#2324). */
export interface RemoteBufferSnapshot {
  data: string;
  /**
   * Controller-side output seq `data` includes. Every forwarded `pty:data`
   * carries the same counter as `seq`, so the renderer can drop live chunks
   * already in the snapshot, as it does for local PTYs.
   */
  seq: number;
}

interface RemoteStreamState {
  /** Running count of UTF-16 code units received for this agent. */
  seq: number;
  /** Chunks received while a seed fetch is in flight, else null. */
  seeding: Array<{ data: string; outputSeq?: number }> | null;
  /**
   * Highest satellite output seq in the cache, once seeded from a satellite
   * that sends seqs. WebSocket and HTTPS are separate connections, so a chunk
   * the /buffer response already holds can still arrive after it; this lets
   * that chunk be dropped (#2324). Cleared on disconnect, since a restarted
   * satellite counts from zero again.
   */
  satelliteSeq?: number;
}

/**
 * Keyed like `seededBuffers`. Kept across disconnects so the seq never goes
 * backwards for a renderer holding an older snapshot.
 */
const remoteStreams = new Map<string, RemoteStreamState>();
const seedsInFlight = new Map<string, Promise<void>>();
/** Bumped on every disconnect, so a seed that straddles one is discarded. */
const connectionEpochs = new Map<string, number>();

function remoteStream(key: string): RemoteStreamState {
  let state = remoteStreams.get(key);
  if (!state) {
    state = { seq: 0, seeding: null };
    remoteStreams.set(key, state);
  }
  return state;
}

/** xterm's `windowsPty` hint for a satellite's PTYs, from its snapshot (#2352). */
function satelliteWindowsPty(satelliteId: string): WindowsPtyInfo | undefined {
  return windowsPtyForHost(satellites.get(satelliteId)?.snapshot?.ptyHost);
}

/**
 * Cache incoming PTY data for a remote agent in a local headless terminal.
 * Called whenever a pty:data event arrives via WebSocket. `outputSeq` is the
 * satellite's seq for the chunk, when it sends one. Returns the part of the
 * chunk not already cached (empty if all of it was) and the controller-side
 * seq at its end.
 */
export function cacheRemotePtyData(
  satelliteId: string, agentId: string, data: string, outputSeq?: number,
): { data: string; seq: number } {
  const key = `${satelliteId}:${agentId}`;
  const state = remoteStream(key);
  if (state.satelliteSeq !== undefined && outputSeq !== undefined) {
    data = unseenPtySuffix(data, outputSeq, state.satelliteSeq);
    state.satelliteSeq = Math.max(state.satelliteSeq, outputSeq);
    if (!data) return { data, seq: state.seq };
  }
  state.seq += data.length;
  state.seeding?.push({ data, outputSeq });
  const bufferKey = remoteBufferKey(satelliteId, agentId);
  // A new cache (first output, or the old one was disposed) has no history.
  if (headlessTerminal.ensure(bufferKey, { windowsPty: satelliteWindowsPty(satelliteId) })) {
    seededBuffers.delete(key);
  }
  headlessTerminal.feedData(bufferKey, data, state.seq);
  return { data, seq: state.seq };
}

/**
 * Resize the local headless terminal cache for a remote agent.
 * Should be called whenever the renderer resizes a remote agent's terminal.
 */
export function resizeRemoteBuffer(satelliteId: string, agentId: string, cols: number, rows: number): void {
  headlessTerminal.resize(remoteBufferKey(satelliteId, agentId), cols, rows);
}

/**
 * Get the locally cached buffer for a remote agent.
 * Returns the serialized terminal state from the local headless terminal.
 */
export function getLocalRemoteBuffer(satelliteId: string, agentId: string): string {
  return headlessTerminal.serialize(remoteBufferKey(satelliteId, agentId));
}

/**
 * Dispose all cached headless terminals for a specific satellite.
 */
function disposeRemoteBuffers(satelliteId: string): void {
  // Iterate all headless terminal keys and dispose those matching this satellite.
  // The headless terminal module doesn't expose iteration, so we track keys ourselves.
  // Instead, we clear seeded status; buffers are cleaned up lazily or on forget.
  for (const key of seededBuffers) {
    if (key.startsWith(`${satelliteId}:`)) {
      seededBuffers.delete(key);
    }
  }
  for (const [key, state] of remoteStreams) {
    if (key.startsWith(`${satelliteId}:`)) state.satelliteSeq = undefined;
  }
  connectionEpochs.set(satelliteId, (connectionEpochs.get(satelliteId) ?? 0) + 1);
}

/** Shown in place of a terminal's history when its satellite can't send it. */
const TERMINAL_UNAVAILABLE_NOTICE = '[Clubhouse: this terminal\'s earlier output is too large to load here. New output appears below, and its screen may be out of step until it next redraws.]\r\n';

interface SatelliteBuffer {
  data: string;
  /** Satellite output seq the buffer includes; absent from older satellites. */
  seq?: number;
  cols?: number;
  rows?: number;
  /** The satellite can't send this terminal's state. */
  unavailable?: boolean;
}

function headerInt(res: http.IncomingMessage, name: string): number | undefined {
  const raw = res.headers[name];
  const value = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function fetchSatelliteBuffer(sat: SatelliteConnectionInternal, agentId: string): Promise<SatelliteBuffer | null> {
  const tlsOptions = pinnedTlsOptionsFor(sat.fingerprint);
  const satelliteId = sat.id;

  return new Promise<SatelliteBuffer | null>((resolve) => {
    let resolved = false;
    const once = (val: SatelliteBuffer | null) => { if (!resolved) { resolved = true; resolve(val); } };
    const url = satelliteUrl(sat, `/api/v1/agents/${encodeURIComponent(agentId)}/buffer`);
    const req = https.get(url, { ...tlsOptions, timeout: 5000 }, (res) => {
      if (res.statusCode === 503) {
        res.resume();
        once({ data: '', unavailable: true });
        return;
      }
      if (res.statusCode !== 200) {
        drainRefusal(sat, res);
        once(null);
        return;
      }
      const cols = headerInt(res, ANNEX_BUFFER_HEADERS.cols);
      const rows = headerInt(res, ANNEX_BUFFER_HEADERS.rows);
      const meta = {
        seq: headerInt(res, ANNEX_BUFFER_HEADERS.seq),
        ...(cols && rows && { cols, rows }),
      };
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => once({ data: Buffer.concat(chunks).toString('utf-8'), ...meta }));
      // A connection reset mid-body ends with 'close' and no 'end'. Without
      // this the shared seed would never settle.
      res.on('error', () => once(null));
      res.on('close', () => once(null));
    });
    req.on('error', (err) => {
      appLog('core:annex-client', 'warn', 'Agent buffer fetch failed', { meta: { satelliteId, agentId, error: err.message } });
      once(null);
    });
    req.on('timeout', () => { req.destroy(); once(null); });
  });
}

/**
 * Replace the local cache with the satellite's buffer plus the live chunks
 * that arrived during the fetch and are not in it.
 *
 * Replacing rather than appending matters: chunks cached before or during
 * the fetch are already in the satellite's buffer, so feeding the buffer on
 * top would hold them twice (#2324).
 */
async function seedFromSatellite(satelliteId: string, agentId: string): Promise<void> {
  const key = `${satelliteId}:${agentId}`;
  const sat = satellites.get(satelliteId);
  // Can't reach satellite: serve whatever local cache we have, and seed on
  // a later request once connected.
  if (!sat || sat.state !== 'connected') return;

  const state = remoteStream(key);
  const epoch = connectionEpochs.get(satelliteId) ?? 0;
  state.seeding = [];
  let fetched: SatelliteBuffer | null = null;
  try {
    fetched = await fetchSatelliteBuffer(sat, agentId);
  } catch (err) {
    // telemetry-exempt: logged; the cache keeps serving the live stream
    appLog('core:annex-client', 'warn', 'Agent buffer seed failed', {
      meta: { satelliteId, agentId, error: err instanceof Error ? err.message : String(err) },
    });
  }
  const during = state.seeding ?? [];
  state.seeding = null;
  // Disconnected during the fetch: output may be missing from both the
  // buffer and the cache, so seed again on a later request.
  if ((connectionEpochs.get(satelliteId) ?? 0) !== epoch) return;
  seededBuffers.add(key);
  const bufferKey = remoteBufferKey(satelliteId, agentId);
  if (fetched?.unavailable) {
    // Live output still arrives, so the terminal works, but it can't look like the whole story.
    headlessTerminal.reset(bufferKey, { windowsPty: satelliteWindowsPty(satelliteId) });
    headlessTerminal.feedData(bufferKey, `${TERMINAL_UNAVAILABLE_NOTICE}${during.map((chunk) => chunk.data).join('')}`, state.seq);
    return;
  }
  if (!fetched?.data) {
    // Nothing to seed. An empty cache marks the agent seeded, so the next
    // request does not fetch again.
    headlessTerminal.ensure(bufferKey, { windowsPty: satelliteWindowsPty(satelliteId) });
    return;
  }

  let replay = fetched.data;
  if (fetched.seq !== undefined) {
    let satelliteSeq = fetched.seq;
    for (const chunk of during) {
      replay += unseenPtySuffix(chunk.data, chunk.outputSeq, fetched.seq);
      if (chunk.outputSeq !== undefined) satelliteSeq = Math.max(satelliteSeq, chunk.outputSeq);
    }
    state.satelliteSeq = satelliteSeq;
  }
  // An older satellite's buffer has no seq. Chunks that arrived during the
  // fetch are then most likely in it already; they are dropped, since a
  // duplicated TUI frame stays on screen while a gap is redrawn over.
  headlessTerminal.reset(bufferKey, {
    ...(fetched.cols && fetched.rows && { cols: fetched.cols, rows: fetched.rows }),
    windowsPty: satelliteWindowsPty(satelliteId),
  });
  headlessTerminal.feedData(bufferKey, replay, state.seq);
}

/**
 * The cached buffer for a remote agent, seeded from the satellite on first
 * access. Concurrent callers share one seed fetch.
 */
async function getRemoteBufferSnapshot(satelliteId: string, agentId: string): Promise<RemoteBufferSnapshot> {
  const key = `${satelliteId}:${agentId}`;
  const bufferKey = remoteBufferKey(satelliteId, agentId);
  // A seeded key whose cache has gone is seeded again.
  if (!seededBuffers.has(key) || !headlessTerminal.getSize(bufferKey)) {
    let seed = seedsInFlight.get(key);
    if (!seed) {
      seed = seedFromSatellite(satelliteId, agentId).finally(() => seedsInFlight.delete(key));
      seedsInFlight.set(key, seed);
    }
    await seed;
  }
  const snap = await headlessTerminal.snapshot(bufferKey);
  return { data: snap?.data ?? '', seq: snap?.seq ?? remoteStream(key).seq };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function broadcastSatellitesChanged(): void {
  broadcastToAllWindows(IPC.ANNEX_CLIENT?.SATELLITES_CHANGED || 'annex-client:satellites-changed', getSatellites());
  devicesChanged();
}

function broadcastDiscoveredChanged(): void {
  broadcastToAllWindows(IPC.ANNEX_CLIENT.DISCOVERED_CHANGED, getDiscoveredServices());
}

function broadcastSatelliteEvent(satelliteId: string, type: string, payload: unknown): void {
  broadcastToAllWindows(
    IPC.ANNEX_CLIENT?.SATELLITE_EVENT || 'annex-client:satellite-event',
    { satelliteId, type, payload },
  );
}

function toPublicConnection(s: SatelliteConnectionInternal): SatelliteConnection {
  return {
    id: s.id,
    alias: s.alias,
    icon: s.icon,
    color: s.color,
    fingerprint: s.fingerprint,
    state: s.state,
    host: s.host,
    mainPort: s.mainPort,
    pairingPort: s.pairingPort,
    snapshot: s.snapshot,
    lastError: s.lastError,
    ...(s.snapshotUnavailable && { snapshotUnavailable: true }),
    ...(s.needsPairing && { needsPairing: true }),
    ...(s.problem && s.lastError && { problem: describeAnnexProblem(s.problem.code, s.alias, s.problem) }),
  };
}

/**
 * Moves a satellite to `state`. `error` is the raw reason, kept for logs and
 * telemetry; what the person sees is the problem it's classified as (or
 * `problem`, when the caller already knows), saying what happened and what to do.
 */
function setState(
  sat: SatelliteConnectionInternal,
  state: SatelliteState,
  error?: string,
  problem?: { code: AnnexProblemCode; status?: number },
): void {
  const prev = sat.state;
  sat.state = state;
  // Output sent while disconnected is in neither cache, and a restarted
  // satellite's seqs start over, so caches are seeded again on reconnect.
  if (prev === 'connected' && state !== 'connected') disposeRemoteBuffers(sat.id);
  if (state === 'disconnected') {
    // The reason text stays local; it only picks the registry enum.
    if (prev === 'connected') recordDisconnect(disconnectReasonFor(error));
    connectFailed(sat.fingerprint, connectErrorFor(error));
  }
  if (error !== undefined) {
    sat.problem = problem ?? { code: classifyConnectionError(error) };
    sat.lastError = annexProblemText(describeAnnexProblem(sat.problem.code, sat.alias, sat.problem));
  }
  appLog('core:annex-client', error ? 'warn' : 'info', `Satellite state: ${prev} → ${state}`, {
    meta: { fingerprint: sat.fingerprint, alias: sat.alias, ...(error ? { error } : {}) },
  });
  broadcastSatellitesChanged();
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Wrap bare IPv6 literals in brackets so they're valid in a URL authority.
 * mDNS/Bonjour discovery can hand back link-local IPv6 addresses (e.g.
 * `fe80::…`); interpolating one unbracketed makes `new URL()`, http(s).request,
 * and `new WebSocket()` throw `ERR_INVALID_URL`. IPv4 addresses and hostnames
 * pass through unchanged.
 */
export function bracketHost(host: string): string {
  return net.isIPv6(host) ? `[${host}]` : host;
}

function httpGet(host: string, port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${bracketHost(host)}:${port}${path}`, (res) => {
      // Collect raw bytes and decode once — per-chunk string coercion corrupts
      // multi-byte UTF-8 characters split across chunk boundaries.
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer | string) => { chunks.push(typeof c === 'string' ? Buffer.from(c) : c); });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * TLS options for every connection to a paired satellite: the WebSocket, the
 * buffer fetch and each REST call. The satellite must show the certificate
 * stored when it was paired, checked during the handshake, so nothing (not even
 * the request line) reaches anything else. A peer with no usable pin gets
 * options no handshake can satisfy.
 */
function pinnedTlsOptionsFor(fingerprint: string): tls.ConnectionOptions {
  const peer = annexPeers.getPeer(fingerprint);
  if (peer && !annexPeers.peerNeedsPairing(peer)) {
    try {
      return annexTls.createPinnedTlsClientOptions(annexIdentity.getOrCreateIdentity(), {
        certPem: peer.tlsCertificatePem!,
        fingerprint: peer.tlsCertificateFingerprint!,
      });
    } catch (err) { // telemetry-exempt: logged, and the peer then fails closed as needing pairing
      appLog('core:annex-client', 'warn', 'Stored satellite certificate is unusable', {
        meta: { fingerprint, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return {
    ca: [],
    rejectUnauthorized: true,
    checkServerIdentity: () => Object.assign(new Error(NEEDS_PAIRING_MESSAGE), { code: NEEDS_PAIRING_CODE }),
  };
}

const NEEDS_PAIRING_CODE = 'ERR_ANNEX_NEEDS_PAIRING';
const NEEDS_PAIRING_MESSAGE = 'This pairing is from an older version of Clubhouse. Pair again to connect.';
const PEER_NOT_PAIRED_MESSAGE = 'This computer is no longer paired there. Pair again to connect.';
const CERT_EXPIRED_MESSAGE = "The satellite's certificate has expired. Pair again to connect.";
const CERT_NOT_YET_VALID_MESSAGE = "The satellite's certificate isn't valid yet. Check the date and time on both computers, then retry.";
const certMismatchMessage = (alias: string) => `${alias} showed a different certificate. If it was reset, pair again.`;
/** TLS errors meaning the server showed a certificate other than the pinned one. */
const MISMATCH_CODES = ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'];

function satelliteUrl(sat: SatelliteConnectionInternal, urlPath: string, scheme: 'https' | 'wss' = 'https'): string {
  return `${scheme}://${bracketHost(sat.host)}:${sat.mainPort}${urlPath}`;
}

/**
 * Stops automatic reconnects. `pairing` and `mismatch` show the satellite as needing
 * pairing again; `clock` only waits for the person to retry.
 */
function haltSatellite(sat: SatelliteConnectionInternal, kind: 'pairing' | 'mismatch' | 'clock', message: string, problem: AnnexProblemCode): void {
  sat.halt = kind;
  sat.needsPairing = kind !== 'clock';
  stopHeartbeat(sat);
  if (sat.reconnectTimer) {
    clearTimeout(sat.reconnectTimer);
    sat.reconnectTimer = null;
  }
  if (sat.ws) {
    const ws = sat.ws;
    sat.ws = null;
    try { ws.terminate(); } catch { /* telemetry-exempt: closing a socket that may be gone */ }
  }
  appLog('core:annex-client', 'warn', `Stopped reconnecting to ${sat.alias}: ${message}`, { meta: { fingerprint: sat.fingerprint } });
  setState(sat, 'disconnected', message, { code: problem });
}

function markNeedsPairing(sat: SatelliteConnectionInternal, refusal: PairingRefusal): void {
  haltSatellite(sat, 'pairing', refusal.message, refusal.problem);
}

interface PairingRefusal { message: string; problem: AnnexProblemCode }

/** The refusal codes that mean pairing again is the only way back. */
function needsPairingRefusalFor(code: unknown): PairingRefusal | null {
  if (code === 'needs_pairing') return { message: NEEDS_PAIRING_MESSAGE, problem: 'old-pairing' };
  if (code === 'peer_not_paired') return { message: PEER_NOT_PAIRED_MESSAGE, problem: 'removed-there' };
  return null;
}

const OLD_PAIRING: PairingRefusal = { message: NEEDS_PAIRING_MESSAGE, problem: 'old-pairing' };

/** A TLS error that waiting won't fix: stop, and say what will. */
function haltForTlsError(sat: SatelliteConnectionInternal, err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === NEEDS_PAIRING_CODE) { haltSatellite(sat, 'pairing', NEEDS_PAIRING_MESSAGE, 'old-pairing'); return true; }
  if (code === 'CERT_HAS_EXPIRED') { haltSatellite(sat, 'pairing', CERT_EXPIRED_MESSAGE, 'cert-expired'); return true; }
  if (code === 'CERT_NOT_YET_VALID') { haltSatellite(sat, 'clock', CERT_NOT_YET_VALID_MESSAGE, 'cert-not-yet-valid'); return true; }
  if (code && (code === annexTls.PIN_MISMATCH_CODE || MISMATCH_CODES.includes(code))) { haltSatellite(sat, 'mismatch', certMismatchMessage(sat.alias), 'cert-mismatch'); return true; }
  return false;
}

/** A REST answer of 401 needs_pairing or peer_not_paired means what it does on the WebSocket. */
function noteRestRefusal(sat: SatelliteConnectionInternal, status: number | undefined, text: string): void {
  if (status !== 401) return;
  let code: unknown;
  try { code = (JSON.parse(text) as { error?: unknown }).error; } catch { /* telemetry-exempt: not JSON, so not a pairing refusal */ }
  const refusal = needsPairingRefusalFor(code);
  if (refusal) markNeedsPairing(sat, refusal);
}

/** Drains a non-200 REST answer, noting a pairing refusal. */
function drainRefusal(sat: SatelliteConnectionInternal, res: http.IncomingMessage): void {
  if (res.statusCode !== 401) { res.resume(); return; }
  void readSmallBody(res).then((text) => noteRestRefusal(sat, res.statusCode, text));
}

function readSmallBody(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 16 * 1024) chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', () => resolve(''));
    res.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

interface RemoteIdentity {
  fingerprint: string;
  alias: string;
  icon: string;
  color: string;
  publicKey: string;
}

/**
 * The best address a Bonjour announcement gave (#3058): a routable IPv4 address
 * first, then IPv6 (unique-local, then global), never loopback or link-local.
 * Falls back to the sender's address, then the announced name.
 */
function serviceHost(service: RemoteService): string {
  return rankAddresses(service.addresses ?? [])[0] || service.referer?.address || service.host || '';
}

async function identifyService(service: RemoteService): Promise<RemoteIdentity | null> {
  const discoverStartMs = Date.now();
  const txt = service.txt || {};
  // Prefer resolved IP addresses over hostname — on Linux os.hostname() returns a
  // bare name (e.g. "desk") that macOS cannot resolve, while .local hostnames from
  // macOS work fine.  The addresses array and referer.address are always IPs.
  const host = serviceHost(service);
  if (!host) return null;

  // V2 services have a pairingPort in TXT
  const pPort = txt.pairingPort ? parseInt(txt.pairingPort, 10) : service.port;
  if (!pPort) return null;

  try {
    const res = await httpGet(host, pPort, '/api/v1/identity');
    if (res.status !== 200) {
      appLog('core:annex-client', 'warn', 'Identity request failed', { meta: { host, port: pPort, status: res.status } });
      recordDiscover(discoverStartMs, host, 'identity_unreachable');
      return null;
    }
    const identity = JSON.parse(res.body);
    if (!identity.fingerprint) {
      appLog('core:annex-client', 'warn', 'Identity response missing fingerprint', { meta: { host, port: pPort } });
      recordDiscover(discoverStartMs, host, 'identity_invalid');
      return null;
    }
    recordDiscover(discoverStartMs, host);
    return {
      fingerprint: identity.fingerprint,
      alias: identity.alias || 'Unknown',
      icon: identity.icon || 'computer',
      color: identity.color || 'indigo',
      publicKey: identity.publicKey || '',
    };
  } catch (err) {
    appLog('core:annex-client', 'warn', 'Identity request error', {
      meta: { host, port: pPort, error: err instanceof Error ? err.message : String(err) },
    });
    recordDiscover(discoverStartMs, host, err instanceof SyntaxError ? 'identity_invalid' : 'identity_unreachable');
    return null;
  }
}

async function connectToSatellite(sat: SatelliteConnectionInternal): Promise<void> {
  sat.snapshotUnavailable = false;
  const peer = annexPeers.getPeer(sat.fingerprint);
  if (!peer || annexPeers.peerNeedsPairing(peer)) {
    markNeedsPairing(sat, OLD_PAIRING);
    return;
  }
  sat.needsPairing = false;
  sat.halt = null;
  setState(sat, 'connecting');
  connectStarted(sat.fingerprint, sat.host);

  const attemptConnection = (): void => {
    const tlsOptions = pinnedTlsOptionsFor(sat.fingerprint);
    const wsUrl = satelliteUrl(sat, '/ws?client=desktop', 'wss');

    appLog('core:annex-client', 'info', 'Connecting to satellite', {
      meta: { fingerprint: sat.fingerprint, host: sat.host, port: sat.mainPort },
    });

    // The pinned certificate is checked during the TLS handshake, before the upgrade request is written.
    const ws = new WebSocket(wsUrl, { ...tlsOptions, handshakeTimeout: 10_000 });

    sat.ws = ws;

    // The satellite answered the upgrade with an error. 401 needs_pairing / peer_not_paired is final.
    ws.on('unexpected-response', (req, res) => {
      if (sat.ws !== ws) return;
      sat.ws = null;
      void readSmallBody(res).then((text) => {
        try { req.destroy(); } catch { /* telemetry-exempt: closing a refused upgrade */ }
        try { ws.terminate(); } catch { /* telemetry-exempt: closing a refused upgrade */ }
        let code: unknown;
        try { code = (JSON.parse(text) as { error?: unknown }).error; } catch { /* telemetry-exempt: a refusal without a JSON body is handled as a plain one */ }
        const refusal = needsPairingRefusalFor(code);
        if (refusal) { markNeedsPairing(sat, refusal); return; }
        const status = res.statusCode ?? 0;
        setState(sat, 'disconnected', `Unexpected server response: ${status}`, { code: classifyRefusal(status, code), status });
        if (!sat.reconnectTimer) scheduleReconnect(sat);
      });
    });

    ws.on('open', () => {
      if (sat.ws !== ws) return;
      appLog('core:annex-client', 'info', 'Connected to satellite', {
        meta: { fingerprint: sat.fingerprint, host: sat.host, port: sat.mainPort },
      });
      connectAuthMode(sat.fingerprint, 'mtls');
      setState(sat, 'connected');
      sat.reconnectAttempt = 0;
      sat.candidateIndex = 0;
      // Remembered, so it's found again after a restart without waiting for discovery (#3058).
      annexPeers.noteReached(sat.fingerprint, sat.host, sat.mainPort);
      startHeartbeat(sat);
    });

    ws.on('pong', () => {
      const sentAt = pingSentAt.get(sat);
      if (sentAt !== undefined) {
        pingSentAt.delete(sat);
        recordHeartbeatRtt(Date.now() - sentAt);
      }
      // Clear the pong timeout — connection is alive
      if (sat.pongTimeout) {
        clearTimeout(sat.pongTimeout);
        sat.pongTimeout = null;
      }
    });

    // A socket that's been replaced can still report while it closes, and none of that is about the new one.
    ws.on('message', (data) => {
      if (sat.ws !== ws) return;
      try {
        const msg = JSON.parse(data.toString());
        handleSatelliteMessage(sat, msg);
      } catch {
        appLog('core:annex-client', 'warn', 'Malformed JSON from satellite', {
          meta: { fingerprint: sat.fingerprint, preview: data.toString().slice(0, 200) },
        });
      }
    });

    ws.on('close', (_code, reason) => {
      if (sat.ws !== ws) return;
      sat.ws = null;
      // The satellite removed this pairing; reconnecting would only be refused.
      const refusal = needsPairingRefusalFor(reason?.toString());
      if (refusal) { markNeedsPairing(sat, refusal); return; }
      if (sat.state === 'connected') {
        setState(sat, 'disconnected', 'Connection closed');
        if (!sat.reconnectTimer) scheduleReconnect(sat);
      }
    });

    ws.on('error', (err) => {
      if (sat.ws !== ws) return;
      if (haltForTlsError(sat, err)) { sat.ws = null; return; }
      const errorText = (err && typeof err === 'object' && 'message' in err) ? String((err as Error).message) : String(err);

      // Downgrade to 'warn' after 3 consecutive reconnect attempts to reduce log noise
      const level = sat.reconnectAttempt >= 3 ? 'warn' : 'error';
      appLog('core:annex-client', level, 'WebSocket error', {
        meta: { fingerprint: sat.fingerprint, error: errorText, attempt: sat.reconnectAttempt },
      });
      sat.ws = null;
      setState(sat, 'disconnected', errorText, { code: classifyConnectionError(err) });
      if (!sat.reconnectTimer) scheduleReconnect(sat);
    });
  };

  try {
    attemptConnection();
  } catch (err) {
    setState(sat, 'disconnected', err instanceof Error ? err.message : 'Connection failed');
    scheduleReconnect(sat);
  }
}

/** Connections that have had a snapshot. */
const socketsWithSnapshot = new WeakSet<WebSocket>();

function handleSatelliteMessage(sat: SatelliteConnectionInternal, msg: Record<string, unknown>): void {
  const type = msg.type as string;

  switch (type) {
    case 'snapshot': {
      const incoming = msg.payload as SatelliteSnapshot;
      if (incoming.protocolVersion !== ANNEX_PROTOCOL_VERSION) {
        setState(sat, 'disconnected', 'Incompatible Annex version', { code: 'incompatible' });
        return;
      }
      connectSucceeded(sat.fingerprint);
      // A socket's first snapshot always stands. Seq only orders frames on one connection,
      // and restarts from zero when the satellite does, so a stale check would refuse it for good.
      if (!sat.snapshot || !socketsWithSnapshot.has(sat.ws!) || incoming.lastSeq >= sat.snapshot.lastSeq) {
        if (sat.ws) socketsWithSnapshot.add(sat.ws);
        sat.lastError = null;
        sat.problem = null;
        sat.snapshotUnavailable = false;
        // Left out for size, so what's known still stands, and a new connection fetches it.
        const omitted = incoming.snapshotTruncated?.omitted?.includes('canvasState');
        if (omitted) {
          incoming.canvasState ??= sat.snapshot?.canvasState;
          incoming.appCanvasState ??= sat.snapshot?.appCanvasState;
        } else if (sat.ws) {
          // It has every canvas, from after any fetch still running began.
          canvasRefetches.get(sat.ws)?.forEach((refetch) => { refetch.superseded = true; });
        }
        sat.snapshot = incoming;
        broadcastSatellitesChanged();
        broadcastSatelliteEvent(sat.id, 'snapshot', incoming);
        if (omitted) void fetchOmittedCanvases(sat);
      }
      break;
    }

    case 'error': {
      if ((msg.payload as { message?: unknown } | undefined)?.message === 'snapshot_failed') {
        sat.snapshotUnavailable = true;
        connectFailed(sat.fingerprint, 'unknown');
        broadcastSatellitesChanged();
      }
      broadcastSatelliteEvent(sat.id, type, msg.payload);
      break;
    }

    case 'pty:data': {
      // Cache remotely-received PTY data locally for instant buffer replay
      const ptyPayload = msg.payload as { agentId?: string; data?: string; outputSeq?: unknown };
      if (ptyPayload?.agentId && ptyPayload?.data) {
        const outputSeq = typeof ptyPayload.outputSeq === 'number' ? ptyPayload.outputSeq : undefined;
        const fresh = cacheRemotePtyData(sat.id, ptyPayload.agentId, ptyPayload.data, outputSeq);
        if (fresh.data) broadcastSatelliteEvent(sat.id, type, { ...ptyPayload, data: fresh.data, seq: fresh.seq });
      } else {
        broadcastSatelliteEvent(sat.id, type, msg.payload);
      }
      break;
    }

    case 'pty:exit':
    case 'hook:event':
    case 'agent:status':
    case 'structured:event': // satellites on versions before structured mode was removed
    case 'agent:spawned':
    case 'agent:woken':
    case 'agent:completed':
    case 'permission:request':
    case 'permission:response':
    case 'theme:changed':
      broadcastSatelliteEvent(sat.id, type, msg.payload);
      break;

    case 'canvas:state':
      // Kept too: a snapshot that leaves canvases out is refilled from here, and would otherwise put old ones back.
      if (sat.ws) {
        canvasEventsDuringFetch.get(sat.ws)?.push(msg.payload as CanvasStateEvent);
        canvasRefetches.get(sat.ws)?.get(canvasKey(msg.payload as CanvasStateEvent))?.changes.push(msg.payload as CanvasStateEvent);
      }
      if ((msg.payload as CanvasStateEvent).stateOmitted) {
        void refetchOmittedCanvas(sat, msg.payload as CanvasStateEvent);
        break;
      }
      if (sat.snapshot) sat.snapshot = withCanvasEvent(sat.snapshot, msg.payload as CanvasStateEvent);
      broadcastSatelliteEvent(sat.id, type, msg.payload);
      break;

    default:
      // Forward any unknown message types
      broadcastSatelliteEvent(sat.id, type, msg.payload);
      break;
  }
}

/** Connections that have fetched their canvases. Later changes come as `canvas:state`. */
const socketsWithCanvases = new WeakSet<WebSocket>();
/** Changes that arrive while a connection's fetch is running: they go on top of what it returns. */
const canvasEventsDuringFetch = new WeakMap<WebSocket, CanvasStateEvent[]>();
/** The projects a connection has asked for canvases, once it's done its first fetch. */
const canvasProjectsAsked = new WeakMap<WebSocket, Set<string>>();

interface CanvasStateEvent {
  projectId?: string | null;
  scope?: string;
  /** The change was too large for a frame, so this only says what changed. */
  stateOmitted?: { version: number; bytes: number };
  state?: { canvasId: string; name: string; views: unknown[]; viewport: unknown; nextZIndex: number; zoomedViewId: string | null; selectedViewId?: string | null; allCanvasTabs?: Array<{ id: string; name: string }>; activeCanvasId?: string; wireDefinitions?: unknown[]; zoneWireDefinitions?: unknown[] };
}
interface CanvasStateRecord { canvases: Array<{ id: string }>; activeCanvasId: string; wireDefinitions?: unknown[]; zoneWireDefinitions?: unknown[] }

/**
 * One canvas's change on top of everything known, as the renderer merges it, without
 * its id namespacing. With nothing known it's left out: it holds one canvas of perhaps
 * several, so it can't stand for the whole set, and absent keeps what a renderer has.
 */
function mergeCanvasEvent(known: CanvasStateRecord | null | undefined, cs: NonNullable<CanvasStateEvent['state']>): CanvasStateRecord | null | undefined {
  if (!known) return known;
  const canvas = { id: cs.canvasId, name: cs.name, views: cs.views, viewport: cs.viewport, nextZIndex: cs.nextZIndex, zoomedViewId: cs.zoomedViewId, selectedViewId: cs.selectedViewId ?? null };
  const canvases = cs.allCanvasTabs
    ? cs.allCanvasTabs.map((tab) => (tab.id === cs.canvasId ? canvas : known.canvases.find((c) => c.id === tab.id) ?? { id: tab.id, name: tab.name, views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null, selectedViewId: null }))
    : known.canvases.some((c) => c.id === cs.canvasId) ? known.canvases.map((c) => (c.id === cs.canvasId ? canvas : c)) : [...known.canvases, canvas];
  return {
    ...known,
    canvases,
    activeCanvasId: cs.activeCanvasId ?? known.activeCanvasId,
    ...(cs.wireDefinitions && { wireDefinitions: cs.wireDefinitions }),
    ...(cs.zoneWireDefinitions && { zoneWireDefinitions: cs.zoneWireDefinitions }),
  };
}

function withCanvasEvent(snapshot: SatelliteSnapshot, { projectId, scope, state }: CanvasStateEvent): SatelliteSnapshot {
  if (!state) return snapshot;
  if (scope === 'global') return { ...snapshot, appCanvasState: mergeCanvasEvent(snapshot.appCanvasState as CanvasStateRecord | null | undefined, state) };
  if (!projectId) return snapshot;
  const merged = mergeCanvasEvent(snapshot.canvasState?.[projectId] as CanvasStateRecord | undefined, state);
  return merged ? { ...snapshot, canvasState: { ...snapshot.canvasState, [projectId]: merged } } : snapshot;
}

/** One canvas change too large to send: a fetch running, and what's come since. */
interface CanvasRefetch { changes: CanvasStateEvent[]; again: boolean; superseded: boolean }
const canvasRefetches = new WeakMap<WebSocket, Map<string, CanvasRefetch>>();
const canvasKey = ({ projectId, scope }: CanvasStateEvent): string => (scope === 'global' ? '' : projectId ?? '');

/**
 * Fetch one project's canvases, or the app's, after a marker said they changed. One at
 * a time for each: a marker during a fetch means one more after it. Changes meanwhile go
 * on top, and a failure keeps what's known until the next marker.
 */
async function refetchOmittedCanvas(sat: SatelliteConnectionInternal, marker: CanvasStateEvent): Promise<void> {
  const ws = sat.ws;
  const key = canvasKey(marker);
  if (!ws || (!key && marker.scope !== 'global')) return;
  const running = canvasRefetches.get(ws) ?? new Map<string, CanvasRefetch>();
  canvasRefetches.set(ws, running);
  const current = running.get(key);
  if (current) {
    current.again = true;
    return;
  }
  const refetch: CanvasRefetch = { changes: [], again: false, superseded: false };
  running.set(key, refetch);
  let state: unknown;
  try {
    ({ state } = await satelliteHttpsRequest(sat.fingerprint, 'GET', key ? `/api/v1/mobile/canvas/${encodeURIComponent(key)}` : '/api/v1/mobile/canvas') as { state: unknown });
  } catch (err) {
    running.delete(key);
    appLog('core:annex', 'warn', 'Could not fetch a canvas too large for a frame', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return;
  }
  running.delete(key);
  if (sat.ws === ws && sat.snapshot && !refetch.superseded && state) {
    const fetched: SatelliteSnapshot = key
      ? { ...sat.snapshot, canvasState: { ...sat.snapshot.canvasState, [key]: state } }
      : { ...sat.snapshot, appCanvasState: state };
    sat.snapshot = refetch.changes.reduce(withCanvasEvent, fetched);
    broadcastSatellitesChanged();
    broadcastSatelliteEvent(sat.id, 'snapshot', sat.snapshot);
  }
  if (refetch.again) void refetchOmittedCanvas(sat, marker);
}

/**
 * Fetch the canvases a satellite's snapshot left out for size, once per connection,
 * one project at a time, then send them on as a snapshot the renderer already reads.
 */
async function fetchOmittedCanvases(sat: SatelliteConnectionInternal): Promise<void> {
  const ws = sat.ws;
  if (!ws) return;
  if (socketsWithCanvases.has(ws)) {
    void fetchNewProjectCanvases(sat, ws);
    return;
  }
  socketsWithCanvases.add(ws);
  const changes: CanvasStateEvent[] = [];
  canvasEventsDuringFetch.set(ws, changes);
  const canvasState: Record<string, unknown> = {};
  let appCanvasState: unknown = null;
  const projects = (sat.snapshot?.projects ?? []) as Array<{ id: string }>;
  try {
    for (const project of projects) {
      const { state } = await satelliteHttpsRequest(sat.fingerprint, 'GET', `/api/v1/mobile/canvas/${encodeURIComponent(project.id)}`) as { state: unknown };
      if (state) canvasState[project.id] = state;
    }
    ({ state: appCanvasState } = await satelliteHttpsRequest(sat.fingerprint, 'GET', '/api/v1/mobile/canvas') as { state: unknown });
  } catch (err) {
    // Try again on the next snapshot that leaves them out. Until then it keeps what it has.
    socketsWithCanvases.delete(ws);
    canvasEventsDuringFetch.delete(ws);
    appLog('core:annex', 'warn', 'Could not fetch canvases a satellite left out of its snapshot', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return;
  }
  canvasEventsDuringFetch.delete(ws);
  canvasProjectsAsked.set(ws, new Set(projects.map((project) => project.id)));
  // Only onto a snapshot still missing them: a full one that arrived meanwhile is newer.
  if (sat.ws !== ws || !sat.snapshot?.snapshotTruncated?.omitted?.includes('canvasState')) return;
  sat.snapshot = changes.reduce(withCanvasEvent, { ...sat.snapshot, canvasState, ...(appCanvasState ? { appCanvasState } : {}) } as SatelliteSnapshot);
  broadcastSatellitesChanged();
  broadcastSatelliteEvent(sat.id, 'snapshot', sat.snapshot);
  // A marker while this ran: what came back may be from before that change.
  for (const change of changes) {
    if (change.stateOmitted) void refetchOmittedCanvas(sat, change);
  }
  void fetchNewProjectCanvases(sat, ws);
}

/**
 * Canvases for projects that appeared since a connection's first fetch and aren't known.
 * Each is asked for once, one at a time, however many snapshots name it. One that fails
 * waits for the next snapshot that leaves canvases out, as a first fetch does.
 */
async function fetchNewProjectCanvases(sat: SatelliteConnectionInternal, ws: WebSocket): Promise<void> {
  const asked = canvasProjectsAsked.get(ws);
  if (!asked || canvasEventsDuringFetch.has(ws)) return;
  const changes: CanvasStateEvent[] = [];
  canvasEventsDuringFetch.set(ws, changes);
  try {
    while (sat.ws === ws && sat.snapshot?.snapshotTruncated?.omitted?.includes('canvasState')) {
      const projects = sat.snapshot.projects as Array<{ id: string }>;
      const projectId = projects.find((project) => !asked.has(project.id))?.id;
      if (!projectId) return;
      asked.add(projectId);
      if (sat.snapshot.canvasState?.[projectId]) continue;
      changes.length = 0;
      let state: unknown;
      try {
        ({ state } = await satelliteHttpsRequest(sat.fingerprint, 'GET', `/api/v1/mobile/canvas/${encodeURIComponent(projectId)}`) as { state: unknown });
      } catch (err) {
        asked.delete(projectId);
        appLog('core:annex', 'warn', 'Could not fetch canvases for a new project on a satellite', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
        return;
      }
      // Only onto a snapshot still missing them, as the first fetch does.
      if (!state || sat.ws !== ws || !sat.snapshot?.snapshotTruncated?.omitted?.includes('canvasState')) continue;
      const ownChanges = changes.filter((change) => change.projectId === projectId);
      sat.snapshot = ownChanges.reduce(withCanvasEvent, { ...sat.snapshot, canvasState: { ...sat.snapshot.canvasState, [projectId]: state } } as SatelliteSnapshot);
      broadcastSatellitesChanged();
      broadcastSatelliteEvent(sat.id, 'snapshot', sat.snapshot);
      for (const change of ownChanges) {
        if (change.stateOmitted) void refetchOmittedCanvas(sat, change);
      }
    }
  } finally {
    canvasEventsDuringFetch.delete(ws);
  }
}

function startHeartbeat(sat: SatelliteConnectionInternal): void {
  stopHeartbeat(sat);
  sat.heartbeatInterval = setInterval(() => {
    if (!sat.ws || sat.ws.readyState !== WebSocket.OPEN) {
      stopHeartbeat(sat);
      return;
    }
    // Send ping
    try {
      pingSentAt.set(sat, Date.now());
      sat.ws.ping();
    } catch {
      stopHeartbeat(sat);
      setState(sat, 'disconnected', 'Heartbeat ping failed', { code: 'stopped-answering' });
      scheduleReconnect(sat);
      return;
    }
    // Set pong timeout
    sat.pongTimeout = setTimeout(() => {
      appLog('core:annex-client', 'warn', 'Heartbeat pong timeout — closing connection', {
        meta: { fingerprint: sat.fingerprint },
        telemetry: { event: 'clubhouse.annex.heartbeat_timeout' },
      });
      if (sat.ws) {
        try { sat.ws.terminate(); } catch (err) {
          appLog('core:annex-client', 'debug', 'Failed to terminate WebSocket on heartbeat timeout', {
            meta: { fingerprint: sat.fingerprint, error: err instanceof Error ? err.message : String(err) },
          });
        }
        sat.ws = null;
      }
      setState(sat, 'disconnected', 'Heartbeat timeout', { code: 'stopped-answering' });
      stopHeartbeat(sat);
      scheduleReconnect(sat);
    }, PONG_TIMEOUT_MS);
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(sat: SatelliteConnectionInternal): void {
  if (sat.heartbeatInterval) {
    clearInterval(sat.heartbeatInterval);
    sat.heartbeatInterval = null;
  }
  if (sat.pongTimeout) {
    clearTimeout(sat.pongTimeout);
    sat.pongTimeout = null;
  }
}

function scheduleReconnect(sat: SatelliteConnectionInternal): void {
  if (sat.reconnectTimer) {
    clearTimeout(sat.reconnectTimer);
    sat.reconnectTimer = null;
  }
  // Refused, or a certificate or clock problem: retrying the same way can't help.
  if (sat.halt || sat.needsPairing) return;

  // Check if auto-reconnect is enabled
  const settings = annexSettings.getSettings();
  if (!settings.autoReconnect) {
    appLog('core:annex-client', 'info', 'Auto-reconnect disabled, not scheduling', { meta: { fingerprint: sat.fingerprint } });
    return;
  }

  // Each of its addresses gets a quick try in turn; once all have failed, back off (#3058).
  const candidates = candidatesFor(sat);
  const nextIndex = candidates.length > 0 ? ((sat.candidateIndex ?? 0) + 1) % candidates.length : 0;
  sat.candidateIndex = nextIndex;
  let delay: number;
  if (nextIndex !== 0) {
    delay = NEXT_ADDRESS_DELAY_MS;
  } else {
    // Exponential backoff with jitter: 1s, 2s, 4s, 8s, 30s cap
    // Jitter (0.5–1.5x) prevents thundering herd when multiple satellites reconnect
    const baseDelay = Math.min(1000 * Math.pow(2, sat.reconnectAttempt), 30_000);
    delay = Math.round(baseDelay * (0.5 + Math.random()));
    sat.reconnectAttempt++;
  }
  recordReconnectScheduled(sat.reconnectAttempt, delay);
  appLog('core:annex-client', 'info', `Scheduling reconnect in ${delay}ms (attempt ${sat.reconnectAttempt})`, {
    meta: { fingerprint: sat.fingerprint, alias: sat.alias },
  });

  sat.reconnectTimer = setTimeout(() => {
    sat.reconnectTimer = null;
    if (sat.state === 'disconnected') {
      useCandidate(sat, candidatesFor(sat));
      connectToSatellite(sat);
    }
  }, delay);
}

/** Delay before trying a satellite's next address, after one fails. */
const NEXT_ADDRESS_DELAY_MS = 250;

/** Every address to try for a satellite, in order (#3058). */
function candidatesFor(sat: SatelliteConnectionInternal): ReachAddress[] {
  const peer = annexPeers.getPeer(sat.fingerprint);
  const port = peer?.mainPort || sat.mainPort;
  const list = reachCandidates({ discovered: sat.discovered, typed: peer?.typedHost, known: peer?.knownHosts, port });
  // Where it is now (from pairing), if nothing else lists it.
  if (sat.host && sat.mainPort && !list.some((a) => a.host === sat.host.toLowerCase() && a.port === sat.mainPort)) {
    list.push({ host: sat.host, port: sat.mainPort });
  }
  return list;
}

/** Points the satellite at its candidate address for this attempt. */
function useCandidate(sat: SatelliteConnectionInternal, candidates: ReachAddress[]): void {
  if (candidates.length === 0) return;
  const index = (sat.candidateIndex ?? 0) % candidates.length;
  sat.candidateIndex = index;
  sat.host = candidates[index].host;
  sat.mainPort = candidates[index].port;
}

/** A satellite connection record for a paired peer, not yet connected. */
function newSatellite(peer: { fingerprint: string; alias: string; icon: string; color: string }, state: SatelliteState): SatelliteConnectionInternal {
  return {
    id: peer.fingerprint,
    alias: peer.alias,
    icon: peer.icon,
    color: peer.color,
    fingerprint: peer.fingerprint,
    state,
    host: '',
    mainPort: 0,
    pairingPort: 0,
    snapshot: null,
    lastError: null,
    ws: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    needsPairing: false,
    heartbeatInterval: null,
    pongTimeout: null,
    discovered: null,
    candidateIndex: 0,
  };
}

/**
 * Connects to every paired satellite with a remembered or typed address, without
 * waiting for discovery (#3058). Discovery still finds the rest, and newer addresses.
 */
function restorePairedSatellites(): void {
  for (const peer of annexPeers.listPeers()) {
    if (peer.role !== 'satellite' || annexPeers.peerNeedsPairing(peer) || satellites.has(peer.fingerprint)) continue;
    const sat = newSatellite(peer, 'disconnected');
    const candidates = candidatesFor(sat);
    if (candidates.length === 0) continue;
    useCandidate(sat, candidates);
    satellites.set(peer.fingerprint, sat);
    connectToSatellite(sat);
  }
  broadcastSatellitesChanged();
}

function disconnectSatellite(sat: SatelliteConnectionInternal): void {
  appLog('core:annex-client', 'info', 'Disconnecting satellite', {
    meta: { fingerprint: sat.fingerprint, alias: sat.alias, previousState: sat.state },
  });
  stopHeartbeat(sat);
  if (sat.reconnectTimer) {
    clearTimeout(sat.reconnectTimer);
    sat.reconnectTimer = null;
  }
  if (sat.ws) {
    try { sat.ws.close(); } catch (err) {
      appLog('core:annex-client', 'debug', 'Failed to close WebSocket during disconnect', {
        meta: { fingerprint: sat.fingerprint, error: err instanceof Error ? err.message : String(err) },
      });
    }
    sat.ws = null;
  }
  setState(sat, 'disconnected');
}

// ---------------------------------------------------------------------------
// Bonjour discovery
// ---------------------------------------------------------------------------

/** Replaces a discovery socket that couldn't start, after a pause. */
let rediscoverTimer: ReturnType<typeof setTimeout> | null = null;
const MDNS_RESTART_DELAY_MS = 30_000;

function startDiscovery(): void {
  if (bonjourBrowser) return;

  try {
    // Socket errors are logged, never thrown (#1921).
    bonjourInstance = createBonjour('discover', ({ fatal }) => {
      if (!fatal || rediscoverTimer) return;
      rediscoverTimer = setTimeout(() => {
        rediscoverTimer = null;
        if (!bonjourBrowser) return; // stopped meanwhile
        stopDiscovery();
        startDiscovery();
      }, MDNS_RESTART_DELAY_MS);
      rediscoverTimer.unref?.();
    });
    bonjourBrowser = bonjourInstance.find({ type: 'clubhouse-annex' }, async (service) => {
      const identity = await identifyService(service);
      if (!identity) return;

      const { fingerprint } = identity;
      const txt = service.txt || {};
      const host = serviceHost(service);
      const mainPort = service.port || 0;
      const pairingPort = txt.pairingPort ? parseInt(txt.pairingPort, 10) : service.port || 0;

      // Skip our own identity
      const localIdentity = annexIdentity.getIdentity();
      if (localIdentity && localIdentity.fingerprint === fingerprint) return;

      // Paired peer — only connect to peers we've paired as satellites (not controllers)
      const peerRecord = annexPeers.getPeer(fingerprint);
      if (peerRecord && (peerRecord.role === 'satellite' || !peerRecord.role)) {
        // Remove from discovered if it was there
        if (discoveredServices.has(fingerprint)) {
          discoveredServices.delete(fingerprint);
          broadcastDiscoveredChanged();
        }

        // Skip if we already have this satellite
        if (satellites.has(fingerprint)) {
          const sat = satellites.get(fingerprint)!;
          // An announced address is only a hint. It never moves a live connection; a
          // disconnected satellite tries it, and the pinned certificate decides.
          const live = sat.state === 'connected' || sat.state === 'connecting';
          const hostChanged = host !== sat.host || mainPort !== sat.mainPort;
          if (host && mainPort) sat.discovered = { host, port: mainPort };
          if (hostChanged && !live) {
            sat.host = host;
            sat.mainPort = mainPort;
            sat.pairingPort = pairingPort;
            sat.candidateIndex = 0; // the announced address is the first candidate
          }
          // After a certificate mismatch, a newly announced address gets one more try, through the same pin.
          const halted = sat.halt || sat.needsPairing;
          // A satellite waiting to be found (Retry before discovery saw it) connects now too.
          const waiting = sat.state === 'disconnected' || sat.state === 'discovering';
          if (waiting && (!halted || (sat.halt === 'mismatch' && hostChanged)) && sat.host && sat.mainPort) {
            connectToSatellite(sat);
          }
          return;
        }

        const peer = annexPeers.getPeer(fingerprint);
        if (!peer) return;

        const sat = newSatellite(peer, 'discovering');
        sat.host = host;
        sat.mainPort = mainPort;
        sat.pairingPort = pairingPort;
        if (host && mainPort) sat.discovered = { host, port: mainPort };

        satellites.set(fingerprint, sat);
        broadcastSatellitesChanged();

        appLog('core:annex-client', 'info', 'Discovered paired satellite', {
          meta: { fingerprint, alias: peer.alias, host, port: mainPort },
        });

        // Auto-connect over pinned mTLS
        if (host && mainPort) {
          connectToSatellite(sat);
        }
        return;
      }

      // Unpaired peer — track as discovered service
      if (!discoveredServices.has(fingerprint)) {
        discoveredServices.set(fingerprint, {
          fingerprint,
          alias: identity.alias,
          icon: identity.icon,
          color: identity.color,
          host,
          mainPort,
          pairingPort,
          publicKey: identity.publicKey,
        });
        broadcastDiscoveredChanged();

        appLog('core:annex-client', 'info', 'Discovered unpaired service', {
          meta: { fingerprint, alias: identity.alias, host, port: mainPort },
        });
      } else {
        // Update host/port if changed
        const existing = discoveredServices.get(fingerprint)!;
        if (host !== existing.host || mainPort !== existing.mainPort) {
          existing.host = host;
          existing.mainPort = mainPort;
          existing.pairingPort = pairingPort;
          broadcastDiscoveredChanged();
        }
      }
    });

    appLog('core:annex-client', 'info', 'Bonjour discovery started');
  } catch (err) {
    appLog('core:annex-client', 'error', 'Failed to start Bonjour discovery', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

function stopDiscovery(): void {
  if (rediscoverTimer) { clearTimeout(rediscoverTimer); rediscoverTimer = null; }
  if (bonjourBrowser) {
    try { bonjourBrowser.stop(); } catch (err) {
      appLog('core:annex-client', 'debug', 'Failed to stop Bonjour browser', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    bonjourBrowser = null;
  }
  if (bonjourInstance) {
    try { bonjourInstance.destroy(); } catch (err) {
      appLog('core:annex-client', 'debug', 'Failed to destroy Bonjour instance', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    bonjourInstance = null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getSatellites(): SatelliteConnection[] {
  return Array.from(satellites.values()).map(toPublicConnection);
}

export function getSatellite(fingerprint: string): SatelliteConnection | null {
  const sat = satellites.get(fingerprint);
  return sat ? toPublicConnection(sat) : null;
}

/**
 * Initiate connection to a satellite by fingerprint.
 * The satellite must already be a known peer and must have been paired.
 */
export function connect(fingerprint: string): void {
  let sat = satellites.get(fingerprint);
  if (!sat) {
    const peer = annexPeers.getPeer(fingerprint);
    if (!peer) {
      appLog('core:annex-client', 'warn', 'Cannot connect — unknown peer', { meta: { fingerprint } });
      return;
    }
    sat = newSatellite(peer, 'disconnected');
    satellites.set(fingerprint, sat);
  }

  if (sat.state !== 'disconnected') {
    appLog('core:annex-client', 'info', 'Satellite already connecting/connected', { meta: { fingerprint } });
    return;
  }

  // A remembered or typed address, if it has one (#3058).
  if (!sat.host || !sat.mainPort) useCandidate(sat, candidatesFor(sat));
  if (sat.host && sat.mainPort) {
    connectToSatellite(sat);
  } else {
    // Will connect when discovered via Bonjour
    setState(sat, 'discovering');
  }
}

export type SetHostResult = { ok: true } | { ok: false; error: string };

/**
 * Sets the host name or address a person typed for a satellite (#3058), such as
 * its tailnet name, with an optional port. An empty value clears it. A
 * disconnected satellite tries it straight away; a live connection is left alone.
 */
export function setSatelliteHost(fingerprint: string, input: string): SetHostResult {
  const peer = annexPeers.getPeer(fingerprint);
  if (!peer || peer.role === 'controller') return { ok: false, error: "That computer isn't one this computer connects to." };
  const value = input.trim();
  if (value && !parseTypedHost(value)) {
    return { ok: false, error: 'Type a name or address, such as studio.local, a tailnet name or 192.168.1.20, with an optional :port.' };
  }
  annexPeers.setTypedHost(fingerprint, value || undefined);
  appLog('core:annex-client', 'info', value ? 'Typed host set for satellite' : 'Typed host cleared for satellite', { meta: { fingerprint } });
  const sat = satellites.get(fingerprint);
  if (!sat) { connect(fingerprint); broadcastSatellitesChanged(); return { ok: true }; }
  if (value && (sat.state === 'disconnected' || sat.state === 'discovering') && !sat.needsPairing) {
    // Try what was typed now: it's the first candidate unless discovery has an address.
    const candidates = candidatesFor(sat);
    const parsed = parseTypedHost(value)!;
    const index = candidates.findIndex((a) => a.host === parsed.host);
    sat.candidateIndex = index === -1 ? 0 : index;
    sat.reconnectAttempt = 0;
    if (sat.reconnectTimer) { clearTimeout(sat.reconnectTimer); sat.reconnectTimer = null; }
    useCandidate(sat, candidates);
    if (sat.host && sat.mainPort) connectToSatellite(sat);
  }
  broadcastSatellitesChanged();
  return { ok: true };
}

/** Where this machine is reaching (or last tried) a satellite, as `host:port`. */
export function satelliteAddress(fingerprint: string): string | undefined {
  const sat = satellites.get(fingerprint);
  return sat?.host && sat.mainPort ? formatAddress({ host: sat.host, port: sat.mainPort }) : undefined;
}

export function disconnect(fingerprint: string): void {
  const sat = satellites.get(fingerprint);
  if (sat) disconnectSatellite(sat);
}

/**
 * Permanently forget a satellite: disconnect, remove peer, and clear from memory.
 * After this, the satellite must be re-paired to connect again.
 */
export function forgetSatellite(fingerprint: string): void {
  appLog('core:annex-client', 'info', 'Forgetting satellite', { meta: { fingerprint } });
  const sat = satellites.get(fingerprint);
  if (sat) {
    disconnectSatellite(sat);
    satellites.delete(fingerprint);
  }
  disposeRemoteBuffers(fingerprint);
  annexPeers.removePeer(fingerprint);
  broadcastSatellitesChanged();
}

export function retry(fingerprint: string): void {
  const sat = satellites.get(fingerprint);
  // A paired satellite not seen since startup has no connection yet: start one.
  if (!sat) { connect(fingerprint); return; }
  if (sat.state === 'disconnected') {
    sat.reconnectAttempt = 0;
    sat.needsPairing = false;
    sat.halt = null;
    connectToSatellite(sat);
  }
}

/**
 * Send a message to a satellite's WebSocket.
 * Returns an object with `sent` status and optional error context.
 */
export function sendToSatellite(fingerprint: string, message: Record<string, unknown>): { sent: boolean; error?: string } {
  const action = message.type === 'agent:spawn' ? 'spawn' : message.type === 'agent:wake' ? 'wake' : undefined;
  if (!action) return sendToSatelliteNow(fingerprint, message);
  // Remote spawn/wake: a root flow whose traceparent rides in the envelope as
  // `tc` (spec §7). The satellite continues it only if its own telemetry is on.
  return tel.flow('clubhouse.annex.remote_spawn', { attrs: [ATTR.annexRemoteAction(action)] }, () => {
    const tc = currentTraceparent();
    return sendToSatelliteNow(fingerprint, tc ? { ...message, tc } : message);
  }, { classify: (r) => (r.sent ? 'ok' : { error: r.error === 'not_connected' ? 'not_connected' : 'send_failed' }) });
}

function sendToSatelliteNow(fingerprint: string, message: Record<string, unknown>): { sent: boolean; error?: string } {
  const sat = satellites.get(fingerprint);
  if (!sat || !sat.ws || sat.ws.readyState !== WebSocket.OPEN) {
    return { sent: false, error: 'not_connected' };
  }
  try {
    sat.ws.send(JSON.stringify(message));
    return { sent: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    appLog('core:annex-client', 'warn', 'sendToSatellite: send failed', {
      meta: { fingerprint, error: errorMsg },
    });
    return { sent: false, error: `send_failed: ${errorMsg}` };
  }
}

/**
 * Get the PTY output buffer for a remote agent.
 *
 * Uses a local headless terminal cache (seeded from the satellite on first
 * access, then updated with every pty:data event). This ensures instant
 * buffer restoration when switching tabs, even if the satellite is
 * temporarily unreachable.
 */
export async function requestPtyBuffer(fingerprint: string, agentId: string): Promise<string> {
  return (await getRemoteBufferSnapshot(fingerprint, agentId)).data;
}

/**
 * `requestPtyBuffer` with the seq the buffer includes, matching the `seq` on
 * forwarded `pty:data` events (#2324).
 */
export function requestPtyBufferSnapshot(fingerprint: string, agentId: string): Promise<RemoteBufferSnapshot> {
  return getRemoteBufferSnapshot(fingerprint, agentId);
}

/**
 * Fetch a file tree from a satellite project via HTTPS REST.
 */
export function requestFileTree(fingerprint: string, projectId: string, options?: { path?: string; depth?: number; includeHidden?: boolean }): Promise<unknown[]> {
  const sat = satellites.get(fingerprint);
  if (!sat || sat.state !== 'connected') return Promise.resolve([]);

  const tlsOptions = pinnedTlsOptionsFor(sat.fingerprint);
  const params = new URLSearchParams();
  if (options?.path) params.set('path', options.path);
  if (options?.depth !== undefined) params.set('depth', String(options.depth));
  if (options?.includeHidden) params.set('includeHidden', 'true');
  const qs = params.toString() ? `?${params.toString()}` : '';

  return new Promise<unknown[]>((resolve) => {
    const url = satelliteUrl(sat, `/api/v1/projects/${encodeURIComponent(projectId)}/files/tree${qs}`);
    const req = https.get(url, { ...tlsOptions, timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { drainRefusal(sat, res); resolve([]); return; }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (err) {
          appLog('core:annex-client', 'warn', 'File tree response JSON parse failed', { meta: { fingerprint, error: String(err) } });
          resolve([]);
        }
      });
    });
    req.on('error', (err) => {
      appLog('core:annex-client', 'warn', 'File tree request failed', { meta: { fingerprint, error: err.message } });
      resolve([]);
    });
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

/**
 * Read a file from a satellite project via HTTPS REST.
 */
export function requestFileRead(fingerprint: string, projectId: string, path: string): Promise<string> {
  const sat = satellites.get(fingerprint);
  if (!sat || sat.state !== 'connected') return Promise.resolve('');

  const tlsOptions = pinnedTlsOptionsFor(sat.fingerprint);
  const qs = `?path=${encodeURIComponent(path)}`;

  return new Promise<string>((resolve, reject) => {
    const url = satelliteUrl(sat, `/api/v1/projects/${encodeURIComponent(projectId)}/files/read${qs}`);
    const req = https.get(url, { ...tlsOptions, timeout: 10000 }, (res) => {
      if (res.statusCode === 404) { res.resume(); reject(new Error('File not found')); return; }
      if (res.statusCode !== 200) { drainRefusal(sat, res); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * Fetch group project bulletin digest from a satellite via HTTPS REST.
 */
export function requestBulletinDigest(fingerprint: string, groupProjectId: string, since?: DigestSince): Promise<unknown[]> {
  const sat = satellites.get(fingerprint);
  if (!sat || sat.state !== 'connected') return Promise.resolve([]);

  const tlsOptions = pinnedTlsOptionsFor(sat.fingerprint);
  const params = new URLSearchParams();
  // A satellite predating per-channel read state ignores `sinceChannels` and
  // answers with no cutoff — everything unread, the pre-#1555 behaviour —
  // rather than erroring. That is the compatibility story for this endpoint.
  const encoded = encodeDigestSince(since);
  if (encoded.oversized) {
    appLog('core:annex-client', 'warn', 'Per-channel read map too large for digest request; requesting without a cutoff', {
      meta: { fingerprint, groupProjectId, channels: Object.keys(since as Record<string, string>).length },
    });
  }
  for (const [key, value] of Object.entries(encoded.params)) params.set(key, value);
  const qs = params.toString() ? `?${params.toString()}` : '';

  return new Promise<unknown[]>((resolve) => {
    const url = satelliteUrl(sat, `/api/v1/group-projects/${encodeURIComponent(groupProjectId)}/bulletin/digest${qs}`);
    const req = https.get(url, { ...tlsOptions, timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { drainRefusal(sat, res); resolve([]); return; }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (err) {
          appLog('core:annex-client', 'warn', 'Bulletin digest response JSON parse failed', { meta: { fingerprint, error: String(err) } });
          resolve([]);
        }
      });
    });
    req.on('error', (err) => {
      appLog('core:annex-client', 'warn', 'Bulletin digest request failed', { meta: { fingerprint, error: err.message } });
      resolve([]);
    });
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

/**
 * Fetch group project bulletin topic messages from a satellite via HTTPS REST.
 */
export function requestBulletinTopicMessages(fingerprint: string, groupProjectId: string, topic: string, since?: string, limit?: number): Promise<unknown[]> {
  const sat = satellites.get(fingerprint);
  if (!sat || sat.state !== 'connected') return Promise.resolve([]);

  const tlsOptions = pinnedTlsOptionsFor(sat.fingerprint);
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString() ? `?${params.toString()}` : '';

  return new Promise<unknown[]>((resolve) => {
    const url = satelliteUrl(sat, `/api/v1/group-projects/${encodeURIComponent(groupProjectId)}/bulletin/topics/${encodeURIComponent(topic)}${qs}`);
    const req = https.get(url, { ...tlsOptions, timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { drainRefusal(sat, res); resolve([]); return; }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (err) {
          appLog('core:annex-client', 'warn', 'Bulletin topic messages response JSON parse failed', { meta: { fingerprint, error: String(err) } });
          resolve([]);
        }
      });
    });
    req.on('error', (err) => {
      appLog('core:annex-client', 'warn', 'Bulletin topic messages request failed', { meta: { fingerprint, error: err.message } });
      resolve([]);
    });
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

/**
 * Fetch a single group project from a satellite via HTTPS REST.
 */
export function requestGroupProjectGet(fingerprint: string, groupProjectId: string): Promise<unknown> {
  return satelliteHttpsRequest(fingerprint, 'GET', `/api/v1/group-projects/${encodeURIComponent(groupProjectId)}`);
}

/**
 * Update a group project on a satellite via HTTPS REST (PATCH).
 */
export function requestGroupProjectUpdate(
  fingerprint: string,
  groupProjectId: string,
  fields: { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> },
): Promise<unknown> {
  return satelliteHttpsRequest(fingerprint, 'PATCH', `/api/v1/group-projects/${encodeURIComponent(groupProjectId)}`, fields);
}

/**
 * Fetch all bulletin messages from a satellite group project via HTTPS REST.
 */
export function requestBulletinAllMessages(
  fingerprint: string,
  groupProjectId: string,
  since?: string,
  limit?: number,
): Promise<unknown[]> {
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString() ? `?${params.toString()}` : '';

  const sat = satellites.get(fingerprint);
  if (!sat || sat.state !== 'connected') return Promise.resolve([]);

  const tlsOptions = pinnedTlsOptionsFor(sat.fingerprint);

  return new Promise<unknown[]>((resolve) => {
    const url = satelliteUrl(sat, `/api/v1/group-projects/${encodeURIComponent(groupProjectId)}/bulletin/messages${qs}`);
    const req = https.get(url, { ...tlsOptions, timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { drainRefusal(sat, res); resolve([]); return; }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (err) {
          appLog('core:annex-client', 'warn', 'Bulletin all-messages response JSON parse failed', { meta: { fingerprint, error: String(err) } });
          resolve([]);
        }
      });
    });
    req.on('error', (err) => {
      appLog('core:annex-client', 'warn', 'Bulletin all-messages request failed', { meta: { fingerprint, error: err.message } });
      resolve([]);
    });
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

/**
 * Post a bulletin message to a satellite group project via HTTPS REST.
 */
export function requestBulletinPostMessage(
  fingerprint: string,
  groupProjectId: string,
  sender: string,
  topic: string,
  body: string,
): Promise<unknown> {
  return satelliteHttpsRequest(
    fingerprint,
    'POST',
    `/api/v1/group-projects/${encodeURIComponent(groupProjectId)}/bulletin/messages`,
    { sender, topic, body },
  );
}

/**
 * Send a shoulder tap / broadcast to a satellite group project via HTTPS REST.
 */
export function requestShoulderTap(
  fingerprint: string,
  groupProjectId: string,
  targetAgentId: string | null,
  message: string,
  sender?: string,
): Promise<unknown> {
  return satelliteHttpsRequest(
    fingerprint,
    'POST',
    `/api/v1/group-projects/${encodeURIComponent(groupProjectId)}/shoulder-tap`,
    { targetAgentId, message, sender: sender || 'remote' },
  );
}

/**
 * Delete a specific message from a satellite's group project bulletin board.
 */
export function requestDeleteMessage(
  fingerprint: string,
  groupProjectId: string,
  topic: string,
  messageId: string,
): Promise<unknown> {
  return satelliteHttpsRequest(
    fingerprint,
    'DELETE',
    `/api/v1/group-projects/${encodeURIComponent(groupProjectId)}/bulletin/topics/${encodeURIComponent(topic)}/messages/${encodeURIComponent(messageId)}`,
  );
}

/**
 * Delete an entire topic from a satellite's group project bulletin board.
 */
export function requestDeleteTopic(
  fingerprint: string,
  groupProjectId: string,
  topic: string,
): Promise<unknown> {
  return satelliteHttpsRequest(
    fingerprint,
    'DELETE',
    `/api/v1/group-projects/${encodeURIComponent(groupProjectId)}/bulletin/topics/${encodeURIComponent(topic)}`,
  );
}

/**
 * Set topic protection on a satellite's group project bulletin board.
 */
export function requestSetTopicProtection(
  fingerprint: string,
  groupProjectId: string,
  topic: string,
  isProtected: boolean,
): Promise<unknown> {
  return satelliteHttpsRequest(
    fingerprint,
    'PATCH',
    `/api/v1/group-projects/${encodeURIComponent(groupProjectId)}/bulletin/topics/${encodeURIComponent(topic)}/protection`,
    { isProtected },
  );
}

/**
 * Set the project-wide polling setting on a satellite group project via HTTPS REST.
 * Runs setProjectPolling on the satellite so the persisted setting + member
 * side-effect stay identical to a local toggle.
 */
export function requestGroupProjectSetPolling(
  fingerprint: string,
  groupProjectId: string,
  enabled: boolean,
): Promise<unknown> {
  return satelliteHttpsRequest(
    fingerprint,
    'POST',
    `/api/v1/group-projects/${encodeURIComponent(groupProjectId)}/polling`,
    { enabled },
  );
}

/**
 * Inject a message into an agent's PTY on a satellite (with proper chunked paste).
 */
export function requestInjectMessage(
  fingerprint: string,
  agentId: string,
  message: string,
): Promise<unknown> {
  return satelliteHttpsRequest(
    fingerprint,
    'POST',
    '/api/v1/inject-message',
    { agentId, message },
  );
}

export function getDiscoveredServices(): DiscoveredService[] {
  return Array.from(discoveredServices.values());
}

// ---------------------------------------------------------------------------
// Generic HTTPS request helper for satellite REST APIs
// ---------------------------------------------------------------------------

function satelliteHttpsRequest(
  fingerprint: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const sat = satellites.get(fingerprint);
  if (!sat || sat.state !== 'connected') return Promise.reject(new Error('Satellite not connected'));

  const tlsOptions = pinnedTlsOptionsFor(sat.fingerprint);
  const url = satelliteUrl(sat, `${urlPath}`);

  return new Promise<unknown>((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const traceparent = currentTraceparent();
    const headers: Record<string, string | number> = {
      ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      ...(traceparent ? { traceparent } : {}),
    };
    const options: https.RequestOptions = {
      ...tlsOptions,
      method,
      timeout: 30000,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    };

    const req = https.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(text)); }
          catch { resolve(text); }
        } else {
          noteRestRefusal(sat, res.statusCode, text);
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Git remote proxy (REST)
// ---------------------------------------------------------------------------

export interface GitOperationParams {
  operation: string;
  path?: string;
  message?: string;
  branch?: string;
  hash?: string;
  file?: string;
  staged?: boolean;
  limit?: number;
  offset?: number;
}

export async function requestGitOperation(
  fingerprint: string,
  projectId: string,
  params: GitOperationParams,
): Promise<unknown> {
  const encodedProjectId = encodeURIComponent(projectId);
  const { operation } = params;

  // Read operations via GET
  switch (operation) {
    case 'info':
      return satelliteHttpsRequest(fingerprint, 'GET', `/api/v1/projects/${encodedProjectId}/git/info`);
    case 'log': {
      const qs = new URLSearchParams();
      if (params.limit !== undefined) qs.set('limit', String(params.limit));
      if (params.offset !== undefined) qs.set('offset', String(params.offset));
      const q = qs.toString();
      return satelliteHttpsRequest(fingerprint, 'GET', `/api/v1/projects/${encodedProjectId}/git/log${q ? `?${q}` : ''}`);
    }
    case 'diff': {
      const qs = new URLSearchParams();
      if (params.file) qs.set('file', params.file);
      if (params.staged) qs.set('staged', 'true');
      return satelliteHttpsRequest(fingerprint, 'GET', `/api/v1/projects/${encodedProjectId}/git/diff?${qs.toString()}`);
    }
    case 'show-commit': {
      const qs = new URLSearchParams();
      if (params.hash) qs.set('hash', params.hash);
      return satelliteHttpsRequest(fingerprint, 'GET', `/api/v1/projects/${encodedProjectId}/git/show-commit?${qs.toString()}`);
    }
    case 'commit-diff': {
      const qs = new URLSearchParams();
      if (params.hash) qs.set('hash', params.hash);
      if (params.file) qs.set('file', params.file);
      return satelliteHttpsRequest(fingerprint, 'GET', `/api/v1/projects/${encodedProjectId}/git/commit-diff?${qs.toString()}`);
    }
    default:
      // Write operations via POST
      return satelliteHttpsRequest(fingerprint, 'POST', `/api/v1/projects/${encodedProjectId}/git/${operation}`, {
        path: params.path,
        message: params.message,
        branch: params.branch,
      });
  }
}

// ---------------------------------------------------------------------------
// Session remote proxy (REST)
// ---------------------------------------------------------------------------

export async function requestSessionList(
  fingerprint: string,
  agentId: string,
  projectId: string,
  orchestrator?: string,
): Promise<unknown> {
  const qs = new URLSearchParams();
  qs.set('projectId', projectId);
  if (orchestrator) qs.set('orchestrator', orchestrator);
  return satelliteHttpsRequest(fingerprint, 'GET',
    `/api/v1/agents/${encodeURIComponent(agentId)}/sessions?${qs.toString()}`);
}

export async function requestSessionTranscript(
  fingerprint: string,
  agentId: string,
  sessionId: string,
  projectId: string,
  offset: number,
  limit: number,
  orchestrator?: string,
): Promise<unknown> {
  const qs = new URLSearchParams();
  qs.set('projectId', projectId);
  qs.set('offset', String(offset));
  qs.set('limit', String(limit));
  if (orchestrator) qs.set('orchestrator', orchestrator);
  return satelliteHttpsRequest(fingerprint, 'GET',
    `/api/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/transcript?${qs.toString()}`);
}

export async function requestSessionSummary(
  fingerprint: string,
  agentId: string,
  sessionId: string,
  projectId: string,
  orchestrator?: string,
): Promise<unknown> {
  const qs = new URLSearchParams();
  qs.set('projectId', projectId);
  if (orchestrator) qs.set('orchestrator', orchestrator);
  return satelliteHttpsRequest(fingerprint, 'GET',
    `/api/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/summary?${qs.toString()}`);
}

// ---------------------------------------------------------------------------
// Durable agent remote proxy (REST)
// ---------------------------------------------------------------------------

export async function requestCreateDurable(
  fingerprint: string,
  projectId: string,
  params: {
    name: string;
    color: string;
    model?: string;
    useWorktree?: boolean;
    orchestrator?: string;
    freeAgentMode?: boolean;
    mcpIds?: string[];
  },
): Promise<unknown> {
  return satelliteHttpsRequest(fingerprint, 'POST',
    `/api/v1/projects/${encodeURIComponent(projectId)}/agents/durable`, params);
}

export async function requestDeleteDurable(
  fingerprint: string,
  projectId: string,
  agentId: string,
  mode: string,
): Promise<unknown> {
  return satelliteHttpsRequest(fingerprint, 'POST',
    `/api/v1/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/delete`, { mode });
}

export async function requestWorktreeStatus(
  fingerprint: string,
  projectId: string,
  agentId: string,
): Promise<unknown> {
  return satelliteHttpsRequest(fingerprint, 'GET',
    `/api/v1/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/worktree-status`);
}

export interface PairResultForUi { success: boolean; error?: string; alias?: string; fingerprint?: string }

/** Certificates read from discovered services, waiting for the person to compare and enter a PIN. */
const probedCertificates = new Map<string, annexTls.PinnedCertificate & { host: string; port: number }>();

/**
 * Reads the certificate a discovered service shows, so the person can compare
 * its code with the one in that computer's Annex settings before sending a PIN.
 */
export async function probeService(fingerprint: string): Promise<{ success: boolean; certFingerprint?: string; error?: string }> {
  // A discovered service, or a satellite that needs pairing again at its last announced address.
  const discovered = discoveredServices.get(fingerprint);
  const known = satellites.get(fingerprint);
  const host = discovered?.host || known?.host;
  const port = discovered?.mainPort || known?.mainPort;
  if (!discovered && !known) return { success: false, error: 'Service not found. It may have gone offline.' };
  if (!host || !port) return { success: false, error: "That computer hasn't been found on the network yet. Paste its pairing link instead." };
  try {
    const cert = await annexTls.probePeerCertificate(host, port);
    probedCertificates.set(fingerprint, { ...cert, host, port });
    return { success: true, certFingerprint: cert.fingerprint };
  } catch (err) { // telemetry-exempt: shown to the person pairing
    return { success: false, error: pairingReachError(err, discovered?.alias || known?.alias || '') };
  }
}

/**
 * Pair with a discovered service, after `probeService` and the person confirming
 * the certificate code matches. The PIN only ever goes to that certificate.
 */
export function pairWithService(fingerprint: string, pin: string): Promise<PairResultForUi> {
  return pairFlow(() => pairWithServiceImpl(fingerprint, pin), (r) => (r.success ? 'ok' : pairResultFor(r.error)));
}

async function pairWithServiceImpl(fingerprint: string, pin: string): Promise<PairResultForUi> {
  const probed = probedCertificates.get(fingerprint);
  if (!probed) return { success: false, error: "Check the computer's certificate code first." };
  const pairingPort = discoveredServices.get(fingerprint)?.pairingPort ?? satellites.get(fingerprint)?.pairingPort ?? 0;
  return pairOverTls({
    host: probed.host,
    port: probed.port,
    pinned: { certPem: probed.certPem, fingerprint: probed.fingerprint },
    expectedFingerprint: fingerprint,
    pairingPort,
    pin,
    alias: discoveredServices.get(fingerprint)?.alias ?? satellites.get(fingerprint)?.alias,
  });
}

/**
 * Pair using another computer's pairing link (the one its Annex settings show
 * as a QR code). The link names the certificate, so nothing needs comparing by
 * eye: an address showing any other certificate is never sent the PIN.
 */
export function pairWithLink(link: string): Promise<PairResultForUi> {
  return pairFlow(() => pairWithLinkImpl(link), (r) => (r.success ? 'ok' : pairResultFor(r.error)));
}

async function pairWithLinkImpl(link: string): Promise<PairResultForUi> {
  const parts = parsePairingUrl(link);
  if (!parts) return { success: false, error: "That isn't a Clubhouse pairing link. Copy it from the other computer's Annex settings." };
  let lastError = 'Could not reach that computer at any of its addresses.';
  for (const host of parts.hosts) {
    let cert: annexTls.PinnedCertificate;
    try {
      cert = await annexTls.probePeerCertificate(host, parts.port);
    } catch (err) { // telemetry-exempt: the next address is tried, and the last error is shown
      lastError = pairingReachError(err, parts.name);
      continue;
    }
    if (!annexTls.sameCertificateFingerprint(cert.fingerprint, parts.certFingerprint)) {
      appLog('core:annex-client', 'warn', 'Pairing link address showed a different certificate; not sending the PIN', { meta: { host, port: parts.port } });
      lastError = 'The computer at that address is not the one in the link.';
      continue;
    }
    return pairOverTls({ host, port: parts.port, pinned: cert, expectedFingerprint: parts.fingerprint, pairingPort: 0, pin: parts.pin, alias: parts.name, linkHosts: parts.hosts });
  }
  return { success: false, error: lastError };
}

/** A failure to reach a computer while pairing, as what happened and what to do. */
function pairingReachError(err: unknown, alias: string): string {
  return annexProblemText(describeAnnexProblem(classifyConnectionError(err), alias, { pairing: true }));
}

/** Plain messages for a satellite's pairing refusals that don't carry their own. */
function pairErrorMessage(status: number, body: { error?: string; message?: string }): string {
  if (typeof body.message === 'string' && body.message) return body.message;
  if (status === 404) return 'That computer needs a newer version of Clubhouse to pair. Update it, then pair again.';
  if (body.error === 'invalid_pin') return "That code doesn't match. Check the code on the other computer and try again.";
  if (body.error === 'rate_limited') return 'Too many attempts. Wait a moment and try again.';
  return body.error || `Pairing failed (HTTP ${status})`;
}

async function pairOverTls(target: {
  host: string;
  port: number;
  pinned: annexTls.PinnedCertificate;
  expectedFingerprint: string;
  pairingPort: number;
  pin: string;
  /** The name it's known by so far, for messages. */
  alias?: string;
  /** Every host its pairing link lists, remembered as other ways to reach it (#3058). */
  linkHosts?: string[];
}): Promise<PairResultForUi> {
  const localIdentity = annexIdentity.getOrCreateIdentity();
  if (target.expectedFingerprint.toLowerCase() === localIdentity.fingerprint.toLowerCase()) {
    return { success: false, error: "That's this computer." };
  }
  const localSettings = annexSettings.getSettings();
  let res: { status: number; body: string };
  try {
    const tlsOptions = annexTls.createPinnedTlsClientOptions(localIdentity, target.pinned);
    res = await pinnedJsonPost(target.host, target.port, '/pair', tlsOptions, {
      pin: target.pin,
      publicKey: localIdentity.publicKey,
      alias: localSettings.alias,
      icon: localSettings.icon,
      color: localSettings.color,
      certBinding: annexTls.signCertBinding(localIdentity),
    });
  } catch (err) { // telemetry-exempt: shown to the person pairing; the pair flow records the result
    return { success: false, error: pairingReachError(err, target.alias ?? '') };
  }

  let body: Record<string, unknown> = {};
  try { body = JSON.parse(res.body) as Record<string, unknown>; } catch { /* telemetry-exempt: the status still says what happened */ }
  if (res.status !== 200) {
    return { success: false, error: pairErrorMessage(res.status, body as { error?: string; message?: string }) };
  }

  // Believe nothing in the answer that doesn't check out against what we pinned.
  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.toLowerCase() : '';
  const publicKey = typeof body.publicKey === 'string' ? body.publicKey : '';
  if (!fingerprint || !publicKey || annexIdentity.computeFingerprint(publicKey) !== fingerprint
    || fingerprint !== target.expectedFingerprint.toLowerCase()) {
    return { success: false, error: "That computer's answer didn't match its identity. Nothing was saved." };
  }
  if (typeof body.tlsCertificateFingerprint === 'string'
    && !annexTls.sameCertificateFingerprint(body.tlsCertificateFingerprint, target.pinned.fingerprint)) {
    return { success: false, error: "That computer's answer didn't match its certificate. Nothing was saved." };
  }

  const alias = typeof body.alias === 'string' && body.alias ? body.alias : 'Clubhouse';
  const icon = typeof body.icon === 'string' && body.icon ? body.icon : 'computer';
  const color = typeof body.color === 'string' && body.color ? body.color : 'indigo';
  annexPeers.addPeer({
    fingerprint,
    publicKey,
    alias,
    icon,
    color,
    pairedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    role: 'satellite', // We paired with them → they are our satellite
    tlsCertificateFingerprint: target.pinned.fingerprint,
    tlsCertificatePem: target.pinned.certPem,
    knownHosts: rememberHost(target.linkHosts, target.host),
    mainPort: target.port,
    // A typed host survives pairing again.
    ...(annexPeers.getPeer(fingerprint)?.typedHost && { typedHost: annexPeers.getPeer(fingerprint)!.typedHost }),
  });

  probedCertificates.delete(fingerprint);
  if (discoveredServices.delete(fingerprint)) broadcastDiscoveredChanged();
  const previous = satellites.get(fingerprint);
  if (previous) disconnectSatellite(previous);

  const sat: SatelliteConnectionInternal = {
    id: fingerprint,
    alias,
    icon,
    color,
    fingerprint,
    state: 'disconnected',
    host: target.host,
    mainPort: target.port,
    pairingPort: target.pairingPort,
    snapshot: null,
    lastError: null,
    ws: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    needsPairing: false,
    heartbeatInterval: null,
    pongTimeout: null,
  };
  satellites.set(fingerprint, sat);
  broadcastSatellitesChanged();
  connectToSatellite(sat);

  appLog('core:annex-client', 'info', 'Paired with satellite', { meta: { fingerprint, alias } });
  return { success: true, alias, fingerprint };
}

function pinnedJsonPost(host: string, port: number, urlPath: string, tlsOptions: tls.ConnectionOptions, data: unknown): Promise<{ status: number; body: string }> {
  const json = JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const req = https.request(`https://${bracketHost(host)}:${port}${urlPath}`, {
      ...tlsOptions,
      method: 'POST',
      agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => { chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Timed out pairing with that computer')); });
    req.write(json);
    req.end();
  });
}

/**
 * Forget all satellites: disconnect all, remove all peers, clear all state.
 * Used for purging all client-side annex config.
 */
export function forgetAllSatellites(): void {
  appLog('core:annex-client', 'info', 'Forgetting all satellites');
  for (const sat of satellites.values()) {
    disconnectSatellite(sat);
    disposeRemoteBuffers(sat.id);
  }
  satellites.clear();
  seededBuffers.clear();
  // Only our satellites: devices that control this machine are managed in Annex settings.
  for (const peer of annexPeers.listPeers()) {
    if (peer.role !== 'controller') annexPeers.removePeer(peer.fingerprint);
  }
  probedCertificates.clear();
  discoveredServices.clear();
  broadcastSatellitesChanged();
  broadcastDiscoveredChanged();
}

export function scan(): void {
  // Clear discovered services on rescan so stale entries are dropped
  discoveredServices.clear();
  broadcastDiscoveredChanged();
  stopDiscovery();
  startDiscovery();
}

/**
 * Resume all disconnected satellites (e.g., after power resume).
 */
export function resumeAllConnections(): void {
  // Waking never starts the client: with Connect to satellites off there's nothing to resume.
  if (!annexSettings.getSettings().enableClient) return;
  for (const sat of satellites.values()) {
    if (sat.state === 'disconnected') {
      sat.reconnectAttempt = 0; // Reset backoff on resume
      sat.candidateIndex = 0;
      useCandidate(sat, candidatesFor(sat));
      connectToSatellite(sat);
    }
  }
  restorePairedSatellites();
  // Also restart discovery in case mDNS state was lost
  scan();
}

export function startClient(): void {
  startDiscovery();
  restorePairedSatellites();
}

export function stopClient(): void {
  // Disconnect all satellites
  for (const sat of satellites.values()) {
    disconnectSatellite(sat);
    disposeRemoteBuffers(sat.id);
  }
  satellites.clear();
  seededBuffers.clear();
  discoveredServices.clear();
  stopDiscovery();
}

/** For testing only: register a connected satellite without a socket. */
export function _addConnectedSatelliteForTesting(fingerprint: string, snapshot: SatelliteSnapshot | null = null): void {
  satellites.set(fingerprint, {
    id: fingerprint,
    alias: fingerprint,
    icon: '',
    color: '',
    fingerprint,
    state: 'connected',
    host: '127.0.0.1',
    mainPort: 1,
    pairingPort: 1,
    snapshot,
    lastError: null,
    ws: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    needsPairing: false,
    heartbeatInterval: null,
    pongTimeout: null,
  });
}

/** For testing only: handle a message as if it arrived on a satellite's socket. */
export function _receiveSatelliteMessageForTesting(fingerprint: string, msg: Record<string, unknown>): void {
  const sat = satellites.get(fingerprint);
  if (sat) handleSatelliteMessage(sat, msg);
}

/** For testing only: mark a connected satellite disconnected. */
export function _receiveSatelliteDisconnectForTesting(fingerprint: string): void {
  const sat = satellites.get(fingerprint);
  if (sat) setState(sat, 'disconnected');
}
