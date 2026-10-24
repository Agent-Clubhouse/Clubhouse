import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { app } from 'electron';
import { X509Certificate } from 'crypto';
import { annexEphemeralSession, annexNetworkProfile } from './annex-network-profile';
import * as identity from './annex-identity';
import * as tls from './annex-tls';
import * as peers from './annex-peers';
import type { AnnexPeer } from '../../shared/types';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const denied = () => { throw new Error('Credential filesystem access forbidden'); };
  return { ...actual, readFileSync: vi.fn(denied), writeFileSync: vi.fn(denied),
    chmodSync: vi.fn(denied), unlinkSync: vi.fn(denied), existsSync: vi.fn(denied), copyFileSync: vi.fn(denied) };
});
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => { throw new Error('Profile lookup forbidden'); }) } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('../telemetry/annex-telemetry', () => ({ recordIdentityRegenerated: vi.fn() }));

describe('memory-only Annex credentials', () => {
  beforeEach(() => {
    vi.stubEnv('CLUBHOUSE_ANNEX_EPHEMERAL', '1');
    vi.stubEnv('CLUBHOUSE_ANNEX_LOOPBACK_ONLY', '1');
    vi.stubEnv('CLUBHOUSE_USER_DATA', '/isolated-test-profile');
    identity.resetForTests(); tls.resetForTests(); peers.resetForTests();
    vi.clearAllMocks();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('requires explicit loopback and isolated profile, preserving defaults', () => {
    expect(annexEphemeralSession({})).toBe(false);
    expect(() => annexEphemeralSession({ CLUBHOUSE_ANNEX_EPHEMERAL: '1' })).toThrow(/loopback/);
    expect(() => annexNetworkProfile({ CLUBHOUSE_ANNEX_EPHEMERAL: '1', CLUBHOUSE_ANNEX_LOOPBACK_ONLY: '1' })).toThrow(/isolated/);
    expect(annexNetworkProfile()).toEqual({ host: '127.0.0.1', advertise: false });
  });

  it('generates, caches, revokes and resets identities, TLS keys and peers without any filesystem access', () => {
    expect(identity.getIdentity()).toBeNull();
    const first = identity.getOrCreateIdentity();
    expect(identity.getOrCreateIdentity()).toBe(first);
    expect(identity.getPublicIdentity()?.fingerprint).toBe(first.fingerprint);
    const cert = tls.getOrCreateCert(first);
    expect(tls.getOrCreateCert(first)).toBe(cert);
    expect(new X509Certificate(cert.certPem).subject).toBe(`CN=${first.fingerprint}`);
    expect(tls.createTlsServerOptions(first).key).toBe(cert.keyPem);
    expect(peers.listPeers()).toEqual([]);
    const peer = { fingerprint: 'test-peer', alias: 'Fixture', publicKey: 'test', pairedAt: new Date().toISOString() } as AnnexPeer;
    peers.addPeer(peer); peers.updateLastSeen(peer.fingerprint);
    expect(peers.isPairedPeer(peer.fingerprint)).toBe(true);
    expect(peers.removePeer(peer.fingerprint)).toBe(true);
    peers.addPeer(peer); peers.removeAllPeers();
    expect(peers.listPeers()).toEqual([]);
    tls.deleteCert(); identity.deleteIdentity();
    expect(identity.getIdentity()).toBeNull();
    expect(identity.getOrCreateIdentity().publicKey).not.toBe(first.publicKey);
    for (const operation of [fs.readFileSync, fs.writeFileSync, fs.chmodSync, fs.unlinkSync, fs.existsSync, fs.copyFileSync, app.getPath]) {
      expect(operation).not.toHaveBeenCalled();
    }
  });
});
