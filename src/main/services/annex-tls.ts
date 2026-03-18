/**
 * Annex V2 mTLS Transport (#861)
 *
 * Generates self-signed X.509 certificates for mutual TLS authentication
 * between Clubhouse instances. Uses ECDSA P-256 for TLS certificates (broader
 * Node.js TLS stack support) while identity/fingerprinting still uses Ed25519.
 *
 * The TLS certificate's CN is set to the instance's Ed25519 fingerprint,
 * binding the TLS identity to the Annex identity.
 *
 * Certificate and key are stored alongside the identity in annex-identity.json.
 */
import * as tls from 'tls';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { appLog } from './log-service';
import type { AnnexIdentity } from './annex-identity';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TlsCertificateInfo {
  /** PEM-encoded ECDSA P-256 certificate */
  certPem: string;
  /** PEM-encoded ECDSA P-256 private key */
  keyPem: string;
  /** When the cert was generated (ISO string) */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TLS_CERT_FILENAME = 'annex-tls-cert.json';
const CERT_VALIDITY_DAYS = 3650; // 10 years

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let cachedCert: TlsCertificateInfo | null = null;

// ---------------------------------------------------------------------------
// Self-signed certificate generation using native Node.js crypto
// ---------------------------------------------------------------------------

/**
 * Generate a self-signed X.509 certificate using ECDSA P-256.
 * The CN is set to the Ed25519 fingerprint for identity binding.
 */
function generateSelfSignedCert(fingerprint: string): TlsCertificateInfo {
  // Generate ECDSA P-256 keypair for TLS
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });

  // Create self-signed certificate
  // Node.js 20+ has crypto.X509Certificate but not cert generation.
  // We use the built-in createCertificate approach via a CSR.
  const cert = generateX509(publicKey, privateKey, fingerprint);

  const certPem = cert;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  return {
    certPem,
    keyPem,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Generate a self-signed X.509 certificate in PEM format.
 * Uses raw ASN.1/DER construction since Node.js doesn't have a native cert
 * generation API. The cert is minimal: just enough for mTLS.
 */
function generateX509(
  publicKey: crypto.KeyObject,
  privateKey: crypto.KeyObject,
  cn: string,
): string {
  // Encode the subject/issuer DN (just CN)
  const cnUtf8 = Buffer.from(cn, 'utf-8');
  const cnAttr = asn1Sequence([
    asn1Set([
      asn1Sequence([
        asn1Oid([2, 5, 4, 3]), // OID for CN
        asn1Utf8String(cnUtf8),
      ]),
    ]),
  ]);

  // Serial number (random 16 bytes)
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f; // Ensure positive

  // Validity
  const notBefore = new Date();
  const notAfter = new Date();
  notAfter.setDate(notAfter.getDate() + CERT_VALIDITY_DAYS);

  // Get the public key in DER/SPKI format
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  // Build the TBS (To Be Signed) certificate
  const tbs = asn1Sequence([
    asn1Explicit(0, asn1Integer(Buffer.from([0x02]))), // Version 3 (v3 = 2)
    asn1Integer(serial),
    // Signature algorithm: ECDSA with SHA-256
    asn1Sequence([asn1Oid([1, 2, 840, 10045, 4, 3, 2])]),
    cnAttr, // Issuer
    // Validity
    asn1Sequence([
      asn1UtcTime(notBefore),
      asn1UtcTime(notAfter),
    ]),
    cnAttr, // Subject (self-signed, same as issuer)
    Buffer.from(spkiDer), // SubjectPublicKeyInfo
  ]);

  // Sign the TBS
  const signer = crypto.createSign('SHA256');
  signer.update(tbs);
  const signature = signer.sign(privateKey);

  // Build the full certificate
  const cert = asn1Sequence([
    tbs,
    // Signature algorithm
    asn1Sequence([asn1Oid([1, 2, 840, 10045, 4, 3, 2])]),
    asn1BitString(signature),
  ]);

  // Convert to PEM
  const base64 = cert.toString('base64');
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

// ---------------------------------------------------------------------------
// ASN.1 DER encoding helpers
// ---------------------------------------------------------------------------

function asn1Length(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x100) return Buffer.from([0x81, length]);
  return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
}

function asn1Wrap(tag: number, content: Buffer): Buffer {
  const len = asn1Length(content.length);
  return Buffer.concat([Buffer.from([tag]), len, content]);
}

function asn1Sequence(items: Buffer[]): Buffer {
  return asn1Wrap(0x30, Buffer.concat(items));
}

function asn1Set(items: Buffer[]): Buffer {
  return asn1Wrap(0x31, Buffer.concat(items));
}

function asn1Integer(value: Buffer): Buffer {
  // Ensure positive by prepending 0x00 if high bit set
  if (value[0] & 0x80) {
    value = Buffer.concat([Buffer.from([0x00]), value]);
  }
  return asn1Wrap(0x02, value);
}

function asn1BitString(content: Buffer): Buffer {
  // Prepend 0x00 (no unused bits)
  return asn1Wrap(0x03, Buffer.concat([Buffer.from([0x00]), content]));
}

function asn1Utf8String(content: Buffer): Buffer {
  return asn1Wrap(0x0c, content);
}

function asn1Oid(components: number[]): Buffer {
  const bytes: number[] = [];
  // First two components are encoded as 40*first + second
  bytes.push(40 * components[0] + components[1]);
  for (let i = 2; i < components.length; i++) {
    let value = components[i];
    if (value < 128) {
      bytes.push(value);
    } else {
      const encoded: number[] = [];
      encoded.push(value & 0x7f);
      value >>= 7;
      while (value > 0) {
        encoded.push((value & 0x7f) | 0x80);
        value >>= 7;
      }
      encoded.reverse();
      bytes.push(...encoded);
    }
  }
  return asn1Wrap(0x06, Buffer.from(bytes));
}

function asn1UtcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, '0');
  const str = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return asn1Wrap(0x17, Buffer.from(str, 'ascii'));
}

function asn1Explicit(tag: number, content: Buffer): Buffer {
  return asn1Wrap(0xa0 | tag, content);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function getCertPath(): string {
  return path.join(app.getPath('userData'), TLS_CERT_FILENAME);
}

function loadCert(): TlsCertificateInfo | null {
  try {
    const raw = fs.readFileSync(getCertPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.certPem || !parsed.keyPem) return null;
    return parsed as TlsCertificateInfo;
  } catch {
    return null;
  }
}

function saveCert(cert: TlsCertificateInfo): void {
  const filePath = getCertPath();
  fs.writeFileSync(filePath, JSON.stringify(cert, null, 2), 'utf-8');
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get or create the TLS certificate for this instance.
 */
export function getOrCreateCert(identity: AnnexIdentity): TlsCertificateInfo {
  if (cachedCert) return cachedCert;

  cachedCert = loadCert();
  if (cachedCert) {
    appLog('core:annex', 'info', 'Loaded existing TLS certificate');
    return cachedCert;
  }

  cachedCert = generateSelfSignedCert(identity.fingerprint);
  saveCert(cachedCert);
  appLog('core:annex', 'info', 'Generated new TLS certificate', {
    meta: { cn: identity.fingerprint },
  });

  return cachedCert;
}

/**
 * Create a TLS server options object for the Annex main port.
 * Requests client certificates but validates manually (against peer list).
 */
export function createTlsServerOptions(identity: AnnexIdentity): tls.TlsOptions {
  const cert = getOrCreateCert(identity);
  return {
    cert: cert.certPem,
    key: cert.keyPem,
    requestCert: true,
    rejectUnauthorized: false, // We validate manually against peer list
  };
}

/**
 * Create TLS connection options for connecting to a peer's TLS server.
 * Uses our own cert for mutual authentication.
 */
export function createTlsClientOptions(identity: AnnexIdentity): tls.ConnectionOptions {
  const cert = getOrCreateCert(identity);
  return {
    cert: cert.certPem,
    key: cert.keyPem,
    rejectUnauthorized: false, // We validate the peer's cert manually
  };
}

/**
 * Extract the CN (fingerprint) from a peer certificate presented during TLS handshake.
 * Returns null if no cert or CN is not present.
 */
export function extractPeerFingerprint(socket: tls.TLSSocket): string | null {
  const cert = socket.getPeerCertificate();
  if (!cert || !cert.subject) return null;
  return cert.subject.CN || null;
}

/**
 * Reset cached cert (for testing only).
 */
export function resetForTests(): void {
  cachedCert = null;
}
