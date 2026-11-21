import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as https from 'https';
import { generateKeyPairSync, createHash } from 'crypto';
import forge from 'node-forge';
import { MINIMAL_CHAT_CAPABILITIES, type AgentRuntime } from '../../shared/chat';
import type { AnnexPeer, DurableAgentConfig, Project } from '../../shared/types';

const fixture = vi.hoisted(() => ({
  root: '', attachments: '', bodyEntered: undefined as (() => void) | undefined,
  stage: undefined as 'readdir' | 'realpath' | undefined,
  stageEntered: undefined as (() => void) | undefined,
  stageRelease: undefined as Promise<void> | undefined,
}));
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
vi.mock('fs', async (original) => {
  const actual = await original<typeof import('fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync), fstatSync: vi.fn(actual.fstatSync), openSync: vi.fn(actual.openSync) };
});
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      const result = await actual.readdir(...args);
      if (fixture.stage === 'readdir' && String(args[0]) === fixture.attachments) {
        fixture.stageEntered?.();
        await fixture.stageRelease;
      }
      return result;
    }) as typeof actual.readdir,
    realpath: (async (...args: Parameters<typeof actual.realpath>) => {
      const result = await actual.realpath(...args);
      if (fixture.stage === 'realpath' && String(args[0]).startsWith(`${fixture.attachments}${path.sep}`)) {
        fixture.stageEntered?.();
        await fixture.stageRelease;
      }
      return result;
    }) as typeof actual.realpath,
  };
});
vi.mock('./mobile-attachments', async (original) => {
  const actual = await original<typeof import('./mobile-attachments')>();
  return {
    ...actual,
    readCappedBody: (...args: Parameters<typeof actual.readCappedBody>) => {
      fixture.bodyEntered?.();
      return actual.readCappedBody(...args);
    },
  };
});

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

function upload(holdBody?: (finish: () => void, abort: () => void) => void) {
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
    if (holdBody) {
      request.flushHeaders();
      holdBody(() => request.end(png), () => request.destroy(new Error('Fixture body aborted')));
    }
    else request.end(png);
  });
}

async function savedFiles() {
  try { return (await fsp.readdir(fixture.attachments)).sort(); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function expectUploaded(answer?: Awaited<ReturnType<typeof upload>>) {
  const result = answer ?? await upload();
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result).toMatchObject({ status: 200, body: { version: 1, bytes: png.length, mimeType: 'image/png', width: 3, height: 2 } });
  expect(typeof result.body.attachmentId).toBe('string');
  const content = await resolveAttachments(agent.id, [String(result.body.attachmentId)], { ...MINIMAL_CHAT_CAPABILITIES, images: true });
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
  fixture.attachments = path.join(app.getPath('userData'), 'chat-attachments', agent.id);
  await fsp.mkdir(path.dirname(primary), { recursive: true });
  await fsp.mkdir(app.getPath('userData'), { recursive: true });
  await fsp.mkdir(getBaseDirPath(), { recursive: true });
});

beforeEach(async () => {
  fixture.bodyEntered = undefined;
  fixture.stage = undefined;
  fixture.stageEntered = undefined;
  fixture.stageRelease = undefined;
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
    getCapabilities: () => ({ ...MINIMAL_CHAT_CAPABILITIES, images: true }),
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
  vi.restoreAllMocks();
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

  it('uploads unchanged image bytes from a large, cold primary registration file', async () => {
    const others = Array.from({ length: 400 }, (_, index) => ({ ...agent, id: `durable_other_${index}`, name: `other ${index}` }));
    await fsp.writeFile(primary, JSON.stringify([agent, ...others]));
    agentConfig.clearAgentConfigCache(project.path);
    await expectUploaded();
    expect(agentConfig.peekCachedDurableConfig(project.path, agent.id)).toBeNull();
  });

  it.each(['body', 'staging'] as const)('keeps its registration through a benign atomic rewrite during %s', async (phase) => {
    let entered = false;
    let release = () => {};
    let pending: ReturnType<typeof upload>;
    if (phase === 'body') {
      fixture.bodyEntered = () => { entered = true; };
      pending = upload((finish) => { release = finish; });
    } else {
      fixture.stage = 'readdir';
      fixture.stageEntered = () => { entered = true; };
      fixture.stageRelease = new Promise<void>((resolve) => { release = resolve; });
      pending = upload();
    }
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      fs.writeFileSync(`${primary}.rewrite`, JSON.stringify([{ ...agent, name: 'updated name' }]));
      fs.renameSync(`${primary}.rewrite`, primary);
      release();
      await expectUploaded(await pending);
    } finally { release(); fixture.stage = undefined; }
  });

  it('closes its registration lease after an actual body abort, without stranding later uploads', async () => {
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    const acquired = vi.spyOn(agentConfig, 'readDurableRegistrationLease');
    let opened: fsp.FileHandle | undefined;
    vi.mocked(fsp.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] === primary) opened = handle;
      return handle;
    });
    let entered = false;
    let abort = () => {};
    fixture.bodyEntered = () => { entered = true; };
    const pending = upload((_finish, stop) => { abort = stop; });
    const failed = expect(pending).rejects.toThrow('Fixture body aborted');
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(opened).toBeDefined();
      expect(opened?.fd).toBe(-1);
      const result = acquired.mock.results[0];
      if (result?.type !== 'return') throw new Error('Expected a completed registration read');
      const lease = await result.value;
      if (!lease) throw new Error('Expected an acquired registration lease');
      abort();
      await failed;
      await vi.waitFor(() => expect(lease.isCurrent()).toBe(false));
      await expectUploaded();
    } finally { abort(); }
  });

  const changes = [
    { name: 'removed', status: 404, code: 'agent_not_found', change: () => fs.writeFileSync(primary, '[]') },
    { name: 'disposed', status: 404, code: 'agent_not_found', change: () => fs.writeFileSync(primary, JSON.stringify([{ ...agent, disposedAt: '2026-11-21' }])) },
    { name: 'primary-corrupt', status: 404, code: 'agent_not_found', change: () => fs.writeFileSync(primary, '{corrupt primary') },
    {
      name: 'primary-unreadable', status: 404, code: 'agent_not_found',
      change: () => { vi.mocked(fs.openSync).mockImplementationOnce(() => { throw Object.assign(new Error('Fixture primary unreadable'), { code: 'EACCES' }); }); },
    },
    {
      name: 'delete-recreate with a new registration epoch', status: 404, code: 'agent_not_found',
      change: () => { fs.unlinkSync(primary); fs.writeFileSync(primary, JSON.stringify([{ ...agent, createdAt: '2026-11-21T00:00:00.000Z' }])); },
    },
    {
      name: 'project-pending', status: 404, code: 'agent_not_found',
      change: () => { vi.spyOn(projectStore, 'projectRegistryMutationState').mockReturnValue({ ...projectStore.projectRegistryMutationState(), pending: true }); },
    },
    { name: 'project-removed', status: 404, code: 'agent_not_found', change: () => projectStore.remove(project.id) },
    { name: 'authorization-revoked', status: 403, code: 'authorization_revoked', change: () => { annexPeers.removePeer(peer.fingerprint); } },
    { name: 'runtime-replaced', status: 409, code: 'not_chat', change: () => { registerChatRuntime({ ...runtime }); } },
    { name: 'runtime-stopped', status: 409, code: 'not_chat', change: () => { running = false; } },
    { name: 'images-disabled', status: 409, code: 'images_not_supported', change: () => { runtime.getCapabilities = () => ({ ...MINIMAL_CHAT_CAPABILITIES, images: false }); } },
  ];

  describe.each(['body', 'staging'] as const)('registration changes during real %s awaits', (phase) => {
    it.each(changes)('refuses $name and leaves no staged image', async ({ status, code, change }) => {
      const before = await savedFiles();
      let entered = false;
      let release = () => {};
      let pending: ReturnType<typeof upload>;
      if (phase === 'body') {
        fixture.bodyEntered = () => { entered = true; };
        pending = upload((finish) => { release = finish; });
      } else {
        fixture.stage = 'readdir';
        fixture.stageEntered = () => { entered = true; };
        fixture.stageRelease = new Promise<void>((resolve) => { release = resolve; });
        pending = upload();
      }
      try {
        await vi.waitFor(() => expect(entered).toBe(true));
        await change();
        const primaryAfterChange = fs.readFileSync(primary);
        release();
        expect(await pending).toMatchObject({ status, body: { version: 1, error: code } });
        expect(fs.readFileSync(primary)).toEqual(primaryAfterChange);
        fixture.stage = undefined;
        expect(await savedFiles()).toEqual(before);
      } finally { release(); fixture.stage = undefined; }
    });
  });

  it.each(changes.filter((change) => ['disposed', 'authorization-revoked', 'runtime-replaced'].includes(change.name)))(
    'discards a written image when $name wins before staging publication',
    async ({ status, code, change }) => {
      const before = await savedFiles();
      let entered = false;
      let release = () => {};
      fixture.stage = 'realpath';
      fixture.stageEntered = () => { entered = true; };
      fixture.stageRelease = new Promise<void>((resolve) => { release = resolve; });
      const pending = upload();
      try {
        await vi.waitFor(() => expect(entered).toBe(true));
        expect(fs.readdirSync(fixture.attachments)).toHaveLength(before.length + 1);
        await change();
        release();
        expect(await pending).toMatchObject({ status, body: { error: code } });
        fixture.stage = undefined;
        expect(await savedFiles()).toEqual(before);
      } finally { release(); fixture.stage = undefined; }
    },
  );

  it.each(['corrupt', 'duplicate ids', 'unreadable'] as const)(
    'refuses a %s primary despite a healthy backup, without recovery writes',
    async (failure) => {
      const backup = `${primary}.bak`;
      fs.writeFileSync(backup, JSON.stringify([agent]));
      if (failure === 'corrupt') fs.writeFileSync(primary, '{corrupt primary');
      else if (failure === 'duplicate ids') fs.writeFileSync(primary, JSON.stringify([agent, agent]));
      else vi.mocked(fsp.open).mockRejectedValueOnce(Object.assign(new Error('Fixture primary unreadable'), { code: 'EACCES' }));
      const primaryBefore = fs.readFileSync(primary);
      const backupBefore = fs.readFileSync(backup);
      const imagesBefore = await savedFiles();
      expect(await upload()).toMatchObject({ status: 404, body: { error: 'agent_not_found' } });
      expect(fs.readFileSync(primary)).toEqual(primaryBefore);
      expect(fs.readFileSync(backup)).toEqual(backupBefore);
      expect(await savedFiles()).toEqual(imagesBefore);
    },
  );

  it('an unflushed local removal revokes its still-unchanged primary-file lease', async () => {
    const lease = await agentConfig.readDurableRegistrationLease(project.path, agent.id, agent.createdAt);
    expect(lease).not.toBeNull();
    if (!lease) throw new Error('Expected a verified registration lease');
    const before = fs.readFileSync(primary);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      expect(lease.isCurrent()).toBe(true);
      expect(await agentConfig.deleteUnregister(project.path, agent.id)).toMatchObject({ ok: true });
      expect(fs.readFileSync(primary)).toEqual(before);
      expect(lease.isCurrent()).toBe(false);
      agentConfig.clearAgentConfigCache(project.path);
      await agentConfig.initializeDurableProject(project.path);
      expect(agentConfig.peekCachedDurableConfig(project.path, agent.id)).not.toBeNull();
      expect(lease.isCurrent()).toBe(false);
    } finally {
      await lease.close();
      await agentConfig.flushAgentConfig(project.path);
      vi.useRealTimers();
    }
  });

  it.each(['changed registration', 'benign appended byte'] as const)(
    'checks primary bytes for %s even with indistinguishable metadata',
    async (change) => {
      const lease = await agentConfig.readDurableRegistrationLease(project.path, agent.id, agent.createdAt);
      expect(lease).not.toBeNull();
      if (!lease) throw new Error('Expected a verified registration lease');
      const actual = await vi.importActual<typeof import('fs')>('fs');
      const before = actual.statSync(primary, { bigint: true });
      vi.mocked(fs.statSync).mockImplementation(((...args: Parameters<typeof actual.statSync>) =>
        args[0] === primary ? before : actual.statSync(...args)) as typeof actual.statSync);
      vi.mocked(fs.fstatSync).mockReturnValue(before);
      try {
        expect(lease.isCurrent()).toBe(true);
        const text = actual.readFileSync(primary, 'utf8');
        if (change === 'changed registration') {
          actual.writeFileSync(primary, text.replace(agent.createdAt, '2026-11-21T00:00:00.000Z'));
          expect(actual.statSync(primary, { bigint: true }).size).toBe(before.size);
        } else {
          actual.appendFileSync(primary, ' ');
          expect(actual.statSync(primary, { bigint: true }).size).toBe(before.size + BigInt(1));
        }
        expect(lease.isCurrent()).toBe(change !== 'changed registration');
      } finally {
        vi.mocked(fs.statSync).mockImplementation(actual.statSync);
        vi.mocked(fs.fstatSync).mockImplementation(actual.fstatSync);
        await lease.close();
      }
    },
  );
});
