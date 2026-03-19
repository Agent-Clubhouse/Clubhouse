/**
 * Annex V2 mTLS Transport (#861)
 *
 * Generates self-signed X.509 certificates for mutual TLS authentication
 * between Clubhouse instances. Uses RSA-2048 for TLS certificates via
 * node-forge, while identity/fingerprinting still uses Ed25519.
 *
 * The TLS certificate's CN is set to the instance's Ed25519 fingerprint,
 * binding the TLS identity to the Annex identity.
 *
 * Certificate and key are stored alongside the identity in annex-identity.json.
 */
import * as tls from 'tls';
import * as fs from 'fs';
import * as path from 'path';
import forge from 'node-forge';
import { app } from 'electron';
import { appLog } from './log-service';
import type { AnnexIdentity } from './annex-identity';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TlsCertificateInfo {
  /** PEM-encoded certificate */
  certPem: string;
  /** PEM-encoded private key */
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
// Self-signed certificate generation via node-forge
// ---------------------------------------------------------------------------

/**
 * Generate a self-signed X.509 certificate using RSA-2048.
 * The CN is set to the Ed25519 fingerprint for identity binding.
 */
function generateSelfSignedCert(fingerprint: string): TlsCertificateInfo {
  const keys = forge.pki.rsa.generateKeyPair(2048);

  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));

  const now = new Date();
  const expires = new Date(now);
  expires.setDate(expires.getDate() + CERT_VALIDITY_DAYS);
  cert.validity.notBefore = now;
  cert.validity.notAfter = expires;

  const attrs = [{ name: 'commonName', value: fingerprint }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    generatedAt: now.toISOString(),
  };
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
