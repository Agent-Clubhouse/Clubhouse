/**
 * Annex V2 Client — Service Discovery & Connection (#862)
 *
 * Bonjour browser for `_clubhouse-annex._tcp` services, filtered against the
 * peer list. Manages per-satellite state machines and mTLS WebSocket connections.
 * Stores snapshots per satellite and forwards events to the renderer via IPC.
 */
import * as https from 'https';
import * as http from 'http';
import Bonjour, { Browser, Service as RemoteService } from 'bonjour-service';
import { WebSocket } from 'ws';
import * as annexIdentity from './annex-identity';
import * as annexTls from './annex-tls';
import * as annexPeers from './annex-peers';
import * as annexSettings from './annex-settings';
import * as headlessTerminal from './pty-headless-terminal';
import { appLog } from './log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { IPC } from '../../shared/ipc-channels';

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
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  bearerToken: string | null;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  pongTimeout: ReturnType<typeof setTimeout> | null;
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

/**
 * Cache incoming PTY data for a remote agent in a local headless terminal.
 * Called whenever a pty:data event arrives via WebSocket.
 */
export function cacheRemotePtyData(satelliteId: string, agentId: string, data: string): void {
  headlessTerminal.feedData(remoteBufferKey(satelliteId, agentId), data);
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
}

/**
 * Seed the local cache from the satellite's buffer (one-time on first access).
 * Returns the seeded data, or the existing local cache if already seeded.
 */
async function seedAndGetBuffer(satelliteId: string, agentId: string): Promise<string> {
  const key = `${satelliteId}:${agentId}`;
  const localBuffer = getLocalRemoteBuffer(satelliteId, agentId);

  // If already seeded, return local cache
  if (seededBuffers.has(key)) {
    return localBuffer;
  }

  // Try to fetch from satellite to seed the local cache
  const sat = satellites.get(satelliteId);
  if (!sat || sat.state !== 'connected') {
    // Can't reach satellite — return whatever local cache we have
    seededBuffers.add(key);
    return localBuffer;
  }

  try {
    const identity = annexIdentity.getOrCreateIdentity();
    const tlsOptions = annexTls.createTlsClientOptions(identity);

    const satelliteBuffer = await new Promise<string>((resolve) => {
      const url = `https://${sat.host}:${sat.mainPort}/api/v1/agents/${encodeURIComponent(agentId)}/buffer`;
      const req = https.get(url, { ...tlsOptions, timeout: 5000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve('');
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    });

    if (satelliteBuffer && !localBuffer) {
      // Seed the local headless terminal with the satellite's full buffer.
      // This only happens once — subsequent pty:data events build on top.
      headlessTerminal.feedData(remoteBufferKey(satelliteId, agentId), satelliteBuffer);
    }

    seededBuffers.add(key);
    // Return the richer of the two buffers
    return satelliteBuffer || localBuffer;
  } catch {
    seededBuffers.add(key);
    return localBuffer;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function broadcastSatellitesChanged(): void {
  broadcastToAllWindows(IPC.ANNEX_CLIENT?.SATELLITES_CHANGED || 'annex-client:satellites-changed', getSatellites());
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
  };
}

function setState(sat: SatelliteConnectionInternal, state: SatelliteState, error?: string): void {
  const prev = sat.state;
  sat.state = state;
  if (error !== undefined) sat.lastError = error;
  appLog('core:annex-client', error ? 'warn' : 'info', `Satellite state: ${prev} → ${state}`, {
    meta: { fingerprint: sat.fingerprint, alias: sat.alias, ...(error ? { error } : {}) },
  });
  broadcastSatellitesChanged();
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpGet(host: string, port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${host}:${port}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpPost(host: string, port: number, path: string, data: unknown): Promise<{ status: number; body: string }> {
  const json = JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: host,
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(json);
    req.end();
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

async function identifyService(service: RemoteService): Promise<RemoteIdentity | null> {
  const txt = service.txt || {};
  // Prefer resolved IP addresses over hostname — on Linux os.hostname() returns a
  // bare name (e.g. "desk") that macOS cannot resolve, while .local hostnames from
  // macOS work fine.  The addresses array and referer.address are always IPs.
  const host = service.addresses?.[0] || service.referer?.address || service.host;
  if (!host) return null;

  // V2 services have a pairingPort in TXT
  const pPort = txt.pairingPort ? parseInt(txt.pairingPort, 10) : service.port;
  if (!pPort) return null;

  try {
    const res = await httpGet(host, pPort, '/api/v1/identity');
    if (res.status !== 200) {
      appLog('core:annex-client', 'warn', 'Identity request failed', { meta: { host, port: pPort, status: res.status } });
      return null;
    }
    const identity = JSON.parse(res.body);
    if (!identity.fingerprint) {
      appLog('core:annex-client', 'warn', 'Identity response missing fingerprint', { meta: { host, port: pPort } });
      return null;
    }
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
    return null;
  }
}

async function connectToSatellite(sat: SatelliteConnectionInternal): Promise<void> {
  setState(sat, 'connecting');

  const identity = annexIdentity.getOrCreateIdentity();

  // Connect via WebSocket using mTLS (preferred) with optional bearer token fallback
  try {
    const tlsOptions = annexTls.createTlsClientOptions(identity);
    // Build URL: use bearer token if available (e.g. fresh pairing), otherwise mTLS handles auth
    const tokenParam = sat.bearerToken ? `?token=${encodeURIComponent(sat.bearerToken)}` : '';
    const wsUrl = `wss://${sat.host}:${sat.mainPort}/ws${tokenParam}`;

    appLog('core:annex-client', 'info', 'Connecting to satellite', {
      meta: { fingerprint: sat.fingerprint, host: sat.host, port: sat.mainPort, hasBearerToken: !!sat.bearerToken },
    });

    const ws = new WebSocket(wsUrl, {
      ...tlsOptions,
      handshakeTimeout: 10_000,
    });

    sat.ws = ws;

    ws.on('open', () => {
      appLog('core:annex-client', 'info', 'Connected to satellite', {
        meta: { fingerprint: sat.fingerprint, host: sat.host, port: sat.mainPort },
      });
      setState(sat, 'connected');
      sat.reconnectAttempt = 0;
      annexPeers.updateLastSeen(sat.fingerprint);
      startHeartbeat(sat);
    });

    ws.on('pong', () => {
      // Clear the pong timeout — connection is alive
      if (sat.pongTimeout) {
        clearTimeout(sat.pongTimeout);
        sat.pongTimeout = null;
      }
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleSatelliteMessage(sat, msg);
      } catch {
        appLog('core:annex-client', 'warn', 'Malformed JSON from satellite', {
          meta: { fingerprint: sat.fingerprint, preview: data.toString().slice(0, 200) },
        });
      }
    });

    ws.on('close', () => {
      sat.ws = null;
      if (sat.state === 'connected') {
        setState(sat, 'disconnected', 'Connection closed');
        scheduleReconnect(sat);
      }
    });

    ws.on('error', (err) => {
      appLog('core:annex-client', 'error', 'WebSocket error', {
        meta: { fingerprint: sat.fingerprint, error: err.message },
      });
      sat.ws = null;
      setState(sat, 'disconnected', err.message);
      scheduleReconnect(sat);
    });
  } catch (err) {
    setState(sat, 'disconnected', err instanceof Error ? err.message : 'Connection failed');
    scheduleReconnect(sat);
  }
}

function handleSatelliteMessage(sat: SatelliteConnectionInternal, msg: Record<string, unknown>): void {
  const type = msg.type as string;

  switch (type) {
    case 'snapshot':
      sat.snapshot = msg.payload as SatelliteSnapshot;
      broadcastSatellitesChanged();
      broadcastSatelliteEvent(sat.id, 'snapshot', msg.payload);
      break;

    case 'pty:data': {
      // Cache remotely-received PTY data locally for instant buffer replay
      const ptyPayload = msg.payload as { agentId?: string; data?: string };
      if (ptyPayload?.agentId && ptyPayload?.data) {
        cacheRemotePtyData(sat.id, ptyPayload.agentId, ptyPayload.data);
      }
      broadcastSatelliteEvent(sat.id, type, msg.payload);
      break;
    }

    case 'pty:exit':
    case 'hook:event':
    case 'structured:event':
    case 'agent:spawned':
    case 'agent:woken':
    case 'agent:completed':
    case 'permission:request':
    case 'permission:response':
    case 'theme:changed':
    case 'canvas:state':
      broadcastSatelliteEvent(sat.id, type, msg.payload);
      break;

    default:
      // Forward any unknown message types
      broadcastSatelliteEvent(sat.id, type, msg.payload);
      break;
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
      sat.ws.ping();
    } catch {
      stopHeartbeat(sat);
      setState(sat, 'disconnected', 'Heartbeat ping failed');
      scheduleReconnect(sat);
      return;
    }
    // Set pong timeout
    sat.pongTimeout = setTimeout(() => {
      appLog('core:annex-client', 'warn', 'Heartbeat pong timeout — closing connection', {
        meta: { fingerprint: sat.fingerprint },
      });
      if (sat.ws) {
        try { sat.ws.terminate(); } catch (err) {
          appLog('core:annex-client', 'debug', 'Failed to terminate WebSocket on heartbeat timeout', {
            meta: { fingerprint: sat.fingerprint, error: err instanceof Error ? err.message : String(err) },
          });
        }
        sat.ws = null;
      }
      setState(sat, 'disconnected', 'Heartbeat timeout');
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
  if (sat.reconnectTimer) clearTimeout(sat.reconnectTimer);

  // Check if auto-reconnect is enabled
  const settings = annexSettings.getSettings();
  if (!settings.autoReconnect) {
    appLog('core:annex-client', 'info', 'Auto-reconnect disabled, not scheduling', { meta: { fingerprint: sat.fingerprint } });
    return;
  }

  // Exponential backoff: 1s, 2s, 4s, 8s, 30s cap
  const delay = Math.min(1000 * Math.pow(2, sat.reconnectAttempt), 30_000);
  sat.reconnectAttempt++;
  appLog('core:annex-client', 'info', `Scheduling reconnect in ${delay}ms (attempt ${sat.reconnectAttempt})`, {
    meta: { fingerprint: sat.fingerprint, alias: sat.alias },
  });

  sat.reconnectTimer = setTimeout(() => {
    if (sat.state === 'disconnected') {
      connectToSatellite(sat);
    }
  }, delay);
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

function startDiscovery(): void {
  if (bonjourBrowser) return;

  try {
    bonjourInstance = new Bonjour();
    bonjourBrowser = bonjourInstance.find({ type: 'clubhouse-annex' }, async (service) => {
      const identity = await identifyService(service);
      if (!identity) return;

      const { fingerprint } = identity;
      const txt = service.txt || {};
      const host = service.addresses?.[0] || service.referer?.address || service.host || '';
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
          const hostChanged = host !== sat.host || mainPort !== sat.mainPort;
          if (hostChanged) {
            sat.host = host;
            sat.mainPort = mainPort;
            sat.pairingPort = pairingPort;
          }
          // Auto-reconnect if disconnected (mTLS handles auth — no bearer token needed)
          if (sat.state === 'disconnected' && sat.host && sat.mainPort) {
            connectToSatellite(sat);
          }
          return;
        }

        const peer = annexPeers.getPeer(fingerprint);
        if (!peer) return;

        const sat: SatelliteConnectionInternal = {
          id: fingerprint,
          alias: peer.alias,
          icon: peer.icon,
          color: peer.color,
          fingerprint,
          state: 'discovering',
          host,
          mainPort,
          pairingPort,
          snapshot: null,
          lastError: null,
          ws: null,
          reconnectTimer: null,
          reconnectAttempt: 0,
          bearerToken: null,
          heartbeatInterval: null,
          pongTimeout: null,
        };

        satellites.set(fingerprint, sat);
        broadcastSatellitesChanged();

        appLog('core:annex-client', 'info', 'Discovered paired satellite', {
          meta: { fingerprint, alias: peer.alias, host, port: mainPort },
        });

        // Auto-connect using mTLS (no bearer token needed for paired peers)
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
export function connect(fingerprint: string, bearerToken?: string): void {
  let sat = satellites.get(fingerprint);
  if (!sat) {
    const peer = annexPeers.getPeer(fingerprint);
    if (!peer) {
      appLog('core:annex-client', 'warn', 'Cannot connect — unknown peer', { meta: { fingerprint } });
      return;
    }
    sat = {
      id: fingerprint,
      alias: peer.alias,
      icon: peer.icon,
      color: peer.color,
      fingerprint,
      state: 'disconnected',
      host: '',
      mainPort: 0,
      pairingPort: 0,
      snapshot: null,
      lastError: null,
      ws: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      bearerToken: bearerToken || null,
      heartbeatInterval: null,
      pongTimeout: null,
    };
    satellites.set(fingerprint, sat);
  }

  if (bearerToken) sat.bearerToken = bearerToken;

  if (sat.state !== 'disconnected') {
    appLog('core:annex-client', 'info', 'Satellite already connecting/connected', { meta: { fingerprint } });
    return;
  }

  if (sat.host && sat.mainPort) {
    connectToSatellite(sat);
  } else {
    // Will connect when discovered via Bonjour
    setState(sat, 'discovering');
  }
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
  if (sat && sat.state === 'disconnected') {
    sat.reconnectAttempt = 0;
    connectToSatellite(sat);
  }
}

/**
 * Send a message to a satellite's WebSocket.
 * Returns an object with `sent` status and optional error context.
 */
export function sendToSatellite(fingerprint: string, message: Record<string, unknown>): { sent: boolean; error?: string } {
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
export function requestPtyBuffer(fingerprint: string, agentId: string): Promise<string> {
  return seedAndGetBuffer(fingerprint, agentId);
}

/**
 * Fetch a file tree from a satellite project via HTTPS REST.
 */
export function requestFileTree(fingerprint: string, projectId: string, options?: { path?: string; depth?: number; includeHidden?: boolean }): Promise<unknown[]> {
  const sat = satellites.get(fingerprint);
  if (!sat || sat.state !== 'connected') return Promise.resolve([]);

  const identity = annexIdentity.getOrCreateIdentity();
  const tlsOptions = annexTls.createTlsClientOptions(identity);
  const params = new URLSearchParams();
  if (options?.path) params.set('path', options.path);
  if (options?.depth !== undefined) params.set('depth', String(options.depth));
  if (options?.includeHidden) params.set('includeHidden', 'true');
  const qs = params.toString() ? `?${params.toString()}` : '';

  return new Promise<unknown[]>((resolve) => {
    const url = `https://${sat.host}:${sat.mainPort}/api/v1/projects/${encodeURIComponent(projectId)}/files/tree${qs}`;
    const req = https.get(url, { ...tlsOptions, timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve([]); return; }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

/**
 * Read a file from a satellite project via HTTPS REST.
 */
export function requestFileRead(fingerprint: string, projectId: string, path: string): Promise<string> {
  const sat = satellites.get(fingerprint);
  if (!sat || sat.state !== 'connected') return Promise.resolve('');

  const identity = annexIdentity.getOrCreateIdentity();
  const tlsOptions = annexTls.createTlsClientOptions(identity);
  const qs = `?path=${encodeURIComponent(path)}`;

  return new Promise<string>((resolve, reject) => {
    const url = `https://${sat.host}:${sat.mainPort}/api/v1/projects/${encodeURIComponent(projectId)}/files/read${qs}`;
    const req = https.get(url, { ...tlsOptions, timeout: 10000 }, (res) => {
      if (res.statusCode === 404) { res.resume(); reject(new Error('File not found')); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
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
export function requestBulletinDigest(fingerprint: string, groupProjectId: string, since?: string): Promise<unknown[]> {
  const sat = satellites.get(fingerprint);
  if (!sat || sat.state !== 'connected') return Promise.resolve([]);

  const identity = annexIdentity.getOrCreateIdentity();
  const tlsOptions = annexTls.createTlsClientOptions(identity);
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  const qs = params.toString() ? `?${params.toString()}` : '';

  return new Promise<unknown[]>((resolve) => {
    const url = `https://${sat.host}:${sat.mainPort}/api/v1/group-projects/${encodeURIComponent(groupProjectId)}/bulletin/digest${qs}`;
    const req = https.get(url, { ...tlsOptions, timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve([]); return; }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

/**
 * Fetch group project bulletin topic messages from a satellite via HTTPS REST.
 */
export function requestBulletinTopicMessages(fingerprint: string, groupProjectId: string, topic: string, since?: string, limit?: number): Promise<unknown[]> {
  const sat = satellites.get(fingerprint);
  if (!sat || sat.state !== 'connected') return Promise.resolve([]);

  const identity = annexIdentity.getOrCreateIdentity();
  const tlsOptions = annexTls.createTlsClientOptions(identity);
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString() ? `?${params.toString()}` : '';

  return new Promise<unknown[]>((resolve) => {
    const url = `https://${sat.host}:${sat.mainPort}/api/v1/group-projects/${encodeURIComponent(groupProjectId)}/bulletin/topics/${encodeURIComponent(topic)}${qs}`;
    const req = https.get(url, { ...tlsOptions, timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve([]); return; }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
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

  const identity = annexIdentity.getOrCreateIdentity();
  const tlsOptions = annexTls.createTlsClientOptions(identity);

  return new Promise<unknown[]>((resolve) => {
    const url = `https://${sat.host}:${sat.mainPort}/api/v1/group-projects/${encodeURIComponent(groupProjectId)}/bulletin/messages${qs}`;
    const req = https.get(url, { ...tlsOptions, timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve([]); return; }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
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

export function getDiscoveredServices(): DiscoveredService[] {
  return Array.from(discoveredServices.values());
}

// ---------------------------------------------------------------------------
// Generic HTTPS request helper for satellite REST APIs
// ---------------------------------------------------------------------------

function satelliteHttpsRequest(
  fingerprint: string,
  method: 'GET' | 'POST' | 'PATCH',
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const sat = satellites.get(fingerprint);
  if (!sat || sat.state !== 'connected') return Promise.reject(new Error('Satellite not connected'));

  const identity = annexIdentity.getOrCreateIdentity();
  const tlsOptions = annexTls.createTlsClientOptions(identity);
  const url = `https://${sat.host}:${sat.mainPort}${urlPath}`;

  return new Promise<unknown>((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      ...tlsOptions,
      method,
      timeout: 30000,
      headers: bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : undefined,
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

/**
 * Pair with a discovered (unpaired) service by fingerprint and PIN.
 * On success, adds the peer, removes it from discovered, creates a satellite,
 * and initiates connection.
 */
export async function pairWithService(fingerprint: string, pin: string): Promise<{ success: boolean; error?: string }> {
  const discovered = discoveredServices.get(fingerprint);
  if (!discovered) {
    return { success: false, error: 'Service not found — it may have gone offline' };
  }

  const localIdentity = annexIdentity.getOrCreateIdentity();
  const localSettings = annexSettings.getSettings();

  try {
    const res = await httpPost(discovered.host, discovered.pairingPort, '/pair', {
      pin,
      publicKey: localIdentity.publicKey,
      alias: localSettings.alias,
      icon: localSettings.icon,
      color: localSettings.color,
    });

    if (res.status !== 200) {
      const body = (() => { try { return JSON.parse(res.body); } catch { return {}; } })();
      return { success: false, error: body.error || `Pairing failed (HTTP ${res.status})` };
    }

    const response = JSON.parse(res.body);
    const bearerToken: string = response.token;

    // Add as a paired peer — we initiated pairing, so this peer is our satellite
    annexPeers.addPeer({
      fingerprint: discovered.fingerprint,
      publicKey: discovered.publicKey,
      alias: discovered.alias,
      icon: discovered.icon,
      color: discovered.color,
      pairedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      role: 'satellite', // We paired with them → they are our satellite
    });

    // Remove from discovered
    discoveredServices.delete(fingerprint);
    broadcastDiscoveredChanged();

    // Create satellite entry and connect
    const sat: SatelliteConnectionInternal = {
      id: fingerprint,
      alias: discovered.alias,
      icon: discovered.icon,
      color: discovered.color,
      fingerprint,
      state: 'disconnected',
      host: discovered.host,
      mainPort: discovered.mainPort,
      pairingPort: discovered.pairingPort,
      snapshot: null,
      lastError: null,
      ws: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      bearerToken,
      heartbeatInterval: null,
      pongTimeout: null,
    };

    satellites.set(fingerprint, sat);
    broadcastSatellitesChanged();

    // Initiate connection
    connectToSatellite(sat);

    appLog('core:annex-client', 'info', 'Paired with service', {
      meta: { fingerprint, alias: discovered.alias },
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Pairing failed' };
  }
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
  annexPeers.removeAllPeers();
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
  for (const sat of satellites.values()) {
    if (sat.state === 'disconnected') {
      sat.reconnectAttempt = 0; // Reset backoff on resume
      connectToSatellite(sat);
    }
  }
  // Also restart discovery in case mDNS state was lost
  scan();
}

export function startClient(): void {
  startDiscovery();
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
