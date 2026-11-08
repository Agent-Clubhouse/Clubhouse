/**
 * mTLS Identity Generator for Annex V2 tests
 *
 * Generates Ed25519 identity keypairs and RSA-2048 self-signed X.509
 * certificates whose CN is the identity fingerprint, as a phone or desktop
 * controller presents them. Pairing (`POST /pair` on the main TLS port) pins
 * the certificate, and every later request and WebSocket presents it.
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
  /** Base64-encoded Ed25519 private key (DER/PKCS#8), for signing a certificate binding */
  ed25519PrivateKeyBase64: string;
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
const CERT_BINDING_CONTEXT = 'annex-cert-binding/v1';

// ---------------------------------------------------------------------------
// Fingerprint computation (from annex-identity.ts:53-57)
// ---------------------------------------------------------------------------

function computeFingerprint(publicKeyBase64: string): string {
  const hash = crypto.createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex');
  return hash.slice(0, 32).match(/.{2}/g)!.join(':');
}

/** A self-signed RSA-2048 certificate whose CN is `commonName`. */
function selfSignedCertificate(commonName: string): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);

  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));

  const now = new Date();
  const expires = new Date(now);
  expires.setDate(expires.getDate() + CERT_VALIDITY_DAYS);
  cert.validity.notBefore = now;
  cert.validity.notAfter = expires;

  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  // Self-test: verify the cert is parseable
  const parsed = new crypto.X509Certificate(certPem);
  const subjectCN = parsed.subject.split('CN=')[1];
  if (!subjectCN || !subjectCN.startsWith(commonName.slice(0, 5))) {
    throw new Error(`Self-test failed: cert CN "${subjectCN}" does not match "${commonName}"`);
  }

  return { certPem, keyPem };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a complete test identity with Ed25519 keypair (for pairing) and
 * RSA-2048 self-signed X.509 cert (for mTLS).
 */
export function generateTestIdentity(): TestIdentity {
  const ed25519 = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const ed25519PublicKeyBase64 = (ed25519.publicKey as Buffer).toString('base64');
  const ed25519PrivateKeyBase64 = (ed25519.privateKey as Buffer).toString('base64');
  const fingerprint = computeFingerprint(ed25519PublicKeyBase64);
  return { ed25519PublicKeyBase64, ed25519PrivateKeyBase64, fingerprint, ...selfSignedCertificate(fingerprint) };
}

/** The same identity (keys and fingerprint) with a newly generated client certificate. */
export function withNewCertificate(identity: TestIdentity): TestIdentity {
  return { ...identity, ...selfSignedCertificate(identity.fingerprint) };
}

/** SHA-256 of a certificate's DER, as lowercase hex without separators. */
export function certificateSha256(cert: string | Buffer): string {
  return new crypto.X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase();
}

/**
 * The `certBinding` a pairing body carries to replace an identity's pinned
 * certificate: the identity key's Ed25519 signature over
 * `"annex-cert-binding/v1" || SHA-256(certificate DER)`, base64.
 */
export function signCertBinding(identity: TestIdentity): string {
  const der = new crypto.X509Certificate(identity.certPem).raw;
  const message = Buffer.concat([Buffer.from(CERT_BINDING_CONTEXT, 'utf8'), crypto.createHash('sha256').update(der).digest()]);
  const key = crypto.createPrivateKey({ key: Buffer.from(identity.ed25519PrivateKeyBase64, 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, message, key).toString('base64');
}

/**
 * Connect to an Annex server's WebSocket endpoint using mTLS.
 * The client certificate must be the one pinned when the identity paired.
 */
export function connectMtlsWs(host: string, port: number, identity: TestIdentity, query = ''): WebSocket {
  return new WebSocket(`wss://${host}:${port}/ws${query ? `?${query}` : ''}`, {
    cert: identity.certPem,
    key: identity.keyPem,
    rejectUnauthorized: false,
  });
}
