/**
 * Annex V2 Client — Service Discovery & Connection (#862)
 *
 * Bonjour browser for `_clubhouse-annex._tcp` services, filtered against the
 * peer list. Manages per-satellite state machines and mTLS WebSocket connections.
 * Stores snapshots per satellite and forwards events to the renderer via IPC.
 */
import * as https from 'https';
import * as http from 'http';
import * as tls from 'tls';
import Bonjour, { Browser, Service as RemoteService } from 'bonjour-service';
import { WebSocket } from 'ws';
import * as annexIdentity from './annex-identity';
import * as annexTls from './annex-tls';
import * as annexPeers from './annex-peers';
import * as annexSettings from './annex-settings';
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
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let bonjourBrowser: Browser | null = null;
let bonjourInstance: InstanceType<typeof Bonjour> | null = null;
const satellites = new Map<string, SatelliteConnectionInternal>();

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
// Helpers
// ---------------------------------------------------------------------------

function broadcastSatellitesChanged(): void {
  broadcastToAllWindows(IPC.ANNEX_CLIENT?.SATELLITES_CHANGED || 'annex-client:satellites-changed', getSatellites());
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
  sat.state = state;
  if (error !== undefined) sat.lastError = error;
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

async function identifyService(service: RemoteService): Promise<string | null> {
  const txt = service.txt || {};
  const host = service.host || service.referer?.address;
  if (!host) return null;

  // V2 services have a pairingPort in TXT
  const pPort = txt.pairingPort ? parseInt(txt.pairingPort, 10) : service.port;
  if (!pPort) return null;

  try {
    const res = await httpGet(host, pPort, '/api/v1/identity');
    if (res.status !== 200) return null;
    const identity = JSON.parse(res.body);
    return identity.fingerprint || null;
  } catch {
    return null;
  }
}

async function connectToSatellite(sat: SatelliteConnectionInternal): Promise<void> {
  setState(sat, 'connecting');

  const identity = annexIdentity.getOrCreateIdentity();
  const settings = annexSettings.getSettings();

  // If we don't have a bearer token, pair first
  if (!sat.bearerToken) {
    try {
      // We need the PIN — for now, auto-pairing requires pre-existing peer relationship
      // (pairing was done through the wizard). Check if we already have a token from wizard pairing.
      appLog('core:annex-client', 'warn', 'No bearer token for satellite, cannot auto-connect', {
        meta: { fingerprint: sat.fingerprint },
      });
      setState(sat, 'disconnected', 'Not paired — use the pairing wizard');
      return;
    } catch (err) {
      setState(sat, 'disconnected', err instanceof Error ? err.message : 'Pairing failed');
      return;
    }
  }

  // Connect via WebSocket
  try {
    const tlsOptions = annexTls.createTlsClientOptions(identity);
    const protocol = sat.mainPort ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${sat.host}:${sat.mainPort}/ws?token=${encodeURIComponent(sat.bearerToken)}`;

    const ws = new WebSocket(wsUrl, {
      ...(protocol === 'wss' ? tlsOptions : {}),
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
        // Ignore parse errors
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

    case 'pty:data':
    case 'pty:exit':
    case 'hook:event':
    case 'structured:event':
    case 'agent:spawned':
    case 'agent:completed':
    case 'permission:request':
    case 'permission:response':
    case 'theme:changed':
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
      return;
    }
    // Set pong timeout
    sat.pongTimeout = setTimeout(() => {
      appLog('core:annex-client', 'warn', 'Heartbeat pong timeout — closing connection', {
        meta: { fingerprint: sat.fingerprint },
      });
      if (sat.ws) {
        try { sat.ws.terminate(); } catch { /* ignore */ }
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
  if (!settings.autoReconnect) return;

  // Exponential backoff: 1s, 2s, 4s, 8s, 30s cap
  const delay = Math.min(1000 * Math.pow(2, sat.reconnectAttempt), 30_000);
  sat.reconnectAttempt++;

  sat.reconnectTimer = setTimeout(() => {
    if (sat.state === 'disconnected' && sat.bearerToken) {
      connectToSatellite(sat);
    }
  }, delay);
}

function disconnectSatellite(sat: SatelliteConnectionInternal): void {
  stopHeartbeat(sat);
  if (sat.reconnectTimer) {
    clearTimeout(sat.reconnectTimer);
    sat.reconnectTimer = null;
  }
  if (sat.ws) {
    try { sat.ws.close(); } catch { /* ignore */ }
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
      const fingerprint = await identifyService(service);
      if (!fingerprint) return;

      // Only connect to known peers
      if (!annexPeers.isPairedPeer(fingerprint)) return;

      // Skip if we already have this satellite
      if (satellites.has(fingerprint)) {
        // Update host/port if changed
        const sat = satellites.get(fingerprint)!;
        const txt = service.txt || {};
        const host = service.host || service.referer?.address || sat.host;
        const mainPort = service.port || sat.mainPort;
        const pairingPort = txt.pairingPort ? parseInt(txt.pairingPort, 10) : sat.pairingPort;

        if (host !== sat.host || mainPort !== sat.mainPort) {
          sat.host = host;
          sat.mainPort = mainPort;
          sat.pairingPort = pairingPort;
          // Reconnect if disconnected
          if (sat.state === 'disconnected' && sat.bearerToken) {
            connectToSatellite(sat);
          }
        }
        return;
      }

      // Register new satellite
      const peer = annexPeers.getPeer(fingerprint);
      if (!peer) return;

      const txt = service.txt || {};
      const sat: SatelliteConnectionInternal = {
        id: fingerprint,
        alias: peer.alias,
        icon: peer.icon,
        color: peer.color,
        fingerprint,
        state: 'discovering',
        host: service.host || service.referer?.address || '',
        mainPort: service.port || 0,
        pairingPort: txt.pairingPort ? parseInt(txt.pairingPort, 10) : service.port || 0,
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

      appLog('core:annex-client', 'info', 'Discovered satellite', {
        meta: { fingerprint, alias: peer.alias, host: sat.host, port: sat.mainPort },
      });
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
    try { bonjourBrowser.stop(); } catch { /* ignore */ }
    bonjourBrowser = null;
  }
  if (bonjourInstance) {
    try { bonjourInstance.destroy(); } catch { /* ignore */ }
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

export function retry(fingerprint: string): void {
  const sat = satellites.get(fingerprint);
  if (sat && sat.state === 'disconnected' && sat.bearerToken) {
    sat.reconnectAttempt = 0;
    connectToSatellite(sat);
  }
}

/**
 * Send a message to a satellite's WebSocket.
 */
export function sendToSatellite(fingerprint: string, message: Record<string, unknown>): boolean {
  const sat = satellites.get(fingerprint);
  if (!sat || !sat.ws || sat.ws.readyState !== WebSocket.OPEN) return false;
  sat.ws.send(JSON.stringify(message));
  return true;
}

export function scan(): void {
  stopDiscovery();
  startDiscovery();
}

/**
 * Resume all disconnected satellites (e.g., after power resume).
 */
export function resumeAllConnections(): void {
  for (const sat of satellites.values()) {
    if (sat.state === 'disconnected' && sat.bearerToken) {
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
  }
  satellites.clear();
  stopDiscovery();
}
