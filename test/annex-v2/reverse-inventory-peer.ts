import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { afterAll, vi } from 'vitest';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { installDialPolicy, type DialPolicy } from './reverse-parity-fixture';
import type { ConfigurePeer, PeerInfo } from './reverse-client-peer';

const fixture = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annex-inventory-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return { dir, events: [] as Array<{ channel: string; payload: unknown }>, logs: [] as unknown[] };
});

vi.mock('electron', () => ({
  app: { getPath: () => fixture.dir, isPackaged: false, getVersion: () => '0.0.0-parity', getName: () => 'annex-parity', on() {} },
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle() {}, on() {} },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  shell: {}, dialog: {}, Notification: class {},
}));
vi.mock('../../src/main/services/log-service', () => ({
  appLog: (...args: unknown[]) => { fixture.logs.push(args); },
}));
vi.mock('../../src/main/util/ipc-broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { fixture.events.push({ channel, payload }); },
}));
vi.mock('../../src/main/services/annex-network-profile', async (original) => ({
  ...await original<typeof import('../../src/main/services/annex-network-profile')>(),
  annexNetworkProfile: () => ({ host: '127.0.0.1', advertise: false }),
}));
vi.mock('../../src/main/services/annex-network-channel', async (original) => ({
  ...await original<typeof import('../../src/main/services/annex-network-channel')>(),
  connectTo() {},
}));
vi.mock('../../src/main/services/agent-system', async (original) => ({
  ...await original<typeof import('../../src/main/services/agent-system')>(),
  spawnAgent: async () => { throw new Error('Unexpected provider start: P8 uses only the in-memory fake driver'); },
}));

import * as server from '../../src/main/services/annex-server';
import * as client from '../../src/main/services/annex-client';
import * as control from '../../src/main/services/annex-control';
import * as identity from '../../src/main/services/annex-identity';
import * as annexTls from '../../src/main/services/annex-tls';
import * as peers from '../../src/main/services/annex-peers';
import * as settings from '../../src/main/services/annex-settings';
import * as projectStore from '../../src/main/services/project-store';
import * as agentConfig from '../../src/main/services/agent-config';
import { agentRegistry } from '../../src/main/services/agent-registry';
import { ChatAgentRuntime, clearChatRuntimes, registerChatRuntime } from '../../src/main/services/agent-runtime';
import { FakeChatDriver } from '../../src/main/services/agent-runtime/fake-chat-driver';
import { MINIMAL_CHAT_CAPABILITIES, type ChatEventDraft } from '../../src/shared/chat';
import type { ControlRequestInput } from '../../src/main/services/annex-control';

export interface InventoryPeerInfo extends PeerInfo {
  projectId: string;
  agentId: string;
  sessionId: string;
}

export interface WireAnswer {
  status: number;
  headers: import('http').IncomingHttpHeaders;
  body: string;
  bytes: number;
  digest: string;
}

export const LARGE_DIFF_BYTES = 8 * 1024 * 1024 + 128 * 1024;

afterAll(() => { fs.rmSync(fixture.dir, { recursive: true, force: true }); });

/** Real server route table, stores, client and control; no Electron or provider process. */
export async function createInventoryPeer(alias: string) {
  await settings.saveSettings({
    ...settings.getSettings(), enableServer: true, enableClient: true, networkEnabled: true,
    loopbackOnly: true, alias, deviceName: alias, autoReconnect: true,
  });
  const root = path.join(fixture.dir, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'fixture.txt'), `file:${alias}:é\n`);
  const project = await projectStore.add(root);
  const agent = await agentConfig.createDurable(root, `${alias} agent`, 'blue', undefined, false, 'claude-code');
  const driver = new FakeChatDriver('claude_stream_json', 'claude-code', {
    ...MINIMAL_CHAT_CAPABILITIES, steer: true, interrupt: true, images: true, questions: true,
    modelSwitch: 'live', effortSwitch: 'live', liveLevels: ['ask', 'auto_edit'],
  });
  const runtime = new ChatAgentRuntime({
    agentId: agent.id, provider: driver.provider, driverId: driver.id, cwd: root, level: 'ask', idleTimeoutMs: 0,
    startSession: (resumeNativeSessionId) => driver.start({
      agentId: agent.id, provider: driver.provider, cwd: root, binaryPath: 'in-memory-only', level: 'ask', resumeNativeSessionId,
    }),
  });
  agentRegistry.register(agent.id, { projectPath: root, cwd: root, orchestrator: 'claude-code', runtime: 'chat' });
  registerChatRuntime(runtime);
  await runtime.start();
  await server.startVerified();
  const self = identity.getOrCreateIdentity();
  const cert = annexTls.getOrCreateCert(self);
  const info: InventoryPeerInfo = {
    alias, fingerprint: self.fingerprint, publicKey: self.publicKey, certPem: cert.certPem,
    pin: annexTls.certificateFingerprint(cert.certPem), port: server.getStatus().port!,
    projectId: project.id, agentId: agent.id, sessionId: runtime.getSessionId(),
  };
  let remote: InventoryPeerInfo | undefined;
  let policy: DialPolicy | undefined;
  let routePort = 0;
  return {
    info,
    async configure(config: Omit<ConfigurePeer, 'peer'> & { peer: InventoryPeerInfo }) {
      remote = config.peer;
      routePort = config.routePort;
      peers.addPeer({
        fingerprint: remote.fingerprint, publicKey: remote.publicKey, alias: remote.alias, icon: 'computer', color: 'indigo',
        pairedAt: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z', role: 'member', kind: 'desktop',
        tlsCertificateFingerprint: remote.pin, tlsCertificatePem: remote.certPem,
        knownHosts: ['127.0.0.1'], hostPorts: { '127.0.0.1': routePort }, mainPort: routePort,
      });
      policy = installDialPolicy((host, port) => config.forwardPort !== null && host === '127.0.0.1' && port === config.forwardPort);
      client.startClient();
    },
    status() {
      return {
        readiness: remote && control.getLinkReadiness(remote.fingerprint),
        connected: remote && client.isMachineConnected(remote.fingerprint),
        direct: remote && client.isMachineDirectConnected(remote.fingerprint),
        snapshot: remote && client.getSatellite(remote.fingerprint)?.snapshot,
        attempts: policy?.attempts ?? [], events: fixture.events, logs: fixture.logs,
      };
    },
    /** Server-only routes have no desktop wrapper. Test their actual wire endpoint explicitly. */
    async wire(input: ControlRequestInput): Promise<WireAnswer> {
      if (!remote) throw new Error('Inventory peer is not configured');
      const answer = client.isMachineDirectConnected(remote.fingerprint)
        ? await new Promise<{ status: number; headers: import('http').IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
          const req = https.request(`https://127.0.0.1:${routePort}${input.path}`, {
            ...annexTls.createPinnedTlsClientOptions(self, { certPem: remote!.certPem, fingerprint: remote!.pin }),
            method: input.method, headers: input.headers, timeout: 10_000,
          }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(new Error('Inventory direct request timed out')); });
          req.end(input.body);
        })
        : await control.request(remote.fingerprint, input);
      return {
        status: answer.status, headers: answer.headers, body: answer.body.toString('base64'),
        bytes: answer.body.length, digest: createHash('sha256').update(answer.body).digest('hex'),
      };
    },
    async probe(family: 'history' | 'file' | 'tree' | 'chat send') {
      if (!remote) throw new Error('Inventory peer is not configured');
      if (family === 'history') return client.requestChatPage(remote.fingerprint, remote.agentId);
      if (family === 'file') return client.requestFileRead(remote.fingerprint, remote.projectId, 'fixture.txt');
      if (family === 'tree') return client.requestFileTree(remote.fingerprint, remote.projectId);
      return client.sendChatCommand(remote.fingerprint, { type: 'chat.send', agentId: remote.agentId, sessionId: remote.sessionId, text: `fixture:${alias}` });
    },
    seedLargeDiff() {
      execFileSync('git', ['init', '--quiet'], { cwd: root });
      execFileSync('git', ['add', '--', 'fixture.txt'], { cwd: root });
      execFileSync('git', ['-c', 'user.name=Parity Fixture', '-c', 'user.email=parity@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'fixture baseline'], { cwd: root });
      fs.writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(LARGE_DIFF_BYTES, 'x'));
    },
    async gitDiff() {
      if (!remote) throw new Error('Inventory peer is not configured');
      const result = await client.requestGitOperation(remote.fingerprint, remote.projectId, { operation: 'diff', file: 'large.txt' }) as { original: string; modified: string };
      return {
        originalBytes: Buffer.byteLength(result.original), modifiedBytes: Buffer.byteLength(result.modified),
        digest: createHash('sha256').update(result.modified).digest('hex'),
      };
    },
    emit(draft: ChatEventDraft) { driver.last.emit(draft); },
    driverState() {
      return { sent: driver.last.sent, permissions: driver.last.responses, answers: driver.last.answers, models: driver.last.models, levels: driver.last.levels, interrupts: driver.last.interrupts };
    },
    async close() {
      client.stopClient();
      await runtime.stop();
      clearChatRuntimes();
      server.stop();
      control.resetControlForTests();
      await agentConfig.flushAllAgentConfigs();
      policy?.restore();
    },
  };
}

export type InventoryPeer = Awaited<ReturnType<typeof createInventoryPeer>>;
