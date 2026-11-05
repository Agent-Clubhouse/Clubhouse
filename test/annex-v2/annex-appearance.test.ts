/**
 * Every way an agent's or project's appearance can change, against the real Annex
 * server: each is made through its real entry point, and a phone on a real socket
 * has to get a snapshot showing it. Real IPC handlers, MCP tools, CLI endpoint,
 * agent and project stores, Dispatcher service and agents.json watcher, in a temp
 * folder with HOME pointed there. Not the windows that call them, the `clubhouse`
 * program that calls the CLI endpoint, or a resize: these images are small enough
 * to be sent as they are.
 */
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import forge from 'node-forge';
import { WebSocket } from 'ws';

const A = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs'); const nodeOs = require('os') as typeof import('os'); const nodePath = require('path') as typeof import('path');
  // The real path: the store compares project paths, and a macOS temp folder is a symlink.
  const dir = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'annex-appearance-')));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return { dir, handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>() };
});

vi.mock('electron', () => ({
  app: { getPath: () => A.dir, isPackaged: false, getVersion: () => '0.0.0-harness', getName: () => 'annex-appearance', on: () => {} },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => { A.handlers.set(channel, handler); }, on: () => {} },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  shell: {},
  dialog: {},
  Notification: class {},
}));
vi.mock('bonjour-service', () => ({ default: class { publish() { return { stop() {} }; } destroy() {} } }));
vi.mock('../../src/main/services/log-service', () => ({ appLog: () => {} }));
vi.mock('../../src/main/services/annex-network-profile', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/services/annex-network-profile')>(),
  annexNetworkProfile: () => ({ host: '127.0.0.1', advertise: false }),
}));

import { IPC } from '../../src/shared/ipc-channels';
import * as annexServer from '../../src/main/services/annex-server';
import * as agentConfig from '../../src/main/services/agent-config';
import * as projectStore from '../../src/main/services/project-store';
import * as dispatcher from '../../src/main/services/dispatcher/dispatcher-service';
import * as experimentalSettings from '../../src/main/services/experimental-settings';
import { resetNewChromeCacheForTests } from '../../src/main/window-chrome';
import { NEW_CHROME_FLAG } from '../../src/shared/chrome-flag';
import { agentRegistry } from '../../src/main/services/agent-registry';
import { CLI_TOKEN_HEADER, handleCliRequest, publishCliEndpoint, unpublishCliEndpoint } from '../../src/main/services/cli-endpoint';
import { registerAgentHandlers } from '../../src/main/ipc/agent-handlers';
import { registerProjectHandlers } from '../../src/main/ipc/project-handlers';
import { registerAppearanceTools } from '../../src/main/services/clubhouse-mcp/tools/appearance-tools';
import { callTool } from '../../src/main/services/clubhouse-mcp/tool-registry';
import { setMcpCaller } from '../../src/main/services/clubhouse-mcp/mcp-call-gate';

/** A PNG as far as anything reading its header can tell, small enough to go as it is. `fill` makes it a different image. */
function png(fill: number, padding = 32): Buffer {
  const header = Buffer.from('89504e470d0a1a0a0000000d4948445200000008000000080806000000', 'hex');
  return Buffer.concat([header, Buffer.alloc(padding, fill)]);
}
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;

function clientCertificate(commonName: string) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  cert.setSubject([{ name: 'commonName', value: commonName }]);
  cert.setIssuer(cert.subject.attributes);
  cert.sign(forge.pki.privateKeyFromPem(key), forge.md.sha256.create());
  return { key, cert: forge.pki.certificateToPem(cert) };
}

describe('every appearance change reaches a phone as a snapshot', () => {
  let port = 0;
  let cliServer: http.Server;
  let cliPort = 0;
  let ws: WebSocket;
  let refsWs: WebSocket;
  const frames: any[] = [];
  /** A phone that opted in to icon references, on the same builds. */
  const refFrames: any[] = [];
  let projectPath = '';
  let projectId = '';
  let agentId = '';
  let dispatcherId = '';
  /** Past every debounce, so a snapshot that hasn't come by then isn't coming. */
  const SETTLE_MS = 800;
  /** Lets one from the last step finish. `shows` looks for the new value, so one that's late can't pass for this. */
  const QUIET_MS = 200;

  const ipc = (channel: string, ...args: unknown[]) => A.handlers.get(channel)!({}, ...args);
  const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));
  /** Until none has come for a while, so a later count only sees what comes after. */
  const quiet = async () => {
    let seen = -1;
    while (seen !== snapshots().length) {
      seen = snapshots().length;
      await settle();
    }
  };
  const snapshots = () => frames.filter((f) => f.type === 'snapshot').map((f) => f.payload);
  const refSnapshots = () => refFrames.filter((f) => f.type === 'snapshot').map((f) => f.payload);
  const version = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
  const agentIn = (payload: any) => payload.agents[projectId]?.find((a: any) => a.id === agentId);
  const projectIn = (payload: any) => payload.projects.find((p: any) => p.id === projectId);

  /** Nothing pending, then `change`, then a new snapshot that `shows` it. */
  async function expectSnapshotAfter(change: () => unknown, shows: (payload: any) => boolean, timeout = 10_000): Promise<any> {
    await new Promise((r) => setTimeout(r, QUIET_MS));
    const before = snapshots().length;
    const refsBefore = refSnapshots().length;
    await change();
    await vi.waitFor(() => {
      const fresh = snapshots().slice(before);
      expect(fresh.length).toBeGreaterThan(0);
      expect(fresh.some(shows)).toBe(true);
      expect(refSnapshots().length).toBeGreaterThan(refsBefore);
    }, { timeout, interval: 25 });
    return snapshots().at(-1);
  }

  /**
   * An edit from outside, saved again until it's seen. This checks that the watcher leads to
   * a snapshot, and not that the OS delivers one event: macOS can be seconds late, or drop
   * it when any watcher in the process opens or closes, and the store reopens its own on every event.
   */
  async function expectSnapshotAfterEdit(file: string, text: string, shows: (payload: any) => boolean): Promise<any> {
    const save = () => fs.writeFileSync(file, text);
    let again: ReturnType<typeof setInterval> | undefined;
    try {
      return await expectSnapshotAfter(() => { save(); again = setInterval(save, 2000); }, shows, 45_000);
    } finally {
      clearInterval(again);
    }
  }

  const readJson = async (file: string) => JSON.parse(await fsp.readFile(file, 'utf8'));

  const cli = async (route: string, body: object) => {
    const { token } = await readJson(cliEndpointFile());
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const text = JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: cliPort, path: route, method: 'POST', headers: { [CLI_TOKEN_HEADER]: token, 'Content-Length': Buffer.byteLength(text) } }, (res) => {
        let answer = '';
        res.on('data', (c) => { answer += c; });
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(answer) }));
      });
      req.on('error', reject);
      req.end(text);
    });
  };
  const cliEndpointFile = () => path.join(A.dir, '.clubhouse-dev', 'cli-endpoint.json');

  const imageFile = (name: string, bytes: Buffer) => {
    const file = path.join(A.dir, name);
    fs.writeFileSync(file, bytes);
    return file;
  };
  const agentIconFile = async (name: string) => (await agentConfig.agentIconFilePath(name))!;

  beforeAll(async () => {
    registerAgentHandlers();
    registerProjectHandlers();
    registerAppearanceTools();
    annexServer.start();
    await vi.waitFor(() => expect(annexServer.getStatus().port).toBeGreaterThan(0), { timeout: 20_000 });
    port = annexServer.getStatus().port;

    cliServer = http.createServer((req, res) => { void handleCliRequest(req, res); });
    await new Promise<void>((resolve) => cliServer.listen(0, '127.0.0.1', () => resolve()));
    cliPort = (cliServer.address() as { port: number }).port;
    await publishCliEndpoint(cliPort);

    projectPath = path.join(A.dir, 'project-one');
    fs.mkdirSync(projectPath);
    projectId = ((await ipc(IPC.PROJECT.ADD, projectPath)) as { id: string }).id;
    agentId = (await agentConfig.createDurable(projectPath, 'first-agent', 'indigo', undefined, false)).id;
    await agentConfig.flushAgentConfig(projectPath);
    agentRegistry.register(agentId, { projectPath, orchestrator: 'claude-code', runtime: 'pty' } as never);
    setMcpCaller(agentId, projectPath, null);

    const der = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
    const commonName = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32).match(/.{2}/g)!.join(':');
    const phone = { publicKey: der.toString('base64'), ...clientCertificate(commonName) };
    const pairBody = JSON.stringify({ pin: annexServer.getStatus().pin, publicKey: phone.publicKey, alias: 'Appearance phone', icon: 'phone', color: 'indigo' });
    await new Promise<void>((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port, path: '/pair', method: 'POST', key: phone.key, cert: phone.cert, rejectUnauthorized: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pairBody) } }, (res) => {
        res.resume();
        res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error(`pair: ${res.statusCode}`))));
      });
      req.on('error', reject);
      req.end(pairBody);
    });
    ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { key: phone.key, cert: phone.cert, rejectUnauthorized: false, maxPayload: 16 * 1024 * 1024 });
    ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
    ws.on('error', () => {});
    refsWs = new WebSocket(`wss://127.0.0.1:${port}/ws?iconRefs=1&client=mobile`, { key: phone.key, cert: phone.cert, rejectUnauthorized: false, maxPayload: 16 * 1024 * 1024 });
    refsWs.on('message', (data) => refFrames.push(JSON.parse(data.toString())));
    refsWs.on('error', () => {});
    await vi.waitFor(() => expect(snapshots().length).toBeGreaterThan(0), { timeout: 30_000 });
    await vi.waitFor(() => expect(refSnapshots().length).toBeGreaterThan(0), { timeout: 30_000 });
  }, 60_000);

  afterAll(async () => {
    ws?.terminate();
    refsWs?.terminate();
    annexServer.stop();
    unpublishCliEndpoint();
    await new Promise((r) => cliServer?.close(r));
    agentConfig.clearAgentConfigCache();
    fs.rmSync(A.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 30_000);

  it('never leaves its temp folder', () => {
    expect(os.homedir()).toBe(A.dir);
    expect(projectPath.startsWith(A.dir)).toBe(true);
  });

  describe('an agent', () => {
    it('image through the Settings crop', async () => {
      const bytes = png(1);
      const snapshot = await expectSnapshotAfter(
        () => ipc(IPC.AGENT.SAVE_ICON, projectPath, agentId, dataUrl(bytes)),
        (p) => p.agentIcons[agentId] === dataUrl(bytes),
      );
      expect(agentIn(snapshot)).toBeDefined();
    }, 30_000);

    it('a second crop, under the same file name', async () => {
      const bytes = png(2);
      await expectSnapshotAfter(
        () => ipc(IPC.AGENT.SAVE_ICON, projectPath, agentId, dataUrl(bytes)),
        (p) => p.agentIcons[agentId] === dataUrl(bytes),
      );
    }, 30_000);

    it('icon removed', async () => {
      await expectSnapshotAfter(
        () => ipc(IPC.AGENT.REMOVE_ICON, projectPath, agentId),
        (p) => p.agentIcons[agentId] === undefined,
      );
    }, 30_000);

    it('name and color through Settings', async () => {
      await expectSnapshotAfter(
        () => ipc(IPC.AGENT.UPDATE_DURABLE, projectPath, agentId, { name: 'renamed-agent', color: 'emerald' }),
        (p) => agentIn(p)?.name === 'renamed-agent' && agentIn(p)?.color === 'emerald',
      );
    }, 30_000);

    it('update_agent: emoji, then image, then cleared', async () => {
      await expectSnapshotAfter(
        () => callTool(agentId, 'update_agent', { emoji: '🦊' }),
        (p) => agentIn(p)?.emoji === '🦊',
      );
      const bytes = png(3);
      const file = imageFile('tool-image.png', bytes);
      await expectSnapshotAfter(
        () => callTool(agentId, 'update_agent', { image_path: file }),
        (p) => p.agentIcons[agentId] === dataUrl(bytes) && !agentIn(p)?.emoji,
      );
      await expectSnapshotAfter(
        () => callTool(agentId, 'update_agent', { image_path: '' }),
        (p) => p.agentIcons[agentId] === undefined,
      );
    }, 30_000);

    it('the CLI: color, then image', async () => {
      await expectSnapshotAfter(async () => {
        expect((await cli('/cli/v1/agents/update', { agentId, color: 'amber' })).status).toBe(200);
      }, (p) => agentIn(p)?.color === 'amber');
      const bytes = png(4);
      const file = imageFile('cli-image.png', bytes);
      await expectSnapshotAfter(async () => {
        expect((await cli('/cli/v1/agents/update', { agentId, imagePath: file })).status).toBe(200);
      }, (p) => p.agentIcons[agentId] === dataUrl(bytes));
    }, 30_000);

    it('an agents.json edit, and another after it, so the watcher is still on', async () => {
      const file = path.join(projectPath, '.clubhouse', 'agents.json');
      const edit = async (name: string) => {
        await agentConfig.flushAgentConfig(projectPath);
        const agents = await readJson(file);
        agents.find((a: { id: string }) => a.id === agentId).name = name;
        await expectSnapshotAfterEdit(file, JSON.stringify(agents, null, 2), (p) => agentIn(p)?.name === name);
      };
      await edit('edited-by-hand');
      await edit('edited-again');
    }, 120_000);

    it('a write that changes nothing shown sends no snapshot', async () => {
      await quiet();
      const before = snapshots().length;
      await agentConfig.updateSessionName(projectPath, agentId, 'session-1', 'a session');
      await settle();
      expect(snapshots()).toHaveLength(before);
    }, 30_000);

    // The contract: no trigger, and the next snapshot has it, because the thumbnail cache checks mtime and size.
    it('a file replaced directly under the same name: no snapshot, and the next one has it', async () => {
      const first = png(5);
      await expectSnapshotAfter(() => ipc(IPC.AGENT.SAVE_ICON, projectPath, agentId, dataUrl(first)), (p) => p.agentIcons[agentId] === dataUrl(first));
      await quiet();
      const before = snapshots().length;

      const replaced = png(6, 48);
      fs.writeFileSync(await agentIconFile(`${agentId}.png`), replaced);
      await settle();
      expect(snapshots()).toHaveLength(before);
      expect(snapshots().at(-1).agentIcons[agentId]).toBe(dataUrl(first));

      await expectSnapshotAfter(() => annexServer.broadcastSnapshotRefresh(), (p) => p.agentIcons[agentId] === dataUrl(replaced));

      // The same size counts too, as long as the time differs.
      const sameSize = png(7, 48);
      const file = await agentIconFile(`${agentId}.png`);
      fs.writeFileSync(file, sameSize);
      fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
      await expectSnapshotAfter(() => annexServer.broadcastSnapshotRefresh(), (p) => p.agentIcons[agentId] === dataUrl(sameSize));
    }, 30_000);
  });

  describe('a project', () => {
    it('image through the Settings crop, and again under the same file name', async () => {
      for (const fill of [10, 11]) {
        const bytes = png(fill);
        await expectSnapshotAfter(
          () => ipc(IPC.PROJECT.SAVE_CROPPED_ICON, projectId, dataUrl(bytes)),
          (p) => p.projectIcons[projectId] === dataUrl(bytes),
        );
      }
    }, 30_000);

    it('image from a picked file', async () => {
      const bytes = png(12);
      const file = imageFile('picked.png', bytes);
      await expectSnapshotAfter(() => projectStore.setIcon(projectId, file), (p) => p.projectIcons[projectId] === dataUrl(bytes));
    }, 30_000);

    it('icon removed', async () => {
      await expectSnapshotAfter(() => ipc(IPC.PROJECT.UPDATE, projectId, { icon: '' }), (p) => p.projectIcons[projectId] === undefined);
    }, 30_000);

    it('name, color and emoji through Settings', async () => {
      await expectSnapshotAfter(
        () => ipc(IPC.PROJECT.UPDATE, projectId, { displayName: 'Shown name', color: 'emerald', emoji: '🚀' }),
        (p) => projectIn(p)?.displayName === 'Shown name' && projectIn(p)?.color === 'emerald' && projectIn(p)?.emoji === '🚀',
      );
    }, 30_000);

    it('update_project, and the CLI', async () => {
      await expectSnapshotAfter(() => callTool(agentId, 'update_project', { display_name: 'From a tool' }), (p) => projectIn(p)?.displayName === 'From a tool');
      const bytes = png(13);
      const file = imageFile('project-tool.png', bytes);
      await expectSnapshotAfter(() => callTool(agentId, 'update_project', { image_path: file }), (p) => p.projectIcons[projectId] === dataUrl(bytes));
      await expectSnapshotAfter(async () => {
        expect((await cli('/cli/v1/projects/update', { project: projectId, displayName: 'From the CLI' })).status).toBe(200);
      }, (p) => projectIn(p)?.displayName === 'From the CLI');
    }, 30_000);

    it('a file replaced directly under the same name: no snapshot, and the next one has it', async () => {
      const first = png(14);
      await expectSnapshotAfter(() => ipc(IPC.PROJECT.SAVE_CROPPED_ICON, projectId, dataUrl(first)), (p) => p.projectIcons[projectId] === dataUrl(first));
      await quiet();
      const before = snapshots().length;

      const replaced = png(15, 48);
      fs.writeFileSync((await projectStore.iconFilePath(`${projectId}.png`))!, replaced);
      await settle();
      expect(snapshots()).toHaveLength(before);

      await expectSnapshotAfter(() => annexServer.broadcastSnapshotRefresh(), (p) => p.projectIcons[projectId] === dataUrl(replaced));
    }, 30_000);

    it('added, then removed', async () => {
      const other = path.join(A.dir, 'project-two');
      fs.mkdirSync(other);
      let otherId = '';
      await expectSnapshotAfter(async () => {
        otherId = ((await ipc(IPC.PROJECT.ADD, other)) as { id: string }).id;
      }, (p) => p.projects.some((project: { id: string }) => project.id === otherId));
      await expectSnapshotAfter(() => ipc(IPC.PROJECT.REMOVE, otherId), (p) => !p.projects.some((project: { id: string }) => project.id === otherId));
    }, 30_000);
  });

  describe('a phone on icon references', () => {
    const refsShow = async (change: () => unknown, shows: (refs: any) => boolean) => {
      const before = refSnapshots().length;
      await change();
      await vi.waitFor(() => expect(refSnapshots().slice(before).some((p) => shows(p.iconRefs))).toBe(true), { timeout: 10_000, interval: 25 });
      await quiet();
      expect(refSnapshots().at(-1).agentIcons).toEqual({});
      expect(refSnapshots().at(-1).projectIcons).toEqual({});
    };

    it('an agent crop, another under the same file name, a direct replacement, then removal', async () => {
      await quiet();
      for (const fill of [30, 31]) {
        const bytes = png(fill);
        await refsShow(() => ipc(IPC.AGENT.SAVE_ICON, projectPath, agentId, dataUrl(bytes)), (r) => r.agents[agentId]?.version === version(bytes));
      }

      const replaced = png(32, 48);
      const before = refSnapshots().length;
      fs.writeFileSync(await agentIconFile(`${agentId}.png`), replaced);
      await settle();
      expect(refSnapshots()).toHaveLength(before);
      await refsShow(() => annexServer.broadcastSnapshotRefresh(), (r) => r.agents[agentId]?.version === version(replaced));

      await refsShow(() => ipc(IPC.AGENT.REMOVE_ICON, projectPath, agentId), (r) => !!r && r.agents[agentId] === undefined);
    }, 60_000);

    it('a project crop, another under the same file name, then removal', async () => {
      for (const fill of [33, 34]) {
        const bytes = png(fill);
        await refsShow(() => ipc(IPC.PROJECT.SAVE_CROPPED_ICON, projectId, dataUrl(bytes)), (r) => r.projects[projectId]?.version === version(bytes));
      }
      await refsShow(() => ipc(IPC.PROJECT.UPDATE, projectId, { icon: '' }), (r) => !!r && r.projects[projectId] === undefined);
    }, 60_000);
  });

  describe('the Dispatcher', () => {
    const shown = (payload: any) => payload.dispatcher?.agent;
    const dispatcherPath = () => dispatcher.getDispatcherState().path!;

    it('turned on', async () => {
      experimentalSettings.saveSettings({ ...experimentalSettings.getSettings(), [NEW_CHROME_FLAG]: true });
      resetNewChromeCacheForTests();
      await expectSnapshotAfter(() => dispatcher.setDispatcherEnabled(true), (p) => !!shown(p));
      dispatcherId = dispatcher.getDispatcherAgentId()!;
      expect(shown(snapshots().at(-1)).id).toBe(dispatcherId);
    }, 30_000);

    it('color and emoji, from the CLI and from itself', async () => {
      await expectSnapshotAfter(async () => {
        expect((await cli('/cli/v1/agents/update', { agentId: dispatcherId, color: 'amber' })).status).toBe(200);
      }, (p) => shown(p)?.color === 'amber');
      agentRegistry.register(dispatcherId, { projectPath: dispatcherPath(), orchestrator: 'claude-code', runtime: 'chat' } as never);
      setMcpCaller(dispatcherId, dispatcherPath(), null);
      await expectSnapshotAfter(() => callTool(dispatcherId, 'update_agent', { emoji: '🛰️' }), (p) => shown(p)?.emoji === '🛰️');
    }, 30_000);

    it('image through the Settings crop, again under the same file name, then removed', async () => {
      for (const fill of [20, 21]) {
        const bytes = png(fill);
        await expectSnapshotAfter(
          () => ipc(IPC.AGENT.SAVE_ICON, dispatcherPath(), dispatcherId, dataUrl(bytes)),
          (p) => p.agentIcons[dispatcherId] === dataUrl(bytes),
        );
      }
      await expectSnapshotAfter(() => ipc(IPC.AGENT.REMOVE_ICON, dispatcherPath(), dispatcherId), (p) => p.agentIcons[dispatcherId] === undefined);
    }, 30_000);

    it('its agents.json edited', async () => {
      const file = path.join(dispatcherPath(), '.clubhouse', 'agents.json');
      await agentConfig.flushAgentConfig(dispatcherPath());
      const agents = await readJson(file);
      agents[0].color = 'indigo';
      await expectSnapshotAfterEdit(file, JSON.stringify(agents, null, 2), (p) => shown(p)?.color === 'indigo');
    }, 60_000);

    it('turned off', async () => {
      await expectSnapshotAfter(async () => {
        // Stopped, as turning it off does to a real one: it was only ever registered here.
        agentRegistry.untrack(dispatcherId);
        await dispatcher.setDispatcherEnabled(false);
      // Its record stays listed while it is off, so history isn't lost.
      }, (p) => p.dispatcher?.enabled === false && p.dispatcher.offReason === 'switched_off' && !!shown(p));
    }, 30_000);
  });
});
