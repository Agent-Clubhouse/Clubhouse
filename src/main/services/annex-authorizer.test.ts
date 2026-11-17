/**
 * The shared refusal matrix (#3613 P1): every peer class, authorized as a
 * direct and as a reverse caller by the one authorizer. Reverse adds a
 * restriction and never grants what direct refuses.
 */
import { describe, expect, it, vi } from 'vitest';
import * as tls from 'tls';
import type { AddressInfo } from 'net';
import forge from 'node-forge';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/annex-authorizer-test' } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { authorize, authorizeControlLink, reauthorize, stillAuthorized, type AnnexAuthorizerDeps, type AnnexVia } from './annex-authorizer';
import type { AnnexPeer } from '../../shared/types';

const PIN = 'AB:CD:EF:01';
const FP = 'c0:c0:c0:c0';

function peer(overrides: Partial<AnnexPeer> = {}): AnnexPeer {
  return {
    fingerprint: FP, publicKey: 'pk', alias: 'Studio', icon: 'computer', color: 'indigo',
    pairedAt: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z',
    role: 'member', kind: 'desktop', tlsCertificateFingerprint: PIN, ...overrides,
  };
}

interface World { peer?: AnnexPeer; sessionOnly?: boolean; networkEnabled?: boolean }

function deps(world: World): AnnexAuthorizerDeps {
  return {
    findPeer: (fp) => (world.peer?.fingerprint === fp ? world.peer : undefined),
    isSessionOnly: (fp) => !!world.sessionOnly && world.peer?.fingerprint === fp,
    networkEnabled: () => world.networkEnabled !== false,
  };
}

type Outcome = 'allow' | [401 | 403, string];

interface Row {
  name: string;
  world: World;
  /** The certificate the caller presents. */
  pin?: string;
  fingerprint?: string;
  direct: Outcome;
  reverse: Outcome;
}

const ROLE_REFUSED: Outcome = [403, 'peer_role_not_allowed'];

const MATRIX: Row[] = [
  { name: 'active desktop member', world: { peer: peer() }, direct: 'allow', reverse: 'allow' },
  { name: 'no identity', fingerprint: '', world: { peer: peer() }, direct: [401, 'unauthorized'], reverse: [401, 'unauthorized'] },
  { name: 'unknown peer', world: {}, direct: [401, 'peer_not_paired'], reverse: [401, 'peer_not_paired'] },
  { name: 'removed peer', world: { peer: undefined }, direct: [401, 'peer_not_paired'], reverse: [401, 'peer_not_paired'] },
  { name: 'older pairing with no role', world: { peer: peer({ role: undefined }) }, direct: [401, 'needs_pairing'], reverse: [401, 'needs_pairing'] },
  { name: 'older pairing with no pin', world: { peer: peer({ tlsCertificateFingerprint: undefined }) }, direct: [401, 'needs_pairing'], reverse: [401, 'needs_pairing'] },
  { name: 'pin mismatch', pin: 'AB:CD:EF:02', world: { peer: peer() }, direct: [401, 'peer_not_paired'], reverse: [401, 'peer_not_paired'] },
  { name: 'no certificate presented', pin: '', world: { peer: peer() }, direct: [401, 'peer_not_paired'], reverse: [401, 'peer_not_paired'] },
  { name: 'pending member (networkPending)', world: { peer: peer({ networkPending: true }) }, direct: ROLE_REFUSED, reverse: ROLE_REFUSED },
  { name: 'one-to-one satellite (this machine controls it)', world: { peer: peer({ role: 'satellite', kind: undefined }) }, direct: ROLE_REFUSED, reverse: ROLE_REFUSED },
  { name: 'one-to-one controller (it controls this machine)', world: { peer: peer({ role: 'controller', kind: undefined }) }, direct: 'allow', reverse: ROLE_REFUSED },
  { name: 'phone network member', world: { peer: peer({ kind: 'phone' }) }, direct: 'allow', reverse: ROLE_REFUSED },
  { name: 'member with no kind (fails closed)', world: { peer: peer({ kind: undefined }) }, direct: 'allow', reverse: ROLE_REFUSED },
  { name: 'session-only phone', world: { peer: peer({ role: 'controller', kind: undefined }), sessionOnly: true }, direct: 'allow', reverse: ROLE_REFUSED },
  { name: 'session-only entry claiming desktop membership', world: { peer: peer(), sessionOnly: true }, direct: 'allow', reverse: ROLE_REFUSED },
  { name: 'desktop member with Annex Network off', world: { peer: peer(), networkEnabled: false }, direct: 'allow', reverse: ROLE_REFUSED },
];

function run(row: Row, via: AnnexVia) {
  return authorize({ fingerprint: row.fingerprint ?? FP, pin: row.pin ?? PIN, via }, deps(row.world));
}

describe('annex authorizer refusal matrix', () => {
  for (const via of ['direct', 'reverse'] as const) {
    describe(via, () => {
      for (const row of MATRIX) {
        const expected = row[via];
        it(`${row.name}: ${expected === 'allow' ? 'allowed' : `${expected[0]} ${expected[1]}`}`, () => {
          const result = run(row, via);
          if (expected === 'allow') {
            expect(result).toMatchObject({ ok: true, fingerprint: FP, principal: { fingerprint: FP, pin: PIN, role: row.world.peer!.role, via } });
          } else {
            expect(result).toMatchObject({ ok: false, status: expected[0], error: expected[1] });
          }
        });
      }
    });
  }

  it('reverse never allows what direct refuses, and refuses with the same answer where direct refuses', () => {
    for (const row of MATRIX) {
      const direct = run(row, 'direct');
      const reverse = run(row, 'reverse');
      if (reverse.ok) expect(direct.ok, row.name).toBe(true);
      if (!direct.ok) expect(reverse, row.name).toEqual(direct);
    }
  });

  it('reverse is denied for every class except an active desktop member', () => {
    const allowed = MATRIX.filter((row) => run(row, 'reverse').ok).map((row) => row.name);
    expect(allowed).toEqual(['active desktop member']);
  });

  it('keeps the direct refusal order: unknown, role missing, role, pin missing, pin', () => {
    // A peer failing several checks gets the first one's answer, as before #3613.
    const many = peer({ role: 'satellite', tlsCertificateFingerprint: undefined });
    expect(authorize({ fingerprint: FP, pin: 'other', via: 'direct' }, deps({ peer: many }))).toMatchObject({ status: 403, error: 'peer_role_not_allowed' });
    const noRoleNoPin = peer({ role: undefined, tlsCertificateFingerprint: undefined });
    expect(authorize({ fingerprint: FP, pin: 'other', via: 'direct' }, deps({ peer: noRoleNoPin }))).toMatchObject({ status: 401, error: 'needs_pairing' });
    const pendingWrongPin = peer({ networkPending: true });
    expect(authorize({ fingerprint: FP, pin: 'other', via: 'direct' }, deps({ peer: pendingWrongPin }))).toMatchObject({ status: 403, error: 'peer_role_not_allowed' });
  });

  it('refusals carry the same messages as before', () => {
    expect(authorize({ fingerprint: FP, pin: PIN, via: 'direct' }, deps({}))).toEqual({
      ok: false, status: 401, error: 'peer_not_paired', fingerprint: FP,
      message: 'This device is not paired with this computer. Pair it again.',
    });
    expect(authorize({ fingerprint: FP, pin: PIN, via: 'direct' }, deps({ peer: peer({ role: 'satellite' }) }))).toMatchObject({
      message: 'This computer is paired to be controlled from here, not to control it.',
    });
  });
});

describe('control connection eligibility (#3613 P3)', () => {
  it('accepts a control connection exactly where a reverse request would be allowed, with the same refusal otherwise', () => {
    for (const row of MATRIX) {
      const link = authorizeControlLink({ fingerprint: row.fingerprint ?? FP, pin: row.pin ?? PIN, via: 'direct' }, deps(row.world));
      const reverse = run(row, 'reverse');
      expect(link.ok, row.name).toBe(reverse.ok);
      if (!reverse.ok) expect(link, row.name).toEqual(reverse);
      // Whatever the caller claims, the connection is authorized as the direct connection it is.
      if (link.ok) expect(link.principal.via, row.name).toBe('direct');
    }
  });

  it('ignores a caller claiming reverse', () => {
    const result = authorizeControlLink({ fingerprint: FP, pin: PIN, via: 'reverse' }, deps({ peer: peer() }));
    expect(result).toMatchObject({ ok: true, principal: { via: 'direct' } });
  });
});

describe('annex authorizer mid-session revocation', () => {
  const changes: Array<[string, (world: World) => void]> = [
    ['removed', (w) => { w.peer = undefined; }],
    ['re-pinned', (w) => { w.peer = peer({ tlsCertificateFingerprint: 'AB:CD:EF:02' }); }],
    ['made pending', (w) => { w.peer = peer({ networkPending: true }); }],
    ['re-paired as a satellite', (w) => { w.peer = peer({ role: 'satellite' }); }],
    ['lost its role', (w) => { w.peer = peer({ role: undefined }); }],
  ];

  for (const via of ['direct', 'reverse'] as const) {
    for (const [name, change] of changes) {
      it(`${via}: a principal ${name} after authorization is refused on its next request`, () => {
        const world: World = { peer: peer() };
        const first = authorize({ fingerprint: FP, pin: PIN, via }, deps(world));
        if (!first.ok) throw new Error('expected the first request to be allowed');
        expect(stillAuthorized(first.principal, deps(world))).toBe(true);
        change(world);
        expect(stillAuthorized(first.principal, deps(world))).toBe(false);
        expect(reauthorize(first.principal, deps(world)).ok).toBe(false);
      });
    }
  }

  it('reverse: a member that becomes a phone, session-only, or whose network is turned off is refused next', () => {
    for (const change of [
      (w: World) => { w.peer = peer({ kind: 'phone' }); },
      (w: World) => { w.sessionOnly = true; },
      (w: World) => { w.networkEnabled = false; },
    ]) {
      const world: World = { peer: peer() };
      const first = authorize({ fingerprint: FP, pin: PIN, via: 'reverse' }, deps(world));
      if (!first.ok) throw new Error('expected the first request to be allowed');
      change(world);
      expect(stillAuthorized(first.principal, deps(world))).toBe(false);
    }
  });

  it('a principal keeps its direction: a reverse principal is never rechecked as direct', () => {
    const world: World = { peer: peer() };
    const first = authorize({ fingerprint: FP, pin: PIN, via: 'reverse' }, deps(world));
    if (!first.ok) throw new Error('expected the first request to be allowed');
    world.networkEnabled = false;
    // As direct it would still pass; the recheck keeps `reverse`, so it doesn't.
    expect(authorize({ fingerprint: FP, pin: PIN, via: 'direct' }, deps(world)).ok).toBe(true);
    expect(reauthorize(first.principal, deps(world))).toMatchObject({ ok: false, error: 'peer_role_not_allowed' });
  });

  it('no principal is never authorized', () => {
    expect(stillAuthorized(undefined, deps({ peer: peer() }))).toBe(false);
  });
});

/**
 * Evidence about the direct transport, kept apart from the policy above: which
 * TLS versions a server built like `createTlsServerOptions` (no min or max
 * version set) negotiates. It says nothing about whether a client can switch
 * certificates by renegotiating; that is not established here.
 */
describe('annex direct transport: negotiated TLS protocol', () => {
  async function negotiate(clientMax?: tls.SecureVersion): Promise<string | null> {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + 86_400_000);
    cert.setSubject([{ name: 'commonName', value: 'annex-authorizer-test' }]);
    cert.setIssuer(cert.subject.attributes);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const credentials = { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
    // The same shape as annex-tls's createTlsServerOptions.
    const server = tls.createServer({ ...credentials, requestCert: true, rejectUnauthorized: false }, (socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      return await new Promise<string | null>((resolve, reject) => {
        const socket = tls.connect({ host: '127.0.0.1', port, ...credentials, rejectUnauthorized: false, ...(clientMax && { maxVersion: clientMax }) }, () => {
          resolve(socket.getProtocol());
          socket.destroy();
        });
        socket.on('error', reject);
      });
    } finally {
      server.close();
    }
  }

  it('negotiates TLS 1.3 by default, and still accepts a client that offers only TLS 1.2', async () => {
    expect(await negotiate()).toBe('TLSv1.3');
    expect(await negotiate('TLSv1.2')).toBe('TLSv1.2');
  }, 30_000);
});
