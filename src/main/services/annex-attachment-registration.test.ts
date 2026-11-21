import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as https from 'https';
import { generateKeyPairSync, createHash } from 'crypto';
import forge from 'node-forge';
import type { AgentRuntime } from '../../shared/chat';
import type { AnnexPeer, DurableAgentConfig, Project } from '../../shared/types';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', async (original) => {
  const electron = await original<typeof import('electron')>();
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'annex-upload-registration-'));
  return { ...electron, app: { ...electron.app, getPath: (name: string) => path.join(fixture.root, name) } };
});
vi.mock('bonjour-service', () => ({
  default: class {
    publish() { return { stop() {}, on() {} }; }
    destroy() {}
  },
}));
vi.mock('./annex-network-profile', async (original) => ({
  ...await original<typeof import('./annex-network-profile')>(),
  annexNetworkProfile: () => ({ host: '127.0.0.1', advertise: false }),
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./agent-system', () => ({
  resolveOrchestrator: vi.fn(),
  getAvailableOrchestrators: vi.fn(() => []),
  isHeadlessAgent: vi.fn(() => false),
  spawnAgent: vi.fn(),
  killAgent: vi.fn(),
  waitForAgentStopped: vi.fn(async () => true),
}));

import { app } from 'electron';
import * as agentConfig from './agent-config';
import * as annexServer from './annex-server';
import * as annexIdentity from './annex-identity';
import * as annexPeers from './annex-peers';
import * as annexTls from './annex-tls';
import * as projectStore from './project-store';
import { getBaseDirPath } from './base-dir';
import { registerChatRuntime, clearChatRuntimes } from './agent-runtime';
import { clearStagedAttachments, resolveAttachments } from './agent-runtime/chat-attachments';

const agent: DurableAgentConfig = {
  id: 'durable_upload_registration', name: 'upload target', color: 'indigo',
  createdAt: '2026-11-20T00:00:00.000Z', sandbox: 'read-only', approvalPolicy: 'untrusted',
};
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
const route = `/api/v1/mobile/agents/${agent.id}/attachments`;
let project: Project;
let primary: string;
let credentials: { cert: string; key: string };
let peer: AnnexPeer;
let running: boolean;
let runtime: AgentRuntime;

function clientCredentials() {
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const fingerprint = annexIdentity.computeFingerprint(publicKey);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = annexTls.randomCertificateSerial();
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
  certificate.setSubject([{ name: 'commonName', value: fingerprint }]);
  certificate.setIssuer(certificate.subject.attributes);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const cert = forge.pki.certificateToPem(certificate);
  return { credentials: { cert, key: forge.pki.privateKeyToPem(keys.privateKey) }, publicKey, fingerprint };
}

function upload() {
  const certificate = annexTls.getOrCreateCert(annexIdentity.getOrCreateIdentity());
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const request = https.request({
      host: '127.0.0.1', port: annexServer.getStatus().port, path: route, method: 'POST',
      ...credentials, ca: certificate.certPem, rejectUnauthorized: true, agent: false,
      checkServerIdentity: (_hostname, actual) => annexTls.sameCertificateFingerprint(
        actual.fingerprint256, annexTls.certificateFingerprint(certificate.certPem),
      ) ? undefined : new Error('Fixture server certificate changed'),
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.end(png);
  });
}

async function expectUploaded() {
  const result = await upload();
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result).toMatchObject({ status: 200, body: { version: 1, bytes: png.length, mimeType: 'image/png', width: 3, height: 2 } });
  expect(typeof result.body.attachmentId).toBe('string');
  const content = await resolveAttachments(agent.id, [String(result.body.attachmentId)], { images: true });
  expect(content[0].type).toBe('image');
  if (content[0].type !== 'image') throw new Error('Expected the staged PNG');
  expect(createHash('sha256').update(await fsp.readFile(content[0].path)).digest('hex'))
    .toBe(createHash('sha256').update(png).digest('hex'));
}

beforeAll(async () => {
  const client = clientCredentials();
  credentials = client.credentials;
  peer = {
    fingerprint: client.fingerprint, publicKey: client.publicKey,
    tlsCertificateFingerprint: annexTls.certificateFingerprint(credentials.cert),
    alias: 'fixture controller', icon: 'computer', color: 'indigo', role: 'controller',
    pairedAt: '2026-11-20T00:00:00.000Z', lastSeen: '2026-11-20T00:00:00.000Z',
  };
  project = { id: 'upload-project', name: 'upload project', path: path.join(fixture.root, 'project') };
  primary = path.join(project.path, '.clubhouse', 'agents.json');
  await fsp.mkdir(path.dirname(primary), { recursive: true });
  await fsp.mkdir(app.getPath('userData'), { recursive: true });
  await fsp.mkdir(getBaseDirPath(), { recursive: true });
});

beforeEach(async () => {
  agentConfig.clearAgentConfigCache();
  await agentConfig.settleAgentsFileChecksForTests();
  await fsp.writeFile(primary, JSON.stringify([agent]));
  await fsp.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [project] }));
  annexPeers.addPeer(peer);
  await agentConfig.initializeDurableProject(project.path);
  await agentConfig.flushAgentConfig(project.path);
  await agentConfig.settleAgentsFileChecksForTests();
  running = true;
  runtime = {
    kind: 'chat', agentId: agent.id, isRunning: () => running, getState: () => 'idle',
    getSessionId: () => 'fixture-session', getNativeSessionId: () => undefined,
    getCapabilities: () => ({ images: true }),
    sendMessage: vi.fn(async () => ({ delivery: 'prompt' as const })),
    interrupt: async () => {}, stop: async () => {}, clearContext: async () => {}, compact: async () => {},
    respondPermission: async () => {}, answerQuestion: async () => {},
    readTranscript: async () => ({ kind: 'chat', events: [] }),
    onStateChange: () => () => {}, onExit: () => () => {},
  };
  registerChatRuntime(runtime);
  annexServer.start();
  await vi.waitFor(() => expect(annexServer.getStatus().port).toBeGreaterThan(0));
  expect(await projectStore.list()).toEqual([project]);
});

afterEach(async () => {
  annexServer.stop();
  clearChatRuntimes();
  clearStagedAttachments();
  agentConfig.clearAgentConfigCache();
  await agentConfig.settleAgentsFileChecksForTests();
});

afterAll(async () => {
  annexIdentity.resetForTests();
  annexTls.resetForTests();
  annexPeers.resetForTests();
  await fsp.rm(fixture.root, { recursive: true, force: true });
});

describe('authoritative attachment registration (#3715), direct pinned HTTPS only', () => {
  it('uploads exact bytes from an initialized but cold durable cache without warming it', async () => {
    agentConfig.clearAgentConfigCache(project.path);
    expect(agentConfig.peekCachedDurableConfig(project.path, agent.id)).toBeNull();
    await expectUploaded();
    expect(agentConfig.peekCachedDurableConfig(project.path, agent.id)).toBeNull();
  });

  it('keeps an unchanged registration usable after a real benign watcher eviction', async () => {
    // Explicit initialization is a control, not a request-side cache warm.
    await agentConfig.initializeDurableProject(project.path);
    expect(agentConfig.peekCachedDurableConfig(project.path, agent.id)).not.toBeNull();
    await expectUploaded();
    const before = JSON.parse(await fsp.readFile(primary, 'utf8'));
    await fsp.appendFile(primary, '\n');
    await vi.waitFor(() => expect(agentConfig.peekCachedDurableConfig(project.path, agent.id)).toBeNull());
    expect(JSON.parse(await fsp.readFile(primary, 'utf8'))).toEqual(before);
    await expectUploaded();
    expect(agentConfig.peekCachedDurableConfig(project.path, agent.id)).toBeNull();
  });
});
