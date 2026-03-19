/**
 * mTLS Identity Generator for Annex V2 E2E Tests
 *
 * Generates Ed25519 identity keypairs and RSA-2048 self-signed X.509
 * certificates for mutual TLS authentication in tests. Uses node-forge
 * for proper X.509 certificate generation instead of hand-rolled ASN.1.
 */
import * as crypto from 'crypto';
import forge from 'node-forge';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestIdentity {
  /** Base64-encoded Ed25519 public key (DER/SPKI) — for POST /pair { publicKey } */
  ed25519PublicKeyBase64: string;
  /** Colon-hex SHA-256 fingerprint (first 16 bytes), becomes the X.509 CN */
  fingerprint: string;
  /** PEM-encoded self-signed RSA-2048 X.509 certificate */
  certPem: string;
  /** PEM-encoded RSA-2048 private key */
  keyPem: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CERT_VALIDITY_DAYS = 3650;

// ---------------------------------------------------------------------------
// Fingerprint computation (from annex-identity.ts:53-57)
// ---------------------------------------------------------------------------

function computeFingerprint(publicKeyBase64: string): string {
  const hash = crypto.createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex');
  return hash.slice(0, 32).match(/.{2}/g)!.join(':');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a complete test identity with Ed25519 keypair (for pairing) and
 * RSA-2048 self-signed X.509 cert (for mTLS).
 */
export function generateTestIdentity(): TestIdentity {
  // 1. Ed25519 keypair for identity/pairing
  const ed25519 = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const ed25519PublicKeyBase64 = (ed25519.publicKey as Buffer).toString('base64');
  const fingerprint = computeFingerprint(ed25519PublicKeyBase64);

  // 2. RSA-2048 keypair + self-signed cert via node-forge
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
  cert.setIssuer(attrs);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  // Self-test: verify the cert is parseable
  const parsed = new crypto.X509Certificate(certPem);
  const subjectCN = parsed.subject.split('CN=')[1];
  if (!subjectCN || !subjectCN.startsWith(fingerprint.slice(0, 5))) {
    throw new Error(`Self-test failed: cert CN "${subjectCN}" does not match fingerprint "${fingerprint}"`);
  }

  return { ed25519PublicKeyBase64, fingerprint, certPem, keyPem };
}

/**
 * Connect to an Annex server's WebSocket endpoint using mTLS.
 * The client certificate's CN (fingerprint) must be registered as a paired peer.
 */
export function connectMtlsWs(host: string, port: number, identity: TestIdentity, token?: string): WebSocket {
  const url = token
    ? `wss://${host}:${port}/ws?token=${encodeURIComponent(token)}`
    : `wss://${host}:${port}/ws`;

  return new WebSocket(url, {
    cert: identity.certPem,
    key: identity.keyPem,
    rejectUnauthorized: false,
  });
}
