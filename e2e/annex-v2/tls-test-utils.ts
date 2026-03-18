/**
 * mTLS Identity Generator for Annex V2 E2E Tests
 *
 * Generates Ed25519 identity keypairs and ECDSA P-256 self-signed X.509
 * certificates for mutual TLS authentication in tests. The ASN.1/DER helpers
 * are lifted verbatim from src/main/services/annex-tls.ts (lines 148-215)
 * which have zero Electron dependencies.
 */
import * as crypto from 'crypto';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestIdentity {
  /** Base64-encoded Ed25519 public key (DER/SPKI) — for POST /pair { publicKey } */
  ed25519PublicKeyBase64: string;
  /** Colon-hex SHA-256 fingerprint (first 16 bytes), becomes the X.509 CN */
  fingerprint: string;
  /** PEM-encoded self-signed ECDSA P-256 X.509 certificate */
  certPem: string;
  /** PEM-encoded ECDSA P-256 private key */
  keyPem: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CERT_VALIDITY_DAYS = 3650;

// ---------------------------------------------------------------------------
// ASN.1 DER encoding helpers (verbatim from annex-tls.ts:148-215)
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
  if (value[0] & 0x80) {
    value = Buffer.concat([Buffer.from([0x00]), value]);
  }
  return asn1Wrap(0x02, value);
}

function asn1BitString(content: Buffer): Buffer {
  return asn1Wrap(0x03, Buffer.concat([Buffer.from([0x00]), content]));
}

function asn1Utf8String(content: Buffer): Buffer {
  return asn1Wrap(0x0c, content);
}

function asn1Oid(components: number[]): Buffer {
  const bytes: number[] = [];
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
// X.509 certificate generation (from annex-tls.ts:81-142)
// ---------------------------------------------------------------------------

function generateX509(
  publicKey: crypto.KeyObject,
  privateKey: crypto.KeyObject,
  cn: string,
): string {
  const cnUtf8 = Buffer.from(cn, 'utf-8');
  const cnAttr = asn1Sequence([
    asn1Set([
      asn1Sequence([
        asn1Oid([2, 5, 4, 3]),
        asn1Utf8String(cnUtf8),
      ]),
    ]),
  ]);

  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;

  const notBefore = new Date();
  const notAfter = new Date();
  notAfter.setDate(notAfter.getDate() + CERT_VALIDITY_DAYS);

  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  const tbs = asn1Sequence([
    asn1Explicit(0, asn1Integer(Buffer.from([0x02]))),
    asn1Integer(serial),
    asn1Sequence([asn1Oid([1, 2, 840, 10045, 4, 3, 2])]),
    cnAttr,
    asn1Sequence([
      asn1UtcTime(notBefore),
      asn1UtcTime(notAfter),
    ]),
    cnAttr,
    Buffer.from(spkiDer),
  ]);

  const signer = crypto.createSign('SHA256');
  signer.update(tbs);
  const signature = signer.sign(privateKey);

  const cert = asn1Sequence([
    tbs,
    asn1Sequence([asn1Oid([1, 2, 840, 10045, 4, 3, 2])]),
    asn1BitString(signature),
  ]);

  const base64 = cert.toString('base64');
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

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
 * ECDSA P-256 self-signed X.509 cert (for mTLS).
 */
export function generateTestIdentity(): TestIdentity {
  // 1. Ed25519 keypair for identity/pairing
  const ed25519 = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const ed25519PublicKeyBase64 = (ed25519.publicKey as Buffer).toString('base64');
  const fingerprint = computeFingerprint(ed25519PublicKeyBase64);

  // 2. ECDSA P-256 keypair for TLS certificate
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });

  // 3. Self-signed X.509 cert with CN=fingerprint
  const certPem = generateX509(publicKey, privateKey, fingerprint);
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  // 4. Self-test: verify the cert is parseable and has the right CN
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
