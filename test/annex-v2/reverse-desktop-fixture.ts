import * as net from 'net';
import { vi } from 'vitest';
import type { AnnexPeer } from '../../src/shared/types';
import type { AnnexAuthorizerDeps } from '../../src/main/services/annex-authorizer';

export async function desktop(dir: string) {
  vi.resetModules();
  vi.doMock('electron', () => ({
    app: { getPath: () => dir, isPackaged: false, getVersion: () => '0.0.0-fixture', getName: () => 'reverse-consumer-fixture', on: () => {} },
    BrowserWindow: { getAllWindows: (): [] => [] },
    safeStorage: { isEncryptionAvailable: () => false },
    ipcMain: { handle: () => {}, on: () => {} },
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
    shell: {}, dialog: {}, Notification: class {},
  }));
  vi.doMock('../../src/main/services/log-service', () => ({ appLog: vi.fn() }));
  const events: Array<{ channel: string; payload: unknown }> = [];
  vi.doMock('../../src/main/util/ipc-broadcast', () => ({
    broadcastToAllWindows: (channel: string, payload: unknown) => { events.push({ channel, payload }); },
  }));
  vi.doMock('../../src/main/services/annex-settings', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/main/services/annex-settings')>();
    return { ...actual, getSettings: () => ({
      ...actual.getSettings(), enableClient: true, enableServer: true,
      networkEnabled: true, autoReconnect: false, loopbackOnly: true,
    }) };
  });
  const identity = await import('../../src/main/services/annex-identity');
  const tls = await import('../../src/main/services/annex-tls');
  const peers = await import('../../src/main/services/annex-peers');
  const control = await import('../../src/main/services/annex-control');
  const auth = await import('../../src/main/services/annex-authorizer');
  const client = await import('../../src/main/services/annex-client');
  const headless = await import('../../src/main/services/pty-headless-terminal');
  const info = identity.getOrCreateIdentity();
  const cert = tls.getOrCreateCert(info);
  return { identity, tls, peers, control, auth, client, headless, info, cert, events };
}
export type Desktop = Awaited<ReturnType<typeof desktop>>;

export function pairedPeer(machine: Desktop): AnnexPeer {
  return {
    fingerprint: machine.info.fingerprint, publicKey: machine.info.publicKey,
    alias: 'Fixture desktop', icon: 'computer', color: 'indigo', role: 'member', kind: 'desktop',
    pairedAt: '2026-01-01T00:00:00.000Z', lastSeen: '',
    tlsCertificateFingerprint: machine.tls.certificateFingerprint(machine.cert.certPem),
    tlsCertificatePem: machine.cert.certPem,
  };
}

export function authority(machine: Desktop): AnnexAuthorizerDeps {
  return { findPeer: machine.peers.getPeer, isSessionOnly: () => false, networkEnabled: () => true };
}

export async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a listening TCP address');
  return address.port;
}

export function close(server: net.Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
