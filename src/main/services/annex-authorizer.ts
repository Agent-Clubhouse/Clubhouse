/**
 * The one decision for a request to control this machine over Annex (#3613 P1).
 *
 * Every main-port request and `/ws` frame is authorized here, against the
 * caller's principal: its identity, the certificate it presented, and which way
 * the connection it came over was opened. `direct` is a connection the caller
 * opened to this machine. `reverse` is a request the caller sends back over a
 * connection this machine opened to it; nothing reaches it yet (P3 will).
 *
 * Direction never grants anything. A reverse request passes every check a
 * direct one does, and then must also come from an active desktop member of
 * this machine's Annex Network.
 *
 * Pure: peers come from the lookups passed in, so the transport (TLS socket
 * today) only supplies the identity and certificate it verified.
 */
import type { AnnexPeer, AnnexPeerRole } from '../../shared/types';
import { controlsThisMachine } from './annex-peers';

export type AnnexVia = 'direct' | 'reverse';

/** Who is asking: the identity and certificate the transport verified, and the connection's direction. */
export interface AnnexPrincipal {
  /** Identity (public key) fingerprint. */
  fingerprint: string;
  /** Fingerprint of the certificate it presented, equal to its pin here when authorized. */
  pin: string;
  /** Its role here when it was authorized. */
  role: AnnexPeerRole;
  via: AnnexVia;
}

/** What a transport verified, before it is authorized. */
export interface AnnexCaller {
  fingerprint: string;
  pin: string | undefined;
  via: AnnexVia;
}

export type AnnexAuthError = 'unauthorized' | 'peer_not_paired' | 'needs_pairing' | 'peer_role_not_allowed';
export type AnnexAuthRefusal = { ok: false; status: 401 | 403; error: AnnexAuthError; message: string; fingerprint?: string };
export type AnnexAuthResult = { ok: true; fingerprint: string; peer: AnnexPeer; principal: AnnexPrincipal } | AnnexAuthRefusal;

export const AUTH_MESSAGES: Record<AnnexAuthError, string> = {
  unauthorized: 'Connect with the certificate this device was paired with.',
  peer_not_paired: 'This device is not paired with this computer. Pair it again.',
  needs_pairing: 'This pairing is from an older version of Clubhouse. Pair this device again.',
  peer_role_not_allowed: 'This computer is paired to be controlled from here, not to control it.',
};

export function refuse(status: 401 | 403, error: AnnexAuthError, fingerprint?: string): AnnexAuthRefusal {
  return { ok: false, status, error, message: AUTH_MESSAGES[error], ...(fingerprint && { fingerprint }) };
}

export function isRefusal(result: AnnexAuthResult): result is AnnexAuthRefusal { return !result.ok; }

export interface AnnexAuthorizerDeps {
  /** A paired peer, persistent or paired for this session only. */
  findPeer(fingerprint: string): AnnexPeer | undefined;
  /** Paired for this session only (a phone): never a network member. */
  isSessionOnly(fingerprint: string): boolean;
  /** Annex Network is on here. */
  networkEnabled(): boolean;
}

/**
 * May this peer use a reverse connection to control this machine: only an
 * active desktop member of this machine's network. Phones, one-to-one
 * pairings either way, members not yet confirmed and session-only pairings may not.
 */
function reverseEligible(peer: AnnexPeer, deps: AnnexAuthorizerDeps): boolean {
  return peer.role === 'member' && peer.kind === 'desktop' && !peer.networkPending
    && !deps.isSessionOnly(peer.fingerprint) && deps.networkEnabled();
}

/**
 * The decision. Checks, in order: a known peer, a current pairing, a role that
 * controls this machine, a pin, the presented certificate is exactly the pin,
 * and for `reverse` network eligibility on top.
 */
export function authorize(caller: AnnexCaller, deps: AnnexAuthorizerDeps): AnnexAuthResult {
  const { fingerprint } = caller;
  if (!fingerprint) return refuse(401, 'unauthorized');
  const peer = deps.findPeer(fingerprint);
  if (!peer) return refuse(401, 'peer_not_paired', fingerprint);
  if (!peer.role) return refuse(401, 'needs_pairing', fingerprint);
  if (!controlsThisMachine(peer)) return refuse(403, 'peer_role_not_allowed', fingerprint);
  if (!peer.tlsCertificateFingerprint) return refuse(401, 'needs_pairing', fingerprint);
  if (!caller.pin || caller.pin !== peer.tlsCertificateFingerprint) return refuse(401, 'peer_not_paired', fingerprint);
  if (caller.via === 'reverse' && !reverseEligible(peer, deps)) return refuse(403, 'peer_role_not_allowed', fingerprint);
  return { ok: true, fingerprint, peer, principal: { fingerprint, pin: caller.pin, role: peer.role, via: caller.via } };
}

/**
 * Whether an authorized principal still is, now: catches removal, a new pin, a
 * role change or a member going back to pending since it was authorized.
 */
export function reauthorize(principal: AnnexPrincipal, deps: AnnexAuthorizerDeps): AnnexAuthResult {
  return authorize({ fingerprint: principal.fingerprint, pin: principal.pin, via: principal.via }, deps);
}

export function stillAuthorized(principal: AnnexPrincipal | undefined, deps: AnnexAuthorizerDeps): boolean {
  return !!principal && reauthorize(principal, deps).ok;
}
