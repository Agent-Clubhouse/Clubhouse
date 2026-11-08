/**
 * The short code two computers' Settings show for an Annex TLS certificate, for
 * comparing by eye before pairing from a discovered service: the first 16 hex
 * digits of its SHA-256, in four groups. Null for anything that isn't a SHA-256.
 */
export function certificateCode(fingerprint: string | undefined | null): string | null {
  const hex = (fingerprint ?? '').replace(/[:\s]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return hex.slice(0, 16).match(/.{4}/g)!.join(' ');
}
