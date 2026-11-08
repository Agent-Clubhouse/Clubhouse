/**
 * The Annex Network channel (#3060): a WebSocket between two paired desktops
 * that carries network membership and nothing else.
 *
 * - Served at `/network` on the main TLS port, beside `/ws`. Either side of a
 *   pairing may open it: unlike `/ws`, it accepts a pinned peer of either role,
 *   because membership isn't control.
 * - Every message is parsed against `annex-network-protocol.ts`. Anything that
 *   isn't exactly a membership message closes the channel. Nothing here can
 *   reach agents, terminals, files or settings: this module imports none of them.
 * - The first message each way is `hello`, naming the sender. It must match the
 *   identity and certificate the connection authenticated with.
 * - Each message is acted on only while the sender is still paired with the
 *   certificate the socket authenticated with, so a removal ends it at once.
 *
 * Stage 3 records what each member says. Stage 4 (#3061) acts on it.
 */
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import * as net from 'net';
import * as tls from 'tls';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { AnnexNetworkMemberListing, AnnexPeer } from '../../shared/types';
import {
  NETWORK_CHANNEL_PATH,
  NETWORK_CLOSE_NOT_MEMBERSHIP,
  NETWORK_CLOSE_VERSION,
  NETWORK_MESSAGE_MAX_BYTES,
  NETWORK_PROTOCOL_VERSION,
  parseNetworkMessage,
  type NetworkMember,
  type NetworkMessage,
  type NetworkRemoval,
} from '../../shared/annex-network-protocol';
import * as annexIdentity from './annex-identity';
import * as annexPeers from './annex-peers';
import * as annexSettings from './annex-settings';
import * as annexTls from './annex-tls';
import { appLog } from './log-service';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Channel {
  ws: WebSocket;
  /** Identity fingerprint the connection authenticated as. */
  fingerprint: string;
  /** Certificate SHA-256 it authenticated with. */
  certFingerprint: string;
  direction: 'in' | 'out';
  /** Its hello, once received. */
  member: NetworkMember | null;
}

/** What one member last told this machine. */
export interface MemberView {
  member: NetworkMember;
  members: NetworkMember[];
  removals: NetworkRemoval[];
  /** ISO time of its last message. */
  at: string;
}

const channels = new Set<Channel>();
const views = new Map<string, MemberView>();
const listeners = new Set<(from: string, message: NetworkMessage) => void>();

let reachProvider: (() => { hosts: string[]; port: number }) | null = null;
let wss: WebSocketServer | null = null;

/** How long a channel may stay silent before its hello, before it's closed. */
const HELLO_TIMEOUT_MS = 10_000;
/** A ping this often; no pong by the next one and the channel is dead (sleep, a network change). */
const HEARTBEAT_MS = 30_000;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** Says where this machine's server can be reached, for its hello. Set while the server runs. */
export function setReachProvider(provider: (() => { hosts: string[]; port: number }) | null): void {
  reachProvider = provider;
}

/** This machine as a network member. Null before it has an identity. */
export function localMember(): NetworkMember | null {
  const identity = annexIdentity.getIdentity();
  if (!identity) return null;
  let certFingerprint: string;
  let certPem: string;
  try {
    certPem = annexTls.getOrCreateCert(identity).certPem;
    certFingerprint = annexTls.certificateFingerprint(certPem);
  } catch { // telemetry-exempt: no certificate yet, so nothing to say hello with
    return null;
  }
  const settings = annexSettings.getSettings();
  const reach = reachProvider?.();
  return {
    fingerprint: identity.fingerprint,
    publicKey: identity.publicKey,
    certFingerprint,
    certPem,
    name: (settings.alias || settings.deviceName || 'Clubhouse').slice(0, 200),
    icon: settings.icon || 'computer',
    color: settings.color || 'indigo',
    kind: 'desktop',
    hosts: (reach?.hosts ?? []).slice(0, 8),
    ...(reach && reach.port > 0 && { port: reach.port }),
    joinedAt: identity.createdAt,
  };
}

/** Hears every accepted membership message, with the fingerprint that sent it. */
export function onNetworkMessage(listener: (from: string, message: NetworkMessage) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** What each member has told this machine, keyed by fingerprint. */
export function memberViews(): ReadonlyMap<string, MemberView> {
  return views;
}

/** Whether a channel to or from this device is open (whether or not it has said hello yet). */
export function hasChannel(fingerprint: string): boolean {
  for (const ch of channels) if (ch.fingerprint === fingerprint) return true;
  return false;
}

/** Members this machine has heard from, for Settings and tests. */
export function listMembers(): AnnexNetworkMemberListing[] {
  const connected = connectedMembers();
  return [...views.entries()].filter(([fingerprint]) => !!annexPeers.getPeer(fingerprint)).map(([fingerprint, view]) => ({
    fingerprint,
    name: view.member.name,
    kind: view.member.kind,
    connected: connected.has(fingerprint),
    memberCount: view.members.length,
    lastHeard: view.at,
  }));
}

/** Fingerprints with an open channel that has said hello. */
export function connectedMembers(): Set<string> {
  const out = new Set<string>();
  for (const ch of channels) if (ch.member && ch.ws.readyState === WebSocket.OPEN) out.add(ch.fingerprint);
  return out;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Still paired, with the certificate this channel authenticated with. */
function stillPaired(ch: Channel): boolean {
  const peer = annexPeers.getPeer(ch.fingerprint);
  return !!peer && !annexPeers.peerNeedsPairing(peer) && annexTls.sameCertificateFingerprint(peer.tlsCertificateFingerprint, ch.certFingerprint);
}

/**
 * Who may open the channel to this machine: a paired peer of either role, with
 * exactly its pinned certificate. Older pairings must pair again.
 */
export function authenticateMember(socket: unknown): { ok: true; peer: AnnexPeer; certFingerprint: string } | { ok: false; status: 401; error: string } {
  if (!(socket instanceof tls.TLSSocket) || !socket.encrypted) return { ok: false, status: 401, error: 'unauthorized' };
  const fingerprint = annexTls.extractPeerFingerprint(socket);
  if (!fingerprint) return { ok: false, status: 401, error: 'unauthorized' };
  const peer = annexPeers.getPeer(fingerprint);
  if (!peer) return { ok: false, status: 401, error: 'peer_not_paired' };
  if (annexPeers.peerNeedsPairing(peer)) return { ok: false, status: 401, error: 'needs_pairing' };
  const certFingerprint = annexTls.extractPeerCertificateFingerprint(socket);
  if (!certFingerprint || !annexTls.sameCertificateFingerprint(certFingerprint, peer.tlsCertificateFingerprint)) {
    return { ok: false, status: 401, error: 'peer_not_paired' };
  }
  return { ok: true, peer, certFingerprint };
}

// ---------------------------------------------------------------------------
// One channel
// ---------------------------------------------------------------------------

function send(ch: Channel, message: NetworkMessage): void {
  if (ch.ws.readyState !== WebSocket.OPEN) return;
  // Never tell a removed or re-pinned device anything, even one that stays silent.
  if (!stillPaired(ch)) { refuse(ch, NETWORK_CLOSE_NOT_MEMBERSHIP, 'peer_not_paired', 'not paired'); return; }
  try { ch.ws.send(JSON.stringify(message)); } catch { /* telemetry-exempt: a closing socket; its close handler cleans up */ }
}

function refuse(ch: Channel, code: number, reason: string, detail: string): void {
  channels.delete(ch);
  appLog('core:annex', 'warn', 'Annex Network channel refused a message and closed', {
    meta: { fingerprint: ch.fingerprint, direction: ch.direction, reason: detail },
  });
  try { ch.ws.close(code, reason); } catch { /* telemetry-exempt: already closing */ }
  const timer = setTimeout(() => { try { ch.ws.terminate(); } catch { /* telemetry-exempt: already gone */ } }, 250);
  timer.unref?.();
}

function sendHello(ch: Channel): void {
  const self = localMember();
  if (!self) return;
  send(ch, { v: NETWORK_PROTOCOL_VERSION, type: 'hello', member: self });
  send(ch, { v: NETWORK_PROTOCOL_VERSION, type: 'members', members: localMembers(), removals: [] });
}

/** This machine and every member that has said hello on an open channel. */
export function localMembers(): NetworkMember[] {
  const out: NetworkMember[] = [];
  const self = localMember();
  if (self) out.push(self);
  for (const ch of channels) {
    if (ch.member && stillPaired(ch) && !out.some((m) => m.fingerprint === ch.member!.fingerprint)) out.push(ch.member);
  }
  return out;
}

/** The member's public key is the one its fingerprint is the hash of. */
function keyMatches(member: NetworkMember): boolean {
  try {
    return annexIdentity.computeFingerprint(member.publicKey).toLowerCase() === member.fingerprint.toLowerCase();
  } catch { // telemetry-exempt: a key that can't be read doesn't match
    return false;
  }
}

function handle(ch: Channel, data: RawData, isBinary: boolean): void {
  if (ch.ws.readyState !== WebSocket.OPEN || !channels.has(ch)) return;
  if (!stillPaired(ch)) { refuse(ch, NETWORK_CLOSE_NOT_MEMBERSHIP, 'peer_not_paired', 'not paired'); return; }
  if (isBinary) { refuse(ch, NETWORK_CLOSE_NOT_MEMBERSHIP, 'membership_only', 'binary frame'); return; }
  const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
  const parsed = parseNetworkMessage(raw);
  if ('reason' in parsed) {
    if (parsed.reason === 'version') refuse(ch, NETWORK_CLOSE_VERSION, 'unsupported_version', parsed.reason);
    else refuse(ch, NETWORK_CLOSE_NOT_MEMBERSHIP, 'membership_only', parsed.reason);
    return;
  }
  const message = parsed.message;
  if (!ch.member) {
    // The first message must say who this is, and match how it authenticated.
    if (message.type !== 'hello'
      || message.member.fingerprint.toLowerCase() !== ch.fingerprint.toLowerCase()
      || !keyMatches(message.member)
      || !annexTls.sameCertificateFingerprint(message.member.certFingerprint, ch.certFingerprint)) {
      refuse(ch, NETWORK_CLOSE_NOT_MEMBERSHIP, 'membership_only', 'hello does not match the connection');
      return;
    }
    ch.member = message.member;
    views.set(ch.fingerprint, { member: message.member, members: [], removals: [], at: new Date().toISOString() });
  } else if (message.type === 'hello') {
    refuse(ch, NETWORK_CLOSE_NOT_MEMBERSHIP, 'membership_only', 'second hello');
    return;
  } else {
    const view = views.get(ch.fingerprint)!;
    view.at = new Date().toISOString();
    if (message.type === 'members') { view.members = message.members; view.removals = message.removals; }
  }
  for (const listener of [...listeners]) {
    try { listener(ch.fingerprint, message); } catch (err) { // telemetry-exempt: logged; one listener must not stop the rest
      appLog('core:annex', 'warn', 'Annex Network listener failed', { meta: { error: err instanceof Error ? err.message : String(err) } });
    }
  }
}

function attach(ws: WebSocket, fingerprint: string, certFingerprint: string, direction: 'in' | 'out'): Channel {
  const ch: Channel = { ws, fingerprint, certFingerprint, direction, member: null };
  channels.add(ch);
  const helloTimer = setTimeout(() => {
    if (!ch.member) refuse(ch, NETWORK_CLOSE_NOT_MEMBERSHIP, 'membership_only', 'no hello');
  }, HELLO_TIMEOUT_MS);
  helloTimer.unref?.();
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const heartbeat = setInterval(() => {
    if (!alive) { refuse(ch, NETWORK_CLOSE_NOT_MEMBERSHIP, 'timeout', 'no pong'); return; }
    alive = false;
    try { ws.ping(); } catch { /* telemetry-exempt: a closing socket; its close handler cleans up */ }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  ws.on('message', (data, isBinary) => handle(ch, data, isBinary));
  ws.on('close', () => {
    clearTimeout(helloTimer);
    clearInterval(heartbeat);
    channels.delete(ch);
  });
  ws.on('error', (err) => {
    appLog('core:annex', 'debug', 'Annex Network channel error', { meta: { fingerprint, direction, error: err.message } });
  });
  return ch;
}

// ---------------------------------------------------------------------------
// Incoming (server)
// ---------------------------------------------------------------------------

function refuseUpgrade(socket: Duplex, status: number, error: string): void {
  const body = JSON.stringify({ error });
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Bad Request'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

/** Whether an upgrade request is for this channel. */
export function isNetworkUpgrade(pathname: string): boolean {
  return pathname === NETWORK_CHANNEL_PATH;
}

/** Takes an upgrade to `/network` on the main TLS server. */
export function handleNetworkUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const auth = authenticateMember(socket);
  if ('error' in auth) {
    appLog('core:annex', 'warn', 'Refused an Annex Network channel', { meta: { error: auth.error, remoteAddress: req.socket.remoteAddress } });
    refuseUpgrade(socket, auth.status, auth.error);
    return;
  }
  wss ??= new WebSocketServer({ noServer: true, maxPayload: NETWORK_MESSAGE_MAX_BYTES });
  wss.handleUpgrade(req, socket, head, (ws) => {
    // One incoming channel per device: a new one replaces the old (it reconnected, or the old is dead).
    closeFor(auth.peer.fingerprint, 'in');
    const ch = attach(ws, auth.peer.fingerprint, auth.certFingerprint, 'in');
    sendHello(ch);
  });
}

// ---------------------------------------------------------------------------
// Outgoing (client)
// ---------------------------------------------------------------------------

/**
 * Opens the channel to a paired peer at `host:port`, pinned to its certificate.
 * Does nothing if one is already open or opening to it.
 */
export function connectTo(fingerprint: string, host: string, port: number, tlsOptions: tls.ConnectionOptions): void {
  // The main connection just opened, so any older outgoing channel is from before: replace it.
  closeFor(fingerprint, 'out');
  const peer = annexPeers.getPeer(fingerprint);
  if (!peer?.tlsCertificateFingerprint || annexPeers.peerNeedsPairing(peer) || !host || !port) return;
  const authority = net.isIPv6(host) ? `[${host}]` : host;
  const ws = new WebSocket(`wss://${authority}:${port}${NETWORK_CHANNEL_PATH}`, { ...tlsOptions, handshakeTimeout: 10_000, maxPayload: NETWORK_MESSAGE_MAX_BYTES });
  const ch = attach(ws, fingerprint, peer.tlsCertificateFingerprint, 'out');
  ws.on('open', () => sendHello(ch));
  ws.on('unexpected-response', (_req, res) => {
    appLog('core:annex', 'info', 'A paired computer did not open the Annex Network channel', { meta: { fingerprint, status: res.statusCode } });
    try { ws.terminate(); } catch { /* telemetry-exempt: refused upgrade */ }
  });
}

/**
 * Closes channels with a device: `out` ones this machine opened, `in` ones it
 * accepted, or both. A device no longer paired is also forgotten from what's heard.
 */
export function closeFor(fingerprint: string, direction: 'in' | 'out' | 'both' = 'both'): void {
  if (!annexPeers.getPeer(fingerprint)) views.delete(fingerprint);
  for (const ch of [...channels]) {
    if (ch.fingerprint !== fingerprint || (direction !== 'both' && ch.direction !== direction)) continue;
    try { ch.ws.close(NETWORK_CLOSE_NOT_MEMBERSHIP, 'peer_not_paired'); } catch { /* telemetry-exempt: already closing */ }
    const ws = ch.ws;
    const timer = setTimeout(() => { try { ws.terminate(); } catch { /* telemetry-exempt: already gone */ } }, 250);
    timer.unref?.();
    channels.delete(ch);
  }
}

/**
 * Closes every channel in one direction: `in` when this machine's server stops,
 * `out` when its client does. Each side's channels belong to it.
 */
export function closeAll(direction: 'in' | 'out' | 'both' = 'both'): void {
  for (const ch of [...channels]) closeFor(ch.fingerprint, direction);
  if (direction !== 'out') {
    wss?.close();
    wss = null;
  }
}

/** Test helper. */
export function resetNetworkChannelForTests(): void {
  closeAll();
  views.clear();
  listeners.clear();
  reachProvider = null;
}

/** Test helper: wraps an already-open socket as a channel, as an accepted upgrade would. */
export function _attachForTesting(ws: WebSocket, fingerprint: string, certFingerprint: string, direction: 'in' | 'out' = 'in'): void {
  attach(ws, fingerprint, certFingerprint, direction);
}
