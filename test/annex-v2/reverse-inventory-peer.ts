import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { afterAll, vi } from 'vitest';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { installDialPolicy, sizedPng, type DialPolicy } from './reverse-parity-fixture';
import type { ConfigurePeer, PeerInfo } from './reverse-client-peer';
import type { IPty } from 'node-pty';

interface FixturePty extends IPty {
  closed: boolean;
  writes: string[];
  sizes: Array<[number, number]>;
  emitData(data: string): void;
}

const fixture = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  // Keep the real PTY cwd check: macOS's /private/var temporary directory is restricted.
  const cache = path.join(process.cwd(), 'node_modules', '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const dir = fs.mkdtempSync(path.join(cache, 'annex-inventory-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, '.claude');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = path.join(dir, '.gitconfig');
  return { dir, events: [] as Array<{ channel: string; payload: unknown }>, logs: [] as unknown[], ptys: [] as FixturePty[], lifecycleRoot: null as string | null };
});

vi.mock('node-pty', () => ({
  spawn(_file: string, _args: string[], options: { cols?: number; rows?: number }) {
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: { exitCode: number }) => void>();
    let cols = options.cols ?? 80;
    let rows = options.rows ?? 24;
    const native: FixturePty = {
      pid: process.pid, get cols() { return cols; }, get rows() { return rows; }, process: 'fixture-shell',
      closed: false, writes: [], sizes: [], handleFlowControl: false,
      onData: (listener) => { dataListeners.add(listener); return { dispose() { dataListeners.delete(listener); } }; },
      onExit: (listener) => { exitListeners.add(listener); return { dispose() { exitListeners.delete(listener); } }; },
      write(data) {
        const text = data.toString();
        native.writes.push(text);
        if (text === '/exit\r' || text === 'exit\r' || text === '\x04') queueMicrotask(() => native.kill());
      },
      resize(nextCols, nextRows) { cols = nextCols; rows = nextRows; native.sizes.push([cols, rows]); },
      clear() {}, pause() {}, resume() {},
      kill() {
        if (native.closed) return;
        native.closed = true;
        queueMicrotask(() => { for (const listener of exitListeners) listener({ exitCode: 0 }); });
      },
      emitData(data) {
        if (native.closed) throw new Error('The fixture PTY has exited');
        for (const listener of dataListeners) listener(data);
      },
    };
    fixture.ptys.push(native);
    return native;
  },
}));
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
  flushPendingFor() {},
}));
vi.mock('../../src/main/services/annex-network-profile', async (original) => ({
  ...await original<typeof import('../../src/main/services/annex-network-profile')>(),
  annexNetworkProfile: () => ({ host: '127.0.0.1', advertise: false }),
}));
vi.mock('../../src/main/services/annex-network-channel', async (original) => ({
  ...await original<typeof import('../../src/main/services/annex-network-channel')>(),
  connectTo() {},
}));
vi.mock('../../src/main/services/agent-system', async (original) => {
  const actual = await original<typeof import('../../src/main/services/agent-system')>();
  return {
    ...actual,
    spawnAgent: async (params: import('../../src/main/services/agent-system').SpawnAgentParams) => {
      if (!fixture.lifecycleRoot || params.projectPath !== fixture.lifecycleRoot) throw new Error('Unexpected provider start: the fixture backend has not been installed');
      return actual.spawnAgent(params);
    },
  };
});

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
import { ClaudeCodeProvider, registerProvider } from '../../src/main/orchestrators';
import { groupProjectHost } from '../../src/main/services/group-project-host';
import { flushAllGroupProjects } from '../../src/main/services/group-project-registry';
import { getBulletinBoard, flushAllBulletinBoards } from '../../src/main/services/group-project-bulletin';
import type { BulletinMessage } from '../../src/shared/group-project-types';
import type { SessionTranscriptPage } from '../../src/shared/session-types';
import type { DurableAgentConfig } from '../../src/shared/types';
import * as eventBus from '../../src/main/services/annex-event-bus';
import { writeKey } from '../../src/main/services/plugin-storage';
import * as ptyManager from '../../src/main/services/pty-manager';
import * as agentCalls from '../../src/main/services/annex-agent-calls';
import { authorizeQueuedAnnexCall } from '../../src/main/services/annex-agent-call-host';
import { getConnectionDirection, setConnectionLink, setConnectionTools } from '../../src/main/services/connection-grants-store';
import { registerAgentTools } from '../../src/main/services/clubhouse-mcp/tools/agent-tools';
import { runAgentToolForRemoteCaller } from '../../src/main/services/clubhouse-mcp/tool-registry';
import { bindingManager } from '../../src/main/services/clubhouse-mcp/binding-manager';
import { onMembershipChanged } from '../../src/main/services/annex-network-membership';
import { startGroupProjectNetwork } from '../../src/main/services/group-project-network';
import { remoteGroupProjectGrantGate } from '../../src/main/services/group-project-remote-grants';
import { groupProjectRoster } from '../../src/main/services/group-project-roster';
import { startProjectLinksNetwork } from '../../src/main/services/project-links-network';
import { changeProjectLinks, projectLinksStore } from '../../src/main/services/project-links-store';
import { startLinkedProjectStateNetwork } from '../../src/main/services/linked-project-state-network';
import { startLinkedProjectStateService } from '../../src/main/services/linked-project-state-service';
import { applyProjectStateChange, flushProjectStateForTests, getProjectState, hydrateProjectState } from '../../src/main/services/project-state-store';
import type { ReplicaNetworkOptions } from '../../src/main/services/replica-network';
import { withSettingsSurface } from '../../src/main/services/settings-audit';
import { setAgentGrant } from '../../src/main/services/agent-grants-service';
import { handoffHost, localHandoffAgent, startHandoffs, stopHandoffs } from '../../src/main/services/handoff-host';
import { prepareCallerHandoff } from '../../src/main/services/handoff-preparations';
import { registerHandoffTools } from '../../src/main/services/clubhouse-mcp/tools/handoff-tools';
import { withHandoffAgreementCall } from '../../src/main/services/clubhouse-mcp/handoff-permissions';
import { readHandoffTransferManifest, requestHandoffTransfer } from '../../src/main/services/handoff-transfer-transport';
import * as agentSystem from '../../src/main/services/agent-system';
import * as headlessSettings from '../../src/main/services/headless-settings';
import * as chatRuntimeSettings from '../../src/main/services/chat-runtime-settings';
import * as hookServer from '../../src/main/services/hook-server';
import * as mcpBridge from '../../src/main/services/clubhouse-mcp/bridge-server';

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
export const BULLETIN_MESSAGE_BYTES = 100 * 1024;
export const BULLETIN_MESSAGES = 100;
export const NATIVE_TRANSCRIPT_EVENTS = 5;
export const NATIVE_TRANSCRIPT_EVENT_BYTES = 2 * 1024 * 1024;
export const NATIVE_SESSION_ID = '00000000-0000-4000-8000-000000000003';
export const SMALL_SESSION_ID = '00000000-0000-4000-8000-000000000004';
export const LARGE_TEXT_BYTES = 9 * 1024 * 1024;

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
  await writeKey({
    pluginId: 'canvas', scope: 'project-local', projectPath: root, key: 'canvas-instances',
    value: [{ id: 'fixture-canvas', name: 'Canvas', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null }],
  });
  await writeKey({ pluginId: 'canvas', scope: 'project-local', projectPath: root, key: 'canvas-active-id', value: 'fixture-canvas' });
  const gitRoot = path.join(fixture.dir, 'git-project');
  const gitRemote = path.join(fixture.dir, 'remote.git');
  const git = (args: string[], cwd = gitRoot) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const nativePty = () => {
    const native = fixture.ptys[fixture.ptys.length - 1];
    if (!native) throw new Error('No fixture PTY has been started');
    return native;
  };
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
  registerAgentTools();
  const stopAgentCalls = agentCalls.startAgentCalls({
    transport: {
      connected: client.isMachineConnected, post: client.postToMachine,
      machineName: client.machineAlias, onConnected: client.onSatelliteConnected,
      supportsDurableDelivery: async (machine) => {
        const reply = await client.postToMachine(machine, '/api/v1/network/agent-delivery-capabilities', {});
        if (reply.status === 404) return false;
        if (reply.status !== 200) throw new Error(`Durable delivery negotiation failed (${reply.status})`);
        return reply.body !== null && typeof reply.body === 'object'
          && 'deliveryVersion' in reply.body && reply.body.deliveryVersion === 1
          && 'receiptBoundary' in reply.body && reply.body.receiptBoundary === 'runtime-accepted';
      },
    },
    runTool: runAgentToolForRemoteCaller, authorizeQueuedCall: authorizeQueuedAnnexCall,
    describeLocalAgent: async (id) => {
      const config = await agentConfig.getDurableConfig(root, id);
      return config ? { name: config.name, projectName: project.name } : undefined;
    },
  });
  const memberOptions = {
    isMember: agentCalls.isNetworkComputer,
    members: () => peers.listPeers().map((peer) => peer.fingerprint.toLowerCase()).filter(agentCalls.isNetworkComputer),
    onMembershipChanged,
  };
  const transport = {
    connected: client.isMachineConnected, post: client.postToMachine,
    machineName: client.machineAlias, onConnected: client.onSatelliteConnected,
  };
  const stopGroups = startGroupProjectNetwork({ ...memberOptions, transport });
  groupProjectHost.setRemoteWriteGate(remoteGroupProjectGrantGate);
  const replicas: ReplicaNetworkOptions = {
    ...memberOptions,
    isMember: (machine) => settings.networkEnabled() && agentCalls.isNetworkComputer(machine),
    members: () => settings.networkEnabled() ? memberOptions.members() : [],
    pairing: (machine) => { const peer = peers.getPeer(machine); return peer && JSON.stringify([peer.tlsCertificateFingerprint, peer.pairingId]); },
    transport: { ...transport, post: (machine, url, body) => client.postToMachine(machine, url, body, { maxResponseBytes: 1024 * 1024 }) },
  };
  const stopLinks = startProjectLinksNetwork(replicas);
  const stopLinkedNetwork = startLinkedProjectStateNetwork(replicas);
  hydrateProjectState({});
  const linkedState = startLinkedProjectStateService();
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
      await setConnectionLink({ agentId: agent.id }, { agentId: remote.agentId, machineId: remote.fingerprint }, true);
      bindingManager.bind(agent.id, { targetId: `${remote.agentId}@${remote.fingerprint}`, targetKind: 'agent', label: remote.alias, agentName: agent.name, targetName: `${remote.alias} agent`, projectName: project.name });
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
    retryControl() {
      if (!remote) throw new Error('Inventory peer is not configured');
      control.closeFor(remote.fingerprint, 'out');
      control.retryConnection(remote.fingerprint);
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
    async imageUpload(size: number): Promise<WireAnswer> {
      if (!remote) throw new Error('Inventory peer is not configured');
      const body = size <= 1 ? Buffer.alloc(size, 0xff) : sizedPng(size);
      return this.wire({
        method: 'POST', path: `/api/v1/mobile/agents/${remote.agentId}/attachments`,
        headers: { 'content-type': 'image/png' }, body,
      });
    },
    async receivedImage() {
      const images = driver.last.sent.flatMap((message) => message.content).filter((part) => part.type === 'image');
      const image = images[images.length - 1];
      if (!image || image.type !== 'image') throw new Error('The provider has not received an image');
      const input = fs.createReadStream(image.path);
      const digest = createHash('sha256');
      for await (const chunk of input) digest.update(chunk);
      return { bytes: input.bytesRead, digest: digest.digest('hex'), mimeType: image.mimeType };
    },
    async prepareLifecycle() {
      const provider = new ClaudeCodeProvider();
      vi.spyOn(provider, 'checkAvailability').mockResolvedValue({ available: true });
      vi.spyOn(provider, 'getBinaryPath').mockReturnValue(process.execPath);
      vi.spyOn(provider, 'buildSpawnCommand').mockResolvedValue({ binary: process.execPath, args: ['-e', 'throw new Error("P8 must use the in-memory PTY backend")'] });
      vi.spyOn(provider, 'buildHeadlessCommand').mockRejectedValue(new Error('P8 never starts a headless provider'));
      registerProvider(provider);
      await headlessSettings.setProjectSpawnMode(root, 'interactive');
      await chatRuntimeSettings.saveSettings({ 'claude-code': { mode: 'terminal' } });
      await hookServer.start();
      await mcpBridge.start();
      const config = await agentConfig.createDurable(root, 'lifecycle fixture', 'blue', undefined, false, 'claude-code');
      fixture.lifecycleRoot = root;
      return config.id;
    },
    async lifecycleState(id: string) {
      return {
        running: agentSystem.isAgentRunning(id), runtime: agentRegistry.get(id)?.runtime,
        runningIds: agentSystem.getRunningAgentIds([...agentRegistry.getAllRegistrations().keys()]),
        order: (await agentConfig.listDurable(root)).map((config) => config.id),
      };
    },
    deleteRemoteAgent(id: string) {
      if (!remote) throw new Error('Inventory peer is not configured');
      return client.requestDeleteDurable(remote.fingerprint, remote.projectId, id, 'force');
    },
    initializeProject() { return agentConfig.initializeDurableProject(root); },
    async externalConfigEdit() {
      await agentConfig.flushAgentConfig(root);
      await agentConfig.settleAgentsFileChecksForTests();
      const cachedBefore = !!agentConfig.peekCachedDurableConfig(root, agent.id);
      const file = path.join(root, '.clubhouse', 'agents.json');
      const before = await fs.promises.readFile(file, 'utf8');
      await fs.promises.writeFile(file, `${before}\n`);
      await vi.waitUntil(() => !agentConfig.peekCachedDurableConfig(root, agent.id), { timeout: 5000, interval: 10 });
      return {
        cachedBefore,
        unchanged: JSON.stringify(JSON.parse(before)) === JSON.stringify(JSON.parse(await fs.promises.readFile(file, 'utf8'))),
        registered: !!agentRegistry.get(agent.id), running: runtime.isRunning(),
      };
    },
    async chat(input: { command: Record<string, unknown>; commandId?: string }) {
      if (!remote) throw new Error('Inventory peer is not configured');
      return client.sendChatCommand(remote.fingerprint, { agentId: remote.agentId, sessionId: remote.sessionId, ...input.command }, input.commandId);
    },
    async page(options?: { beforeSeq?: number; limit?: number }) {
      if (!remote) throw new Error('Inventory peer is not configured');
      return client.requestChatPage(remote.fingerprint, remote.agentId, options);
    },
    async chatSessions() {
      if (!remote) throw new Error('Inventory peer is not configured');
      return client.requestChatSessions(remote.fingerprint, remote.agentId);
    },
    hook() {
      eventBus.emitHookEvent(agent.id, { kind: 'pre_tool', toolName: 'Read', toolInput: { file_path: 'fixture.txt' }, timestamp: 1_700_000_000_000 });
    },
    theme() { server.broadcastThemeChanged(); },
    canvas() {
      if (!remote) throw new Error('Inventory peer is not configured');
      client.sendToSatellite(remote.fingerprint, {
        type: 'canvas:mutation', payload: {
          projectId: remote.projectId, canvasId: 'fixture-canvas',
          mutation: { type: 'renameCanvas', canvasId: 'fixture-canvas', name: 'Renamed remotely' },
        },
      });
    },
    send(frame: { type: string; payload?: Record<string, unknown> }) {
      if (!remote) throw new Error('Inventory peer is not configured');
      return client.sendToSatellite(remote.fingerprint, frame);
    },
    emitPty(data: string) { nativePty().emitData(data); },
    ptyState(sessionId: string) {
      const native = nativePty();
      return { running: ptyManager.isRunning(sessionId), buffer: ptyManager.getBufferSnapshot(sessionId), closed: native.closed, writes: native.writes, sizes: native.sizes };
    },
    async ptyBuffer(sessionId: string) {
      if (!remote) throw new Error('Inventory peer is not configured');
      return client.requestPtyBufferSnapshot(remote.fingerprint, sessionId);
    },
    async agentCall(input: { tool: string; args: Record<string, unknown> }) {
      if (!remote) throw new Error('Inventory peer is not configured');
      return agentCalls.forwardAgentCall(agent.id, `${remote.agentId}@${remote.fingerprint}`, `${remote.alias} agent`, input.tool, input.args);
    },
    connections() {
      if (!remote) throw new Error('Inventory peer is not configured');
      return {
        outgoing: getConnectionDirection({ agentId: agent.id }, { agentId: remote.agentId, machineId: remote.fingerprint }),
        incoming: getConnectionDirection({ agentId: remote.agentId, machineId: remote.fingerprint }, { agentId: agent.id }),
      };
    },
    async connectionTools(disabled: string[]) {
      if (!remote) throw new Error('Inventory peer is not configured');
      return setConnectionTools({ agentId: agent.id }, { agentId: remote.agentId, machineId: remote.fingerprint }, disabled);
    },
    async projectLink(link: boolean) {
      if (!remote) throw new Error('Inventory peer is not configured');
      return withSettingsSurface('ui', undefined, () => changeProjectLinks(link
        ? { type: 'link', a: project.id, b: `remote||${remote.fingerprint}||${remote.projectId}` }
        : { type: 'unlink', a: project.id }));
    },
    async linkedState() {
      await linkedState.settled();
      await flushProjectStateForTests();
      return { groups: projectLinksStore().groups(), pinned: getProjectState().pinnedProjectIds.includes(project.id), inactive: getProjectState().inactiveProjectIds.includes(project.id) };
    },
    projectPin(pinned: boolean) { return applyProjectStateChange({ type: 'setPinned', projectId: project.id, pinned }); },
    projectInactive(inactive: boolean) { return applyProjectStateChange({ type: 'setInactive', projectId: project.id, inactive, at: Date.now() }); },
    async createNetworkGroup() {
      const group = await groupProjectHost.create(`${alias} shared board`, { scope: { level: 'app', reach: 'network' } });
      await groupProjectHost.updateMembership(group.id, (draft) => {
        draft.explicit.push({ address: agent.id, name: agent.name, kind: 'durable', addedAt: new Date().toISOString() });
      });
      return group.id;
    },
    async networkGroup(id: string) {
      const group = await groupProjectHost.get(id);
      return group ? { group, messages: await getBulletinBoard(id).getAllMessages() } : null;
    },
    networkPost(input: { id: string; body: string }) {
      return groupProjectHost.post(input.id, 'user', 'general', input.body, { author: { label: 'user' } });
    },
    networkUpdate(input: { id: string; description: string }) {
      return groupProjectHost.update(input.id, { description: input.description }, { author: { label: 'user' } });
    },
    networkRoster(id: string) { return groupProjectRoster.describe(id); },
    async prepareHandoffs() {
      git(['remote', 'add', 'origin', 'https://example.invalid/fixture.git'], root);
      fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\n.clubhouse/\nlarge.txt\nlarge-utf8.txt\n');
      const bytes = Buffer.alloc(600 * 1024);
      let value = 0x9e3779b9;
      for (let i = 0; i < bytes.length; i++) {
        value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
        bytes[i] = value & 0xff;
      }
      fs.writeFileSync(path.join(root, 'handoff.bin'), bytes);
      git(['add', '--', 'handoff.bin', '.gitignore'], root);
      git(['-c', 'user.name=Parity Fixture', '-c', 'user.email=parity@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'handoff fixture'], root);
      registerHandoffTools();
      await withSettingsSurface('ui', undefined, async () => {
        for (const action of ['handoff.offer', 'handoff.accept'] as const) {
          await setAgentGrant(root, agent.id, { action, target: { kind: 'connected' }, mode: 'allow' });
        }
      });
      startHandoffs();
      // Schedule each receiver pull explicitly; automatic apply/wake belongs to the hosted spec.
      await handoffHost().worker.stop();
    },
    async handoffOffer() {
      if (!remote) throw new Error('Inventory peer is not configured');
      const dirty = git(['status', '--porcelain=v1', '--untracked-files=normal'], root);
      if (dirty) throw new Error(`The fixture branch is not clean: ${dirty}`);
      const prepared = await prepareCallerHandoff(agent.id, 'branch');
      const args = { to: `${remote.agentId}@${remote.fingerprint}`, task: 'Parity task', brief: 'Verify the transferred fixture.', mode: 'branch', manifest: prepared.summary };
      return withHandoffAgreementCall({ agentId: agent.id, name: 'offer_handoff', args }, () => handoffHost().coordinator.offer({
        to: { agentId: remote!.agentId, machine: remote!.fingerprint }, task: { title: args.task, brief: args.brief }, mode: 'branch', manifest: prepared.summary,
      }, localHandoffAgent(agent.id)));
    },
    handoffRecord(id: string) { return handoffHost().coordinator.service.get(id, localHandoffAgent(agent.id)); },
    async handoffAccept(id: string) {
      const args = { id, accept: true };
      return withHandoffAgreementCall({ agentId: agent.id, name: 'respond_to_handoff', args }, () =>
        handoffHost().coordinator.respond(id, localHandoffAgent(agent.id), true));
    },
    async handoffPull(id: string) {
      const record = handoffHost().coordinator.service.get(id, localHandoffAgent(agent.id));
      const manifest = await readHandoffTransferManifest(record);
      if (!manifest.bundle) throw new Error('The prepared branch has no Git bundle');
      const digest = createHash('sha256');
      let bytes = 0, chunks = 0;
      while (bytes < manifest.bundle.size) {
        const request = { op: 'read' as const, id, file: -1, offset: bytes };
        const raw = await requestHandoffTransfer(record, request);
        if (!raw || typeof raw !== 'object' || !('data' in raw) || typeof raw.data !== 'string'
          || !('sha256' in raw) || typeof raw.sha256 !== 'string' || !('offset' in raw) || raw.offset !== bytes
          || !('totalBytes' in raw) || raw.totalBytes !== manifest.bundle.size
          || !('eof' in raw) || typeof raw.eof !== 'boolean') throw new Error('Invalid handoff chunk');
        const data = Buffer.from(raw.data, 'base64');
        if (data.length === 0 || data.length > 256 * 1024 || createHash('sha256').update(data).digest('hex') !== raw.sha256
          || raw.eof !== (bytes + data.length === manifest.bundle.size)) throw new Error('Handoff chunk integrity failed');
        if (chunks === 0) {
          const repeated = await requestHandoffTransfer(record, request);
          if (JSON.stringify(repeated) !== JSON.stringify(raw)) throw new Error('A repeated offset changed the frozen bytes');
        }
        digest.update(data); bytes += data.length; chunks++;
      }
      return { bytes, chunks, digest: digest.digest('hex'), expected: manifest.bundle };
    },
    handoffCancel(id: string) { return handoffHost().coordinator.cancel(id, localHandoffAgent(agent.id)); },
    async durable(input?: { projectId: string; useWorktree: boolean }) {
      if (!remote) throw new Error('Inventory peer is not configured');
      const projectId = input?.projectId ?? remote.projectId;
      const created = await client.requestCreateDurable(remote.fingerprint, projectId, {
        name: 'temporary-member', color: 'blue', useWorktree: input?.useWorktree ?? false, orchestrator: 'claude-code',
      }) as DurableAgentConfig;
      const worktree = await client.requestWorktreeStatus(remote.fingerprint, projectId, created.id);
      const deleted = await client.requestDeleteDurable(remote.fingerprint, projectId, created.id, 'force');
      return { created, worktree, deleted };
    },
    seedLargeText() { fs.writeFileSync(path.join(root, 'large-utf8.txt'), 'é\n'.repeat(LARGE_TEXT_BYTES / 3)); },
    async largeText() {
      if (!remote) throw new Error('Inventory peer is not configured');
      const text = await client.requestFileRead(remote.fingerprint, remote.projectId, 'large-utf8.txt');
      return { bytes: Buffer.byteLength(text), digest: createHash('sha256').update(text).digest('hex') };
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
    async seedGitProject() {
      fs.mkdirSync(gitRoot);
      git(['init', '--quiet', '--template=', '--initial-branch=main']);
      git(['config', 'user.name', 'Parity Fixture']);
      git(['config', 'user.email', 'parity@example.invalid']);
      git(['config', 'commit.gpgSign', 'false']);
      git(['config', 'core.autocrlf', 'false']);
      git(['config', 'core.hooksPath', path.join(fixture.dir, 'no-hooks')]);
      git(['config', 'pull.ff', 'only']);
      fs.writeFileSync(path.join(gitRoot, 'tracked.txt'), 'initial\n');
      git(['add', '--', 'tracked.txt']);
      git(['commit', '--quiet', '-m', 'baseline']);
      git(['branch', 'fixture-side']);
      git(['init', '--quiet', '--bare', '--template=', '--initial-branch=main', gitRemote]);
      git(['remote', 'add', 'origin', gitRemote]);
      git(['push', '--quiet', '--set-upstream', 'origin', 'main']);
      fs.writeFileSync(path.join(gitRoot, 'extra.txt'), 'extra\n');
      return { projectId: (await projectStore.add(gitRoot)).id, baseline: git(['rev-parse', 'HEAD']) };
    },
    async gitOperation(input: { projectId: string; params: client.GitOperationParams }) {
      if (!remote) throw new Error('Inventory peer is not configured');
      return client.requestGitOperation(remote.fingerprint, input.projectId, input.params);
    },
    editGit(content: string) { fs.writeFileSync(path.join(gitRoot, 'tracked.txt'), content); },
    gitState() {
      return {
        head: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']),
        staged: git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean),
        stashes: git(['stash', 'list']).split('\n').filter(Boolean).length,
        // eslint-disable-next-line no-restricted-syntax -- Read disposable Git output, not repository source.
        content: fs.readFileSync(path.join(gitRoot, 'tracked.txt'), 'utf8'),
        remoteHead: git(['--git-dir', gitRemote, 'rev-parse', 'refs/heads/main']),
      };
    },
    advanceGitRemote() {
      const colleague = path.join(fixture.dir, 'colleague');
      git(['clone', '--quiet', '--template=', gitRemote, colleague]);
      git(['config', 'user.name', 'Parity Fixture'], colleague);
      git(['config', 'user.email', 'parity@example.invalid'], colleague);
      git(['config', 'commit.gpgSign', 'false'], colleague);
      git(['config', 'core.autocrlf', 'false'], colleague);
      fs.writeFileSync(path.join(colleague, 'tracked.txt'), 'external\n');
      git(['add', '--', 'tracked.txt'], colleague);
      git(['commit', '--quiet', '-m', 'external fixture commit'], colleague);
      git(['push', '--quiet', 'origin', 'main'], colleague);
      return git(['rev-parse', 'HEAD'], colleague);
    },
    async seedLargeBoard() {
      const group = await groupProjectHost.create(`${alias} board`);
      const board = getBulletinBoard(group.id);
      // Keep bootstrap notices strictly older, so both default pages contain the same 100 posts.
      const notices = await board.getAllMessages();
      await vi.waitUntil(() => notices.every((message) => Date.now() > Date.parse(message.timestamp)), { interval: 1, timeout: 1000 });
      for (let i = 0; i < BULLETIN_MESSAGES; i++) {
        await board.postMessage('Fixture', 'general', 'b'.repeat(BULLETIN_MESSAGE_BYTES));
      }
      await flushAllBulletinBoards();
      await flushAllGroupProjects();
      return group.id;
    },
    async bulletin(input: { groupId: string; kind: 'messages' | 'topic' }) {
      if (!remote) throw new Error('Inventory peer is not configured');
      const messages = (input.kind === 'messages'
        ? await client.requestBulletinAllMessages(remote.fingerprint, input.groupId)
        : await client.requestBulletinTopicMessages(remote.fingerprint, input.groupId, 'general', undefined, BULLETIN_MESSAGES)) as BulletinMessage[];
      const digest = createHash('sha256');
      for (const message of messages) digest.update(message.body);
      return { count: messages.length, bytes: messages.reduce((sum, message) => sum + Buffer.byteLength(message.body), 0), digest: digest.digest('hex') };
    },
    async seedLargeTranscript() {
      const provider = new ClaudeCodeProvider();
      registerProvider(provider);
      const cwd = agent.worktreePath || project.path;
      const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', path.resolve(cwd).replace(/[/\\]/g, '-'));
      fs.mkdirSync(dir, { recursive: true });
      const lines = Array.from({ length: NATIVE_TRANSCRIPT_EVENTS }, (_, i) => JSON.stringify({
        type: 'assistant', timestamp: 1_700_000_000_000 + i,
        message: { id: `native-message-${i}`, role: 'assistant', content: [{ type: 'text', text: 't'.repeat(NATIVE_TRANSCRIPT_EVENT_BYTES) }] },
      }));
      fs.writeFileSync(path.join(dir, `${NATIVE_SESSION_ID}.jsonl`), `${lines.join('\n')}\n`);
      fs.writeFileSync(path.join(dir, `${SMALL_SESSION_ID}.jsonl`), [
        JSON.stringify({ type: 'user', timestamp: 1_700_000_000_000, message: { role: 'user', content: [{ type: 'text', text: 'Summarize the fixture' }] } }),
        JSON.stringify({
          type: 'assistant', timestamp: 1_700_000_001_000,
          message: { id: 'small-assistant', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: 'Fixture summary complete.' }], usage: { input_tokens: 7, output_tokens: 11 } },
        }),
        '',
      ].join('\n'));
      const events = await provider.readSessionTranscript(NATIVE_SESSION_ID, cwd);
      if (!events) throw new Error('The native session reader did not find its fixture');
      return { rawEvents: events.length };
    },
    async nativeSessions() {
      if (!remote) throw new Error('Inventory peer is not configured');
      return client.requestSessionList(remote.fingerprint, remote.agentId, remote.projectId, 'claude-code');
    },
    async nativeSummary() {
      if (!remote) throw new Error('Inventory peer is not configured');
      return client.requestSessionSummary(remote.fingerprint, remote.agentId, SMALL_SESSION_ID, remote.projectId, 'claude-code');
    },
    async transcript() {
      if (!remote) throw new Error('Inventory peer is not configured');
      const page = await client.requestSessionTranscript(
        remote.fingerprint, remote.agentId, NATIVE_SESSION_ID, remote.projectId, 0, NATIVE_TRANSCRIPT_EVENTS, 'claude-code',
      ) as SessionTranscriptPage;
      const digest = createHash('sha256');
      for (const event of page.events) digest.update(event.text ?? '');
      return { count: page.events.length, totalEvents: page.totalEvents, bytes: page.events.reduce((sum, event) => sum + Buffer.byteLength(event.text ?? ''), 0), digest: digest.digest('hex') };
    },
    async emit(draft: ChatEventDraft) {
      const events = (await runtime.readTranscript()).events ?? [];
      const before = events[events.length - 1]?.seq ?? 0;
      const expected = JSON.stringify(draft.data);
      driver.last.emit(draft);
      return vi.waitFor(async () => {
        const event = (await runtime.readTranscript()).events?.find((event) => (
          event.seq > before && event.type === draft.type && JSON.stringify(event.data) === expected
        ));
        if (!event) throw new Error(`The fake provider event was not published: ${draft.type}`);
        return event.seq;
      }, { timeout: 3000, interval: 5 });
    },
    driverState() {
      return {
        sent: driver.last.sent, permissions: driver.last.responses, answers: driver.last.answers,
        models: driver.last.models, levels: driver.last.levels, interrupts: driver.last.interrupts,
        queue: runtime.getQueueState(), state: runtime.getState(), registered: !!agentRegistry.get(agent.id),
        running: runtime.isRunning(), cached: !!agentConfig.peekCachedDurableConfig(root, agent.id),
      };
    },
    async close() {
      await stopHandoffs();
      hookServer.stop();
      mcpBridge.stop();
      fixture.lifecycleRoot = null;
      linkedState.stop();
      stopLinkedNetwork();
      stopLinks();
      stopGroups();
      stopAgentCalls();
      client.stopClient();
      await runtime.stop();
      clearChatRuntimes();
      server.stop();
      control.resetControlForTests();
      await agentConfig.flushAllAgentConfigs();
      await flushAllBulletinBoards();
      await flushAllGroupProjects();
      policy?.restore();
    },
  };
}

export type InventoryPeer = Awaited<ReturnType<typeof createInventoryPeer>>;
