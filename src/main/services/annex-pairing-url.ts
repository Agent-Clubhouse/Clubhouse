import type { NetworkInterfaceInfo } from 'os';

/**
 * The `clubhousego://pair` link shown as a QR code in Annex settings (v1).
 * Clubhouse Go parses it, so its parameters are a contract: add new ones,
 * never rename or repurpose these.
 */
export const PAIRING_URL_VERSION = '1';

export interface PairingUrlParts {
  /** Addresses to try, best first. */
  hosts: string[];
  /** Main TLS server port: the phone POSTs `/pair` there. */
  port: number;
  /** Identity fingerprint (colon-separated hex), as in AnnexStatus.fingerprint. */
  fingerprint: string;
  /** SHA-256 of the TLS leaf certificate, in any colon/case form. */
  certFingerprint: string;
  pin: string;
  name: string;
}

/** Lowercase hex without separators, or null when it isn't a SHA-256. */
export function normalizeCertFingerprint(fingerprint: string): string | null {
  const hex = fingerprint.replace(/[:\s]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/** Lower is preferred; null for addresses a phone can't use. */
function ipv4Rank(address: string): number | null {
  const parts = address.split('.').map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) return null;
  const [a, b] = parts;
  if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)) return null;
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  if (a === 100 && b >= 64 && b <= 127) return 3; // Tailscale / CGNAT
  return 4;
}

/**
 * This machine's IPv4 addresses for the pairing link: private LAN ranges
 * first, then Tailscale, then anything else routable. A server bound to one
 * address is only reachable there, so that is the only host.
 */
export function pairingHosts(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  boundHost: string,
): string[] {
  if (boundHost && boundHost !== '0.0.0.0') return [boundHost];
  const ranked: Array<{ address: string; rank: number }> = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      // Node 18.0-18.3 reported family as a number.
      const family = info.family as string | number;
      if ((family !== 'IPv4' && family !== 4) || info.internal) continue;
      const rank = ipv4Rank(info.address);
      if (rank === null || ranked.some((r) => r.address === info.address)) continue;
      ranked.push({ address: info.address, rank });
    }
  }
  return ranked.sort((x, y) => x.rank - y.rank).map((r) => r.address);
}

/** The pairing link, or null while any part of it is missing. */
export function buildPairingUrl(parts: PairingUrlParts): string | null {
  const cert = normalizeCertFingerprint(parts.certFingerprint);
  if (parts.hosts.length === 0 || !(parts.port > 0) || !parts.fingerprint || !cert || !parts.pin) return null;
  const params = new URLSearchParams();
  params.set('v', PAIRING_URL_VERSION);
  for (const host of parts.hosts) params.append('host', host);
  params.set('port', String(parts.port));
  params.set('id', parts.fingerprint);
  params.set('cert', cert);
  params.set('pin', parts.pin);
  params.set('name', parts.name);
  // URLSearchParams writes spaces as '+', which iOS URLComponents leaves as a
  // literal plus. A real '+' is already %2B, so every '+' left is a space.
  return `clubhousego://pair?${params.toString().replace(/\+/g, '%20')}`;
}
