/**
 * Canonical Annex mobile protocol fixtures (test/fixtures/annex-mobile/).
 *
 * Drives the real annex-server, mobile-control, mobile-agents,
 * mobile-helper-requests, mobile-attachments and chat echo code over pinned
 * mTLS and the WebSocket handler, and records every message the phone sees or
 * sends. Only the leaves (disk, git, CLIs, PTYs) are faked. The phone vendors
 * these files and decodes each one in its own contract tests, so a change
 * here is a protocol change: see docs/mobile-control-v1.md#contract-fixtures.
 *
 * `npm run fixtures:annex-mobile` rewrites the files; this suite (and
 * `npm run fixtures:annex-mobile -- --check`) fails when they are stale.
 */
import { _resetProviderQuotaForTesting } from './provider-quota';
import { noteRoutingPolicyChanged } from './helper-routing-changes';
import { _settleHelperRoutingForTesting } from './helper-routing';
import type { HelperStartWarning } from '../../shared/helper-routing';
import { QUOTA_STALE_MS, quotaRefetchDelaySeconds } from '../../shared/helper-routing';
import { CLAUDE_WORKING_WINDOW_NOTE } from '../../shared/context-window';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import https from 'https';
import tls from 'tls';
import { EventEmitter } from 'events';

const W = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
  durables: {} as Record<string, Array<Record<string, any>>>,
  running: new Set<string>(),
  revert: new Set<string>(),
  transcripts: {} as Record<string, unknown[]>,
  sessions: {} as Record<string, unknown[]>,
  projectsThrow: false,
  iconsUnavailable: false,
  iconDir: null as string | null,
  spawnShellError: null as string | null,
  ptyData: [] as Array<(id: string, data: string, seq: number) => void>,
  ptyExit: [] as Array<(id: string, code: number) => void>,
  peers: new Map<string, any>(),
  tls: null as null | Record<string, unknown>,
  tlsFingerprint: '',
  helperStart: 'approve' as 'approve' | 'blocked' | 'refused' | 'no_valid_mapping' | 'no_candidate' | 'auto_off' | 'warned',
  presets: {} as Record<string, Record<string, { model: string; effort: string | null }>>,
  presetsRevision: 0,
  autoHelpers: false,
  projectDefaults: {} as Record<string, unknown>,
  helperStartRefusals: 0,
  providers: {} as Record<string, any>,
  dispose: { ok: true } as Record<string, unknown>,
  projectStateReady: true,
  finishedReady: true,
  // The app-wide Dispatcher (#2533): off unless a test turns it on.
  dispatcher: { flagOn: false, enabled: false, newLayout: true },
  dispatcherListeners: new Set<(state: any) => void>(),
  // What the CLI offers for the model (#2660); a case sets it, else Claude's.
  contextOptions: null as null | Record<string, unknown>,
  canvases: null as unknown[] | null,
}));
const DISPATCHER_PATH = vi.hoisted(() => '/Users/me/.clubhouse/dispatcher');

vi.mock('./dispatcher/dispatcher-service', () => {
  const config = () => (W.durables[DISPATCHER_PATH] ?? [])[0] ?? null;
  const enabled = () => W.dispatcher.flagOn && W.dispatcher.enabled;
  const state = () => ({ enabled: enabled(), flagOn: W.dispatcher.flagOn, agentId: config()?.id ?? null,
    path: config() ? DISPATCHER_PATH : null, config: config() ? { ...config() } : null });
  return {
    DISPATCHER_NAME: 'Dispatcher',
    getDispatcherPath: () => DISPATCHER_PATH,
    isDispatcherAgentId: (id?: string | null) => !!id && id === config()?.id,
    isDispatcherEnabled: enabled,
    getDispatcherState: state,
    onDispatcherChanged: (l: (s: unknown) => void) => { W.dispatcherListeners.add(l); return () => W.dispatcherListeners.delete(l); },
    setDispatcherEnabled: async (on: boolean) => {
      W.dispatcher.enabled = on;
      for (const l of W.dispatcherListeners) l(state());
      return state();
    },
  };
});
vi.mock('./dispatcher/dispatcher-settings', () => ({ isDispatcherEnabled: () => W.dispatcher.flagOn && W.dispatcher.enabled }));
vi.mock('../window-chrome', () => ({ newChromeEnabled: () => W.dispatcher.newLayout }));

vi.mock('./annex-chat-content', () => ({ readMobileChatContent: async () => ({ kind: 'text', name: 'README.md', text: '# App' }) }));
vi.mock('./agent-runtime/chat-files', async (importOriginal) => ({
  ...await importOriginal<typeof import('./agent-runtime/chat-files')>(),
  agentFolders: async () => ['/work/app/.clubhouse/agents/planner', '/work/app'],
}));
vi.mock('./experimental-settings', () => ({ getSettings: () => ({ richChatContent: true }), saveSettings: () => {} }));
vi.mock('./agent-runtime/checkpoint-tracker', async (importOriginal) => ({
  ...await importOriginal<typeof import('./agent-runtime/checkpoint-tracker')>(),
  isRevertRunning: async (id: string) => W.revert.has(id),
}));
vi.mock('./agent-runtime/chat-transcript', async (importOriginal) => ({
  ...await importOriginal<typeof import('./agent-runtime/chat-transcript')>(),
  readChatTranscript: async (agentId: string) => W.transcripts[agentId] ?? [],
  listChatSessions: async (agentId: string) => W.sessions[agentId] ?? [],
}));
vi.mock('./project-state-store', async () => {
  const shared = await import('../../shared/project-state');
  let state = shared.DEFAULT_PROJECT_STATE;
  const listeners = new Set<(change: unknown) => void>();
  return {
    isProjectStateReady: () => W.projectStateReady,
    getProjectState: () => state,
    onProjectStateChange: (l: (change: unknown) => void) => { listeners.add(l); return () => listeners.delete(l); },
    applyProjectStateChange: (op: import('../../shared/project-state').ProjectStateOp) => {
      const next = shared.applyProjectStateOp(state, op);
      if (next === state) return false;
      state = next;
      for (const l of listeners) l({ state, acked: {} });
      return true;
    },
    setForTests: (next: import('../../shared/project-state').ProjectState) => { state = next; },
  };
});
vi.mock('./finished-quick-agents-store', async () => {
  const shared = await import('../../shared/finished-quick-agents');
  let state: import('../../shared/finished-quick-agents').FinishedQuickAgents = {};
  const listeners = new Set<(change: unknown) => void>();
  return {
    isFinishedQuickAgentsReady: () => W.finishedReady,
    getFinishedQuickAgents: () => state,
    onFinishedQuickAgentsChange: (l: (change: unknown) => void) => { listeners.add(l); return () => listeners.delete(l); },
    applyFinishedQuickAgentChange: (op: import('../../shared/finished-quick-agents').FinishedQuickAgentOp) => {
      const next = shared.applyFinishedQuickAgentOp(state, op);
      if (next === state) return false;
      state = next;
      for (const l of listeners) l({ state, acked: {} });
      return true;
    },
    setForTests: (next: import('../../shared/finished-quick-agents').FinishedQuickAgents) => { state = next; },
  };
});
// Real sockets on loopback only; never advertise fixtures on the LAN.
vi.mock('./annex-network-profile', async (importOriginal) => ({
  ...await importOriginal<typeof import('./annex-network-profile')>(),
  annexNetworkProfile: () => ({ host: '127.0.0.1' as const, advertise: false }),
}));
vi.mock('bonjour-service', () => ({ default: class { publish() { return { stop() {} }; } destroy() {} } }));
vi.mock('./log-service', () => ({ appLog: () => {} }));
// Real images through the real code. Each icon name gets a PNG of its own, a valid one with its name in a text
// chunk, so the fixtures' bytes, hashes and sizes describe something a phone can decode. A "path" here ends in the name.
const VALID_PNG_BASE64 = vi.hoisted(() => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==');
vi.mock('./icon-images', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./icon-images')>();
  const [nodeFs, nodeOs, nodePath, zlib] = await Promise.all([import('fs'), import('os'), import('path'), import('zlib')]);
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'annex-contract-icons-'));
  W.iconDir = dir;
  const iconPng = (name: string) => {
    const valid = Buffer.from(VALID_PNG_BASE64, 'base64');
    const body = Buffer.from(`tEXticon\0${name}`, 'latin1');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length - 4);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([valid.subarray(0, 33), length, body, crc, valid.subarray(33)]);
  };
  return {
    ...actual,
    readIconImage: async (file: string) => {
      if (W.iconsUnavailable) return actual.ICON_TEMPORARILY_UNAVAILABLE;
      const name = file.split('|')[1];
      const real = nodePath.join(dir, name);
      if (!nodeFs.existsSync(real)) nodeFs.writeFileSync(real, iconPng(name));
      return actual.readIconImage(real);
    },
  };
});
vi.mock('./project-store', () => ({
  list: async () => { if (W.projectsThrow) throw new Error('disk gone'); return W.projects; },
  readIconData: async (icon: string) => (icon ? 'data:image/png;base64,iVBORw0KGgo=' : null),
  onProjectsChanged: () => () => {},
  iconFilePath: async (icon: string) => (icon ? `iVBORw0KGgo=|${icon}` : null),
}));
vi.mock('./agent-config', () => {
  const find = (projectPath: string, id: string) => (W.durables[projectPath] ?? []).find((d) => d.id === id) ?? null;
  return {
    listDurable: async (projectPath: string) => W.durables[projectPath] ?? [],
    readAgentIconData: async (icon: string) => (icon ? 'data:image/png;base64,R0lGODlhAQABAAAAACw=' : null),
    agentIconFilePath: async (icon: string) => (icon ? `R0lGODlhAQABAAAAACw=|${icon}` : null),
    getDurableConfig: async (projectPath: string, id: string) => find(projectPath, id),
    updateDurableConfig: async (projectPath: string, id: string, updates: Record<string, unknown>) => {
      const agent = find(projectPath, id) ?? {};
      Object.assign(agent, updates);
      // agent-config's own rule (its tests cover it): null clears; a choice the new model lacks clears with a notice.
      if (agent.contextWindow === null) { delete agent.contextWindow; delete agent.contextWindowNotice; }
      if (updates.contextWindow) delete agent.contextWindowNotice;
      const offered = W.contextOptions?.choices as Array<{ id: string }> | undefined;
      if (updates.contextWindow === undefined && agent.contextWindow && offered && !offered.some((c) => c.id === agent.contextWindow)) {
        agent.contextWindowNotice = `${agent.contextWindow} isn't one this model offers.`;
        delete agent.contextWindow;
      }
    },
    updateDurable: async (projectPath: string, id: string, updates: Record<string, unknown>) => { Object.assign(find(projectPath, id) ?? {}, updates); },
    // The orchestration policy service's own writes (#2228).
    setOrchestrationConfig: async (projectPath: string, id: string, config?: Record<string, unknown>) => {
      const agent = find(projectPath, id);
      if (!agent) throw new Error('Agent not found');
      if (config && Object.keys(config).length > 0) agent.orchestration = { ...config };
      else delete agent.orchestration;
    },
    listHelpers: async (projectPath: string, id: string) => (W.durables[projectPath] ?? []).filter((d) => d.parentAgentId === id && !d.disposedAt),
    getWorktreeStatus: async () => ({ isValid: true, branch: 'main', uncommittedFiles: [], unpushedCommits: [], hasRemote: true }),
  };
});
// Helpers across projects (#2511), for the policy service: the fixture's helpers are all in their parent's project.
vi.mock('./helper-index', () => ({
  listHelpersEverywhere: async (projectPath: string, id: string) => (W.durables[projectPath] ?? [])
    .filter((d) => d.parentAgentId === id && !d.disposedAt)
    .map((config) => ({ projectPath, config })),
}));
vi.mock('./pty-manager', () => ({
  getBuffer: () => '',
  getSerializedBufferSnapshot: async () => ({ data: '\u001b[1mready\u001b[0m\r\n$ ', seq: 42, cols: 120, rows: 40 }),
  isRunning: (id: string) => W.running.has(id),
  isStopping: () => false,
  getShellCwd: () => undefined,
  write: () => {},
  resize: () => {},
  spawnShell: async () => { if (W.spawnShellError) throw new Error(W.spawnShellError); },
  killShell: () => true,
}));
vi.mock('./file-service', () => ({ readTree: async () => [], readFile: async () => '' }));
vi.mock('./annex-identity', () => ({
  getOrCreateIdentity: () => ({ publicKey: 'fixture-public-key', privateKey: 'fixture-private-key', fingerprint: 'AA:BB:CC:DD', createdAt: '2026-01-01T00:00:00.000Z' }),
  getPublicIdentity: () => ({ publicKey: 'fixture-public-key', fingerprint: 'AA:BB:CC:DD' }),
  computeFingerprint: () => 'mobile-fixture-identity',
}));
vi.mock('./annex-tls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./annex-tls')>();
  return {
    createTlsServerOptions: () => W.tls,
    extractPeerFingerprint: actual.extractPeerFingerprint,
    extractPeerCertificateFingerprint: actual.extractPeerCertificateFingerprint,
    getCertificateFingerprint: () => W.tlsFingerprint,
  };
});
vi.mock('./annex-peers', () => ({
  checkBruteForce: () => ({ allowed: true, delayMs: 0, locked: false, attemptsRemaining: 3 }),
  recordFailedAttempt: () => {},
  recordSuccessfulAttempt: () => {},
  addPeer: (peer: { fingerprint: string }) => { W.peers.set(peer.fingerprint, peer); },
  getPeer: (fp: string) => W.peers.get(fp),
  updateLastSeen: () => {},
  listPeers: () => [...W.peers.values()],
  removePeer: (fp: string) => { W.peers.delete(fp); },
  removeAllPeers: () => { W.peers.clear(); },
  unlockPairing: () => {},
}));
vi.mock('./annex-event-bus', () => ({
  setActive: () => {},
  onPtyData: (l: (id: string, data: string, seq: number) => void) => { W.ptyData.push(l); return () => {}; },
  onPtyExit: (l: (id: string, code: number) => void) => { W.ptyExit.push(l); return () => {}; },
  onHookEvent: () => () => {},
  onAgentSpawned: () => () => {},
  onGroupProjectChanged: () => () => {},
  onBulletinMessage: () => () => {},
  emitGroupProjectChanged: () => {},
  emitBulletinMessage: () => {},
}));
vi.mock('./group-project-registry', () => ({ groupProjectRegistry: { list: async () => [], get: async () => null, update: async () => null, onChange: () => () => {} } }));
vi.mock('./group-project-bulletin', () => ({ getBulletinBoard: () => ({ getDigest: async () => [], getTopicMessages: async () => [], getAllMessages: async () => [] }) }));
vi.mock('./group-project-shoulder-tap', () => ({ executeShoulderTap: async () => ({ taskId: 'tap_1', delivered: [], failed: [] }) }));
vi.mock('./group-project-polling', () => ({ setProjectPolling: async () => ({}), getProjectPollingState: async () => ({ pollingEnabled: false, members: [] }) }));
vi.mock('./clubhouse-mcp/binding-manager', () => ({ bindingManager: { getAllBindings: () => [] } }));
vi.mock('./theme-service', () => ({ getActiveThemeId: () => 'catppuccin-mocha', getSettings: () => ({ themeId: 'catppuccin-mocha' }) }));
vi.mock('./annex-settings', () => ({
  getSettings: () => ({ enableServer: false, enableClient: false, deviceName: 'Studio Mac', alias: 'Studio Mac', icon: 'computer', color: 'indigo', autoReconnect: false }),
  saveSettings: () => {},
  getLastPorts: () => ({ mainPort: 0, pairingPort: 0 }),
  saveLastPorts: async () => {},
}));
vi.mock('./plugin-manifest-registry', () => ({ listAllManifests: () => [] }));
vi.mock('./plugin-storage', () => ({
  readKey: async ({ key }: { key: string }) => (key === 'canvas-instances' ? W.canvases : null),
  writeKey: async () => {},
}));
const ORCHESTRATORS = vi.hoisted(() => [
  { id: 'claude-code', displayName: 'Claude Code', shortName: 'CC', badge: 'Beta', capabilities: { permissions: true, headless: true, structuredOutput: true, hooks: true, sessionResume: true } },
  { id: 'codex-cli', displayName: 'Codex', shortName: 'CX', capabilities: { permissions: false, headless: true, structuredOutput: false, hooks: false, sessionResume: true } },
]);
vi.mock('./agent-system', () => ({
  getAvailableOrchestrators: () => ORCHESTRATORS,
  checkAvailability: async (_path: string, id: string) => (id === 'codex-cli' ? { available: false, error: 'Codex CLI not found' } : { available: true }),
  resolveOrchestrator: async (_path: string, id?: string) => ({
    id: id ?? 'claude-code',
    getContextWindowOptions: async (model?: string) => W.contextOptions ?? (await import('../../shared/context-window')).claudeContextWindowOptions(model),
    getModelOptions: async () => (id === 'codex-cli'
      ? [{ id: 'default', label: 'Default' }, { id: 'gpt-5', label: 'GPT-5' }]
      : [{ id: 'default', label: 'Default' }, { id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }]),
  }),
  resolveProfileEnv: async () => undefined,
  spawnAgent: async () => {},
  killAgent: async () => {},
  isHeadlessAgent: () => false,
}));
vi.mock('../../shared/name-generator', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../shared/name-generator')>(),
  generateQuickName: () => 'swift-fox',
  generateDurableName: () => 'brave-otter',
}));
vi.mock('../../shared/agent-id', () => ({ generateQuickAgentId: () => 'quick_new' }));
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: () => {} }));
// mobile-agents' leaves: settings, CLIs, git and personas.
vi.mock('./agent-creation', async (importOriginal) => ({
  ...await importOriginal<typeof import('./agent-creation')>(),
  startDurableCreation: async (_path: string, params: { name: string; color: string }) => {
    if (params.name === 'taken') throw new Error('A folder named taken already exists in .clubhouse/agents');
    const config = { id: 'durable_created', name: params.name, color: params.color,
      createdAt: '2026-10-30T00:00:00.000Z', branch: `${params.name}/standby`, worktreePath: `/work/app/.clubhouse/agents/${params.name}`, creation: { state: 'creating', startedAt: '2026-10-30T00:00:00.000Z' } };
    // Recorded, as startDurableCreation does, so a create's orchestration policy has an agent to land on.
    W.durables[_path] = [...(W.durables[_path] ?? []).filter((d) => d.id !== config.id), config];
    return { agentId: 'durable_created', done: Promise.resolve('ready'), config };
  },
}));
vi.mock('./agent-settings-service', () => ({
  readProjectAgentDefaults: async () => W.projectDefaults,
  writeProjectAgentDefaults: async (_path: string, defaults: Record<string, unknown>) => {
    const { noteRoutingPolicyChanged: note } = await import('./helper-routing-changes');
    const changed = W.projectDefaults.helperAuto !== defaults.helperAuto;
    W.projectDefaults = defaults;
    if (changed) note();
  },
  readMcpCatalog: async () => [
    { id: 'github', name: 'GitHub', description: 'Issues and pull requests', args: [] },
    { id: 'ado', name: 'Azure DevOps', description: 'Work items', args: [{ name: 'org' }] },
  ],
  readDefaultMcps: async () => ['github'],
}));
vi.mock('./materialization-service', () => ({
  listAvailablePersonas: async () => [{ id: 'qa', name: 'QA', source: 'builtin' }, { id: 'architect', name: 'Architect', source: 'project' }],
  // Orchestration defaults from persona front-matter: only the architect sets any.
  resolvePersonaId: (agent: { persona?: string }, defaults: { persona?: string }) => agent.persona || defaults.persona,
  readLayeredPersonaRaw: async (_projectPath: string, personaId: string) =>
    (personaId === 'architect' ? '---\norchestration: {"control": "ask-before-start", "maxHelpers": 4}\n---\n\n# Architect' : undefined),
}));
vi.mock('./orchestration-settings', () => ({
  getSettings: () => ({ globalHelperCap: 20 }),
  getGlobalHelperCap: () => 20,
  getPresets: () => W.presets,
  getPresetsRevision: () => W.presetsRevision,
  savePresets: async (presets: unknown) => { W.presets = presets as never; W.presetsRevision++; },
  getAutoHelpers: () => W.autoHelpers,
  saveAutoHelpers: async (on: boolean) => { W.autoHelpers = on; W.presetsRevision++; },
  bumpPresetsRevision: async () => { W.presetsRevision++; },
}));
// The helper presets read the CLIs' model lists: only those cases put providers here.
vi.mock('../orchestrators', async (importOriginal) => {
  const original = await importOriginal<typeof import('../orchestrators')>();
  return {
    ...original,
    getProvider: (id: string) => W.providers[id] ?? original.getProvider(id as never),
    getAllProviders: () => [...Object.values(W.providers), ...original.getAllProviders()],
  };
});
vi.mock('./orchestrator-settings', () => ({ getSettings: () => ({ enabled: ['claude-code', 'codex-cli'] }) }));
vi.mock('./profile-settings', () => ({ getProfile: () => undefined }));
vi.mock('./clubhouse-mode-settings', () => ({ isClubhouseModeEnabled: () => false }));
vi.mock('./chat-idle-settings', () => ({ chatIdleSettings: { getSettings: () => ({ idleTimeoutMinutes: 30 }) } }));
vi.mock('./chat-runtime-settings', () => ({
  isChatEnabled: () => true,
  resolveRuntimeMode: (_provider: string, override?: string) => ({ mode: override ?? 'chat' }),
}));
vi.mock('./agent-runtime/chat-drivers', async (importOriginal) => ({
  ...await importOriginal<typeof import('./agent-runtime/chat-drivers')>(),
  resolveChatDriver: (provider: string) => (provider === 'claude-code' ? {} : undefined),
}));
vi.mock('./git-service', () => ({
  isInsideGitRepo: async (p: string) => p.startsWith('/work/app'),
  getBranchChanges: async () => ({ available: true, base: 'main', noBase: false, ahead: 2, uncommitted: 1,
    files: [{ path: 'a.ts', additions: 80, deletions: 40 }, { path: 'b.ts', additions: 14, deletions: 11 }] }),
}));
vi.mock('./persona-application', () => ({ applyPersonaToAgent: async () => undefined }));
// Helper requests (#159): the real request stores and runner; the orchestrator side is faked.
vi.mock('./clubhouse-mcp/tools/helper-tools', async () => {
  const starts = await import('./helper-start-requests');
  return {
    approveHelperStart: async (projectPath: string, requestId: string) => {
      if (W.helperStart === 'blocked') return { ok: false, message: 'Planner isn’t running. Wake it, then approve again.' };
      starts.takeStartRequest(projectPath, requestId);
      if (W.helperStart === 'refused') return { ok: false, message: 'A helper named impl-ipc already exists.' };
      if (W.helperStart === 'no_valid_mapping') {
        W.helperStartRefusals++;
        return { ok: false, code: 'no_valid_mapping', message: 'Couldn’t start impl-ipc because no hard preset for codex-cli is offered now. Change it in Settings > Helpers.' };
      }
      if (W.helperStart === 'warned') {
        return { ok: true, helperId: 'durable_helper_new', message: 'Started', warning: { code: 'quota_near_limit', asOf: new Date(NOW).toISOString(), message: 'codex-cli is close to its plan limit. The helper is started on it anyway, as asked.' } };
      }
      if (W.helperStart === 'no_candidate') {
        return { ok: false, code: 'no_candidate', message: 'Couldn’t start impl-ipc because no provider can take a hard task right now (claude-code: Close to its limit; codex-cli: The provider reports its limit reached).' };
      }
      if (W.helperStart === 'auto_off') {
        return { ok: false, code: 'auto_off', message: 'Couldn’t start impl-ipc because Auto provider is off: This project turned it off.' };
      }
      return { ok: true, helperId: 'durable_helper_new', message: 'Started' };
    },
    declineHelperStart: async (projectPath: string, requestId: string) => ({ ok: !!starts.takeStartRequest(projectPath, requestId), message: '' }),
  };
});
vi.mock('./helper-dispose-decisions', async (importOriginal) => {
  const disposals = await import('./helper-dispose-requests');
  return {
    ...await importOriginal<typeof import('./helper-dispose-decisions')>(),
    disposeHelperForUser: async () => W.dispose,
    reportDisposeDecision: async (projectPath: string, helperId: string) => {
      const found = disposals.listDisposeRequests().find((r) => r.request.projectPath === projectPath && r.request.helperId === helperId);
      if (found) disposals.takeDisposeRequest(projectPath, helperId, found.request.orchestratorId);
      return { ok: true, delivered: true, message: '' };
    },
  };
});

import forge from 'node-forge';
import * as annexServer from './annex-server';
import * as projectStateStore from './project-state-store';
import * as finishedQuickStore from './finished-quick-agents-store';
import * as eventReplay from './annex-event-replay';
import { recordStartRequest, _resetStartRequestsForTesting } from './helper-start-requests';
import { listDisposeRequests, recordDisposeRequest, _resetDisposeRequestsForTesting } from './helper-dispose-requests';
import { getAgentRuntime, registerChatRuntime, clearChatRuntimes, publishChatEvent } from './agent-runtime';
import { ChatAgentRuntime } from './agent-runtime/chat-runtime';
import { onChatEvent } from './agent-runtime/chat-event-bus';
import { FakeChatDriver } from './agent-runtime/fake-chat-driver';
import { findSenderAgent, messageDisplay, MINIMAL_CHAT_CAPABILITIES, sentPartName, type ChatCapabilities } from '../../shared/chat';
import { agentAvatarSpec, agentInitials, initialsTextColor } from '../../shared/agent-avatar';
import { AGENT_COLORS } from '../../shared/name-generator';
import { MOBILE_COMMAND_FIELDS, MobileCommandService, NULLABLE_ON_UPDATE, isOptionalCommandField } from './mobile-control';
import { MOBILE_COMMAND_TYPES } from '../../shared/mobile-control';
import { CHAT_EVENT_TYPES, type ChatEvent } from '../../shared/chat';
import { annexPtyHost } from '../../shared/annex-pty';

// ── Fixture output ───────────────────────────────────────────────────────────

const FIXTURE_DIR = path.resolve(__dirname, '../../..', 'test/fixtures/annex-mobile');
const WRITE = process.env.ANNEX_MOBILE_FIXTURES === 'write';
const NOW = 1_800_000_000_000; // 2027-01-15T08:00:00.000Z
const fixtures = new Map<string, unknown>();

/** Recursively sorted keys, two-space indent, trailing newline. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable((value as Record<string, unknown>)[k])]));
  }
  return value;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/**
 * Epochs, tokens, attachment and helper request ids are random UUIDs. Each
 * distinct one becomes `00000000-0000-4000-8000-<n>` in order of first
 * appearance across the files (sorted by name), so output doesn't depend on
 * how many UUIDs the desktop happens to draw.
 */
function render(): Map<string, string> {
  const ids = new Map<string, string>();
  const out = new Map<string, string>();
  for (const name of [...fixtures.keys()].sort()) {
    const text = `${JSON.stringify(stable(fixtures.get(name)), null, 2)}\n`.replace(UUID, (id) => {
      const key = id.toLowerCase();
      if (!ids.has(key)) ids.set(key, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`);
      return ids.get(key)!;
    });
    out.set(name, text);
  }
  return out;
}

// ── World ────────────────────────────────────────────────────────────────────

const APP = '/work/app';
const ts = (n: number) => NOW - 60_000 + n * 1000;
const CHAT_CAPS = {
  steer: true, queue: 'client', interrupt: true, resume: 'native', planApproval: true, questions: true, subagents: 'full',
  usage: 'cost', limits: true, images: true, slashCommands: true, modelSwitch: 'per_turn', effortSwitch: 'per_turn', effortDefault: false,
  liveLevels: ['plan', 'ask', 'auto_edit', 'full_access'], login: 'terminal', systemPrompt: true,
};
const BASIC_CAPS = { ...CHAT_CAPS, steer: false, images: false, questions: false, modelSwitch: 'none', effortSwitch: 'none', liveLevels: [] };
const PERMISSION_OPTIONS = [
  { optionId: 'allow', kind: 'allow_once', label: 'Allow' },
  { optionId: 'always', kind: 'allow_always', label: 'Always allow', scope: 'npm test:*' },
  { optionId: 'deny', kind: 'reject_once', label: 'Deny' },
];
const MEDIA_REF = `${'ab'.repeat(32)}.png`;

function envelope(seq: number, type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): ChatEvent {
  return { v: 2, agentId: 'durable_chat', sessionId: 'sess_live', seq, ts: ts(seq), type, data, ...extra } as ChatEvent;
}

/** The live session's transcript: what the chat snapshot folds and pages. */
const LIVE_TRANSCRIPT: ChatEvent[] = [
  envelope(1, 'session_started', { driver: 'claude_agent_sdk', provider: 'claude-code', cwd: '/work/app/.clubhouse/agents/planner', resumed: false, model: 'opus', level: 'ask', capabilities: CHAT_CAPS }),
  envelope(2, 'session_info', { title: 'Wire the IPC', models: [{ id: 'opus', label: 'Opus', description: 'Most capable', costHint: '1x' }, { id: 'sonnet', label: 'Sonnet' }],
    efforts: ['low', 'medium', 'high'], levelNames: { ask: 'default', plan: 'plan' }, mcpServers: [{ name: 'github', status: 'connected' }],
    contextLimits: { effectiveTokens: 300000, compactAtTokens: 267000, reservedTokens: 33000, note: CLAUDE_WORKING_WINDOW_NOTE } }),
  envelope(3, 'model_changed', { modelId: 'opus', effort: 'high', effortIsDefault: false }),
  envelope(4, 'turn_started', { trigger: 'prompt' }, { turnId: 'turn_1' }),
  envelope(5, 'user_message', { messageId: 'msg_1', clientCommandId: 'cmd_photo', source: 'annex', delivery: 'prompt', content: [
    { type: 'text', text: 'What is on this screen?' },
    { type: 'image', mimeType: 'image/png', path: '/Users/me/Library/Application Support/Clubhouse/chat-attachments/durable_chat/shot.png', mediaRef: MEDIA_REF, width: 1179, height: 2556 },
  ] }, { turnId: 'turn_1' }),
  envelope(6, 'agent_message', { messageId: 'amsg_1', text: 'It shows the **settings** page.' }, { turnId: 'turn_1' }),
  envelope(7, 'tool_call', { toolCallId: 'tool_1', kind: 'execute', title: 'npm test', status: 'pending', toolName: 'Bash', rawInput: { command: 'npm test' } }, { turnId: 'turn_1' }),
  envelope(8, 'permission_request', { requestId: 'perm_1', title: 'Run npm test', description: 'npm test', toolCallId: 'tool_1', toolName: 'Bash', options: PERMISSION_OPTIONS }, { turnId: 'turn_1' }),
  envelope(9, 'question', { requestId: 'q_1', questions: [{ id: 'which', prompt: 'Which branch?', header: 'Branch', options: [{ id: 'main', label: 'main' }, { id: 'dev', label: 'dev', description: 'Next release' }], multiSelect: false, allowFreeText: true }] }, { turnId: 'turn_1' }),
  envelope(10, 'usage', { scope: 'session', tokens: { input: 1200, output: 300, total: 1500 }, costUsd: 0.04, context: { used: 30000, size: 200000 } }),
  envelope(11, 'queue_state', { queuedMessageIds: ['msg_q'], transition: { messageIds: ['msg_q'], status: 'queued' } }),
  envelope(12, 'commands_available', { commands: [{ name: 'compact', description: 'Clear conversation history but keep a summary in context', inputHint: '<optional custom summarization instructions>', startOnly: true },
    { name: 'review', description: 'Review a pull request', inputHint: '<pr>' }, { name: 'frontend-design', description: 'Create distinctive, production-grade frontend interfaces' }] }),
];

function chatRuntime(agentId: string, sessionId: string, caps: Record<string, unknown>, events: ChatEvent[], full: boolean) {
  return {
    kind: 'chat', agentId, isRunning: () => true, getState: () => 'waiting_permission', getSessionId: () => sessionId,
    getCapabilities: () => caps, readTranscript: async () => ({ events }),
    sendMessage: async (_blocks: unknown, opts: { delivery: string }) => ({ delivery: opts.delivery === 'auto' ? 'prompt' : opts.delivery, messageId: `msg_${opts.delivery}` }),
    interrupt: async () => {},
    respondPermission: async () => {},
    answerQuestion: async () => {},
    getPendingPermissionOptions: (id: string) => (id === 'perm_1' ? PERMISSION_OPTIONS : undefined),
    hasPendingQuestion: (id: string) => id === 'q_1',
    getQueueState: () => (full ? { queuedMessageIds: ['msg_q'], queueStateSeq: 11, queueRemovalSupported: true } : { queuedMessageIds: [], queueStateSeq: 0, queueRemovalSupported: false }),
    ...(full ? { removeQueued: async (ids: string[]) => ids, setModel: async () => {}, setLevel: async () => {} } : { setModel: async () => {} }),
  };
}

function resetWorld() {
  W.projects = [
    { id: 'proj_app', name: 'app', displayName: 'App', path: APP, color: 'indigo', icon: 'proj_app.png' },
    { id: 'proj_docs', name: 'docs', path: '/work/docs' },
  ];
  W.durables = {
    [APP]: [
      { id: 'durable_chat', name: 'planner', color: 'indigo', emoji: '🦊', icon: 'durable_chat.png', orchestrator: 'claude-code', model: 'opus',
        branch: 'planner/standby', worktreePath: `${APP}/.clubhouse/agents/planner`, createdAt: '2026-10-01T09:00:00.000Z', lastSessionId: 'sess_live', mcpIds: ['github'],
        orchestration: { orchestrate: true, maxHelpers: 3 } },
      { id: 'durable_basic', name: 'reviewer', color: 'teal', orchestrator: 'codex-cli', createdAt: '2026-10-02T09:00:00.000Z', lastSessionId: 'sess_basic' },
      { id: 'durable_sleepy', name: 'brave-otter', color: 'amber', branch: 'brave-otter/standby', worktreePath: `${APP}/.clubhouse/agents/brave-otter`,
        createdAt: '2026-10-03T09:00:00.000Z', lastSessionId: 'sess_old', idleSleep: 60 },
      { id: 'durable_term', name: 'shell-runner', color: 'rose', orchestrator: 'claude-code', runtimeMode: 'terminal', createdAt: '2026-10-04T09:00:00.000Z' },
      { id: 'durable_fresh', name: 'fresh', color: 'cyan', createdAt: '2026-10-05T09:00:00.000Z', creation: { state: 'creating', startedAt: '2026-10-05T09:00:00.000Z' } },
      { id: 'durable_docs', name: 'Docs', color: 'violet', parentAgentId: 'durable_chat', worktreePath: `${APP}/.clubhouse/agents/docs`, createdAt: '2026-10-06T09:00:00.000Z' },
    ],
    [DISPATCHER_PATH]: [
      { id: 'durable_dispatcher', name: 'Dispatcher', color: 'indigo', orchestrator: 'claude-code', freeAgentMode: true, persona: 'dispatcher',
        idleSleep: 'never', runtimeMode: 'chat', mcpOverride: true, createdAt: '2026-10-07T09:00:00.000Z', lastSessionId: 'sess_dispatch' },
    ],
  };
  W.dispatcher = { flagOn: false, enabled: false, newLayout: true };
  W.running = new Set(['durable_term']);
  W.revert = new Set();
  W.transcripts = {
    durable_sleepy: [
      { v: 2, agentId: 'durable_sleepy', sessionId: 'sess_old', seq: 1, ts: ts(1), type: 'user_message', data: { messageId: 'old_1', source: 'user', delivery: 'prompt', content: [{ type: 'text', text: 'Rename the module' }] } },
      { v: 2, agentId: 'durable_sleepy', sessionId: 'sess_old', seq: 2, ts: ts(2), type: 'agent_message', data: { messageId: 'old_2', text: 'Renamed.' } },
      { v: 2, agentId: 'durable_sleepy', sessionId: 'sess_old', seq: 3, ts: ts(3), type: 'session_ended', data: { reason: 'idle_timeout' } },
    ],
  };
  W.sessions = {
    durable_chat: [
      { sessionId: 'sess_live', nativeSessionId: 'native-live', driver: 'claude_agent_sdk', provider: 'claude-code', startedAt: ts(1), lastActiveAt: ts(11), title: 'Wire the IPC', lastSeq: 11 },
      { sessionId: 'sess_prev', provider: 'claude-code', startedAt: NOW - 86_400_000, lastActiveAt: NOW - 86_000_000, endedAt: NOW - 86_000_000, lastSeq: 40 },
    ],
  };
  W.projectsThrow = false;
  W.spawnShellError = null;
  W.helperStart = 'approve';
  W.dispose = { ok: true, stopped: true };
  W.projectStateReady = true;
  W.finishedReady = true;
  clearChatRuntimes();
  registerChatRuntime(chatRuntime('durable_chat', 'sess_live', CHAT_CAPS, LIVE_TRANSCRIPT, true) as never);
  registerChatRuntime(chatRuntime('durable_basic', 'sess_basic', BASIC_CAPS, [
    { v: 2, agentId: 'durable_basic', sessionId: 'sess_basic', seq: 1, ts: ts(1), type: 'session_started', data: { driver: 'codex_app_server', provider: 'codex-cli', cwd: APP, resumed: false, model: 'gpt-5', level: 'ask', capabilities: BASIC_CAPS } } as ChatEvent,
  ], false) as never);
  (projectStateStore as unknown as { setForTests: (s: object) => void }).setForTests({
    pinnedProjectIds: ['proj_app'], inactiveProjectIds: [], projectActivity: { proj_app: NOW - 5 * 60_000, proj_docs: NOW - 9 * 86_400_000 }, idleDays: 7,
  });
  (finishedQuickStore as unknown as { setForTests: (s: object) => void }).setForTests({
    proj_app: [
      { id: 'quick_done', projectId: 'proj_app', name: 'calm-heron', mission: 'Write the release notes', summary: 'Wrote docs/release.md', filesModified: ['docs/release.md'], exitCode: 0, completedAt: NOW - 3_600_000, parentAgentId: 'durable_chat' },
      { id: 'quick_stopped', projectId: 'proj_app', name: 'bold-lynx', mission: 'Profile the build', summary: null, filesModified: [], exitCode: 130, completedAt: NOW - 7_200_000, cancelled: true },
    ],
    proj_docs: [],
  });
  annexServer._testing.trackedQuickAgents.clear();
  annexServer._testing.trackedQuickAgents.set('quick_1', {
    id: 'quick_1', name: 'swift-fox', kind: 'quick', status: 'running', prompt: 'Fix the flaky test', model: null, orchestrator: 'claude-code',
    freeAgentMode: false, parentAgentId: 'durable_chat', projectId: 'proj_app', spawnedAt: NOW - 120_000,
  });
  _resetStartRequestsForTesting({ keepListeners: true });
  _resetDisposeRequestsForTesting();
}

function helperStart(args: Record<string, string> = { model: 'opus' }, warning?: HelperStartWarning): string {
  const result = recordStartRequest(APP, 'durable_chat', 'planner', { name: 'impl-ipc', task: 'Wire the IPC', ...args }, NOW - 600_000, warning);
  if (!result.ok) throw new Error('start request not recorded');
  return result.request.requestId;
}
function helperDispose(checks: Record<string, unknown> = { dirty: 2, unpushed: 1, unmerged: 0 }, forceRequested = true): string {
  recordDisposeRequest(APP, 'durable_docs', 'durable_chat', { projectPath: APP, orchestratorId: 'durable_chat', helperId: 'durable_docs', helperName: 'Docs', checks, forceRequested } as never, NOW - 300_000);
  return listDisposeRequests().find((r) => r.request.helperId === 'durable_docs')!.requestId;
}

// ── Clients ──────────────────────────────────────────────────────────────────

function certificate(cn: string) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(NOW - 86_400_000); cert.validity.notAfter = new Date(NOW + 365 * 86_400_000);
  cert.setSubject([{ name: 'commonName', value: cn }]); cert.setIssuer(cert.subject.attributes);
  cert.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: keyPem };
}

let port = 0;
let client: { cert: string; key: string };
let epoch = '';
let bearerToken = '';

interface Reply { status: number; body: any; headers?: Record<string, unknown> }
function send(method: string, route: string, body?: Buffer | object, opts: { client?: typeof client | null; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const raw = Buffer.isBuffer(body) ? body : body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = https.request({ host: '127.0.0.1', port, path: route, method, ...(opts.client === null ? {} : opts.client ?? client),
      // Loopback self-signed test certificates; the phone pins the desktop certificate.
      rejectUnauthorized: false, agent: false,
      headers: { 'Content-Type': 'application/json', ...(raw && { 'Content-Length': String(raw.length) }), ...opts.headers } }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode!, body: data && !res.headers['content-type']?.startsWith('image/') ? JSON.parse(data) : null, headers: res.headers }));
    });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
const pickIconHeaders = (headers: Record<string, unknown>) => Object.fromEntries(
  ['etag', 'cache-control', 'content-type', 'content-length'].filter((name) => headers[name] !== undefined).map((name) => [name, headers[name]]),
) as Record<string, string>;
const exchange = async (method: string, route: string, body?: object) => ({ request: { method, path: route, ...(body && { body }) }, response: await send(method, route, body).then(({ status, body }) => ({ status, body })) });

/** A busy machine is slow here, not wrong: each request is a fresh mTLS handshake. These only bound how long a failure takes to report. */
const TEST_TIMEOUT_MS = 30_000;
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 10_000 });

type FakeWs = EventEmitter & { readyState: number; send: ReturnType<typeof vi.fn>; ping: () => void; close: () => void };
async function connect(auth: 'mtls' | 'bearer' = 'mtls', opts: { iconRefs?: boolean } = {}): Promise<FakeWs> {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), ping: () => {}, close: () => {} }) as FakeWs;
  if (opts.iconRefs) annexServer._testing.wsIconRefs.add(ws as never);
  annexServer._testing.wsAuthTypes.set(ws as never, auth);
  if (auth === 'mtls') annexServer._testing.wsPeerFingerprints.set(ws as never, 'mobile-fixture-identity');
  annexServer._testing.wss!.clients.add(ws as never);
  annexServer._testing.wss!.emit('connection', ws);
  await eventually(() => expect(ws.send).toHaveBeenCalled());
  return ws;
}
const frames = (ws: FakeWs) => ws.send.mock.calls.map((c) => JSON.parse(c[0] as string));
/** Send a client frame and collect what this connection gets back. */
async function roundTrip(ws: FakeWs, frame: object, count = 1) {
  ws.send.mockClear();
  ws.emit('message', JSON.stringify(frame));
  // count 0: frames that get no reply are handled synchronously, within the emit above.
  if (count > 0) await eventually(() => expect(ws.send.mock.calls.length).toBeGreaterThanOrEqual(count));
  return frames(ws);
}

// ── Commands ─────────────────────────────────────────────────────────────────

let nextCommand = 0;
const commandFixtures = new Map<string, Array<{ name: string; request: object; response: Reply }>>();
async function command(name: string, fields: Record<string, unknown>, opts: { epoch?: string; commandId?: string; version?: number } = {}) {
  const request = { version: opts.version ?? 1, epoch: opts.epoch ?? epoch, commandId: opts.commandId ?? `cmd_${String(++nextCommand).padStart(3, '0')}`, ...fields };
  const { status, body } = await send('POST', '/api/v1/mobile/commands', request);
  const type = String(fields.type);
  const key = (MOBILE_COMMAND_TYPES as readonly string[]).includes(type) && !name.startsWith('common:') ? type : '_common';
  const list = commandFixtures.get(key) ?? [];
  list.push({ name: name.replace(/^common:/, ''), request, response: { status, body } });
  commandFixtures.set(key, list);
  return { status, body };
}

/** Sequence numbers depend on what the suite published before; the shape is the contract. The cursor sent becomes 1000. */
function renumberFrames(list: any[], before: number) {
  const offset = (n: number) => (typeof n === 'number' ? n - before + 1000 : n);
  return list.map((f) => ({ ...f, ...('seq' in f && { seq: offset(f.seq) }), ...('fromSeq' in f && { fromSeq: offset(f.fromSeq) }),
    ...('toSeq' in f && { toSeq: offset(f.toSeq) }), ...('lastSeq' in f && { lastSeq: offset(f.lastSeq) }), ...('oldestAvailable' in f && { oldestAvailable: 1 }) }));
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('Annex mobile contract fixtures', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeAll(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const server = certificate('clubhouse-fixture-desktop');
    client = certificate('mobile-fixture-identity');
    W.tls = { ...server, requestCert: true, rejectUnauthorized: false };
    W.tlsFingerprint = new crypto.X509Certificate(server.cert).fingerprint256;
    resetWorld();
    annexServer.start();
    await eventually(() => expect(annexServer.getStatus().port).toBeGreaterThan(0));
    port = annexServer.getStatus().port;
    const publicKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const pair = await send('POST', '/pair', { pin: annexServer.getStatus().pin, publicKey, alias: 'Mason’s iPhone', icon: 'iphone', color: 'emerald', pairingMode: 'persistent' });
    expect(pair.status).toBe(200);
    bearerToken = pair.body.token;
    fixtures.set('pairing.json', { request: { method: 'POST', path: '/pair', body: { pin: '123456', publicKey: '<base64 Ed25519 SPKI DER>', alias: 'Mason’s iPhone', icon: 'iphone', color: 'emerald', pairingMode: 'persistent' } },
      // The client certificate is generated per run.
      response: { status: pair.status, body: { ...pair.body, tlsCertificateFingerprint: Array(32).fill('AB').join(':') } } });
  }, TEST_TIMEOUT_MS);
  afterAll(() => { annexServer.stop(); clearChatRuntimes(); });
  // restoreMocks clears the clock between tests.
  beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW); });

  it('capabilities', async () => {
    const res = await send('GET', '/api/v1/mobile/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.controlAvailable).toBe(true);
    epoch = res.body.epoch;
    // The bound port is the OS's choice.
    if (res.body.routes) res.body.routes.port = 7432;
    fixtures.set('capabilities.json', { request: { method: 'GET', path: '/api/v1/mobile/capabilities' }, response: { status: res.status, body: res.body } });
  });

  it('WebSocket snapshot and REST catalog', async () => {
    const ws = await connect();
    const [snapshot] = frames(ws);
    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.payload).toHaveProperty('projectState');
    expect(snapshot.payload).toHaveProperty('finishedQuickAgents');
    const durable = (id: string) => snapshot.payload.agents.proj_app.find((a: { id: string }) => a.id === id);
    expect(durable('durable_docs').parentAgentId).toBe('durable_chat');
    expect(durable('durable_chat')).not.toHaveProperty('parentAgentId');
    // The host platform is the machine's; record it as a Mac's so the file is the same on every CI runner.
    expect(snapshot.payload.ptyHost.platform).toBe(process.platform);
    snapshot.payload.ptyHost = annexPtyHost('darwin', undefined);
    fixtures.set('snapshot.json', { direction: 'desktop-to-phone', frame: snapshot });
    // Helper requests, both kinds, as the snapshot lists them.
    helperStart(); helperDispose();
    const withHelpers = await connect();
    const helperFrame = frames(withHelpers)[0];
    expect(helperFrame.payload.helperRequests).toHaveLength(2);
    fixtures.set('snapshot-helper-requests.json', { direction: 'desktop-to-phone', field: 'helperRequests', value: helperFrame.payload.helperRequests });
    _resetStartRequestsForTesting({ keepListeners: true }); _resetDisposeRequestsForTesting();
    fixtures.set('rest-catalog.json', {
      projects: await exchange('GET', '/api/v1/projects'),
      agents: await exchange('GET', '/api/v1/projects/proj_app/agents'),
      unknownProject: await exchange('GET', '/api/v1/projects/missing/agents'),
    });
  });

  it('a snapshot over its limit, and the routes for what it left out', async () => {
    W.canvases = [{ id: 'canvas_1', name: 'Main', views: [{ id: 'cv_1', type: 'sticky-note', content: 'x'.repeat(9 * 1024 * 1024) }] }];
    const snapshot = frames(await connect()).find((f) => f.type === 'snapshot').payload;
    expect(snapshot).not.toHaveProperty('canvasState');
    expect(snapshot).not.toHaveProperty('appCanvasState');
    expect(snapshot.snapshotTruncated.bytes).toBeGreaterThan(9 * 1024 * 1024);
    // The agents and icons are still there.
    expect(snapshot.agents.proj_app.length).toBeGreaterThan(0);
    expect(Object.keys(snapshot.agentIcons).length).toBeGreaterThan(0);
    fixtures.set('snapshot-truncated.json', {
      direction: 'desktop-to-phone',
      note: 'A field in omitted is unknown, not empty: keep what you have. bytes is pinned here, and is the frame size before anything was given up.',
      value: { snapshotTruncated: { ...snapshot.snapshotTruncated, bytes: 9437184 } },
    });

    W.canvases = [{ id: 'canvas_1', name: 'Main', views: [] }];
    const project = await exchange('GET', '/api/v1/mobile/canvas/proj_app');
    const app = await exchange('GET', '/api/v1/mobile/canvas');
    W.canvases = null;
    const none = await exchange('GET', '/api/v1/mobile/canvas/proj_app');
    const missing = await exchange('GET', '/api/v1/mobile/canvas/nope');
    expect(project.response.status).toBe(200);
    expect(missing.response.status).toBe(404);
    fixtures.set('canvas-route.json', { project, app, none, missing });
  }, TEST_TIMEOUT_MS);

  it('chat snapshots and sessions', async () => {
    const live = await exchange('GET', '/api/v1/mobile/agents/durable_chat/chat');
    expect(live.response.body.chatControls).not.toBeNull();
    expect(live.response.body.slashCommands).toHaveLength(3);
    expect(JSON.stringify(live)).not.toContain('/Users/me');
    fixtures.set('chat-snapshot.json', live);
    const sleeping = await exchange('GET', '/api/v1/mobile/agents/durable_sleepy/chat');
    expect(sleeping.response.body.readOnly).toBe(true);
    fixtures.set('chat-snapshot-sleeping.json', sleeping);
    fixtures.set('chat-snapshot-errors.json', {
      agentNotFound: await exchange('GET', '/api/v1/mobile/agents/missing/chat'),
      invalidQuery: await exchange('GET', '/api/v1/mobile/agents/durable_chat/chat?limit=0'),
    });
    fixtures.set('chat-page.json', await exchange('GET', '/api/v1/mobile/agents/durable_chat/chat?beforeSeq=6&limit=2'));
    fixtures.set('chat-sessions.json', await exchange('GET', '/api/v1/mobile/agents/durable_chat/chat/sessions'));
  });

  it('agent state, for catching up after a reconnect', async () => {
    const state = await exchange('GET', '/api/v1/mobile/agents/state');
    const agents = state.response.body.agents as Array<{ agentId: string; status: string; sessionState: string | null }>;
    expect(agents.find((a) => a.agentId === 'durable_sleepy')).toMatchObject({ status: 'sleeping', sessionState: null });
    expect(agents.find((a) => a.agentId === 'durable_chat')?.sessionState).not.toBeNull();
    fixtures.set('agent-state.json', state);
  });

  it('a durable agent going to sleep', async () => {
    const ws = await connect();
    ws.send.mockClear();
    W.ptyExit.at(-1)!('durable_chat', 0);
    // pty:exit reaches the phone's terminal only; agent:status is what its agent list hears.
    fixtures.set('agent-sleep.json', { direction: 'desktop-to-phone', frames: frames(ws) });
  });

  it('create options and agent settings', async () => {
    fixtures.set('create-options.json', await exchange('GET', '/api/v1/mobile/projects/proj_app/create-options'));
    fixtures.set('create-options-errors.json', { projectNotFound: await exchange('GET', '/api/v1/mobile/projects/missing/create-options') });
    const settings = await exchange('GET', '/api/v1/mobile/agents/durable_sleepy/settings');
    expect(settings.response.body.details.changes).toMatchObject({ files: 2 });
    fixtures.set('agent-settings.json', settings);
    expect(settings.response.body).not.toHaveProperty('parentAgentId');
    fixtures.set('agent-settings-running.json', await exchange('GET', '/api/v1/mobile/agents/durable_chat/settings'));
    // A helper names its parent (#2618), which is how a phone knows Connect to Dispatcher doesn't apply.
    const helper = await exchange('GET', '/api/v1/mobile/agents/durable_docs/settings');
    expect(helper.response.body).toMatchObject({ parentAgentId: 'durable_chat', orchestration: { connectToDispatcher: false } });
    fixtures.set('agent-settings-helper.json', helper);
    fixtures.set('agent-settings-errors.json', { agentNotFound: await exchange('GET', '/api/v1/mobile/agents/missing/settings') });
    // Clubhouse MCP off for the agent (#2589): its switches read off, with the reason.
    W.durables[APP][0].mcpOverride = false;
    const mcpOff = await exchange('GET', '/api/v1/mobile/agents/durable_chat/settings');
    delete W.durables[APP][0].mcpOverride;
    expect(mcpOff.response.body.orchestration).toMatchObject({ mcpEnabled: false, orchestrate: false });
    fixtures.set('agent-settings-mcp-off.json', mcpOff);
  });

  describe('chat.question ids and the 1 MiB request body limit (#2676)', () => {
    const LIMIT = 1024 * 1024;
    const ROUTE = '/api/v1/mobile/commands';
    /** A command with these full-length ids, padded with answer text to `size` UTF-8 bytes if given. */
    const body = (ids: string[], size?: number) => {
      const request = { version: 1, epoch, commandId: `cmd_body_${ids.length}_${size ?? 0}_${ids[0].codePointAt(64000)}`, type: 'chat.question', agentId: 'durable_chat', sessionId: 'sess_live', requestId: 'q_1',
        answers: Object.fromEntries(ids.map((id) => [id, 'a'])) };
      if (size) request.answers[ids[0]] = 'a'.repeat(size - Buffer.byteLength(JSON.stringify(request)) + 1);
      return Buffer.from(JSON.stringify(request));
    };
    const ids = (unit: string, count: number) => Array.from({ length: count }, (_, i) => String(i).padStart(2, '0') + unit.repeat(Math.floor((65536 - 2) / unit.length)));
    const accepted = { status: 200, body: { status: 'completed' } };
    const refusal = () => ({ version: 1, epoch, status: 'rejected', error: { code: 'too_large', message: 'too_large' } });
    const refused = async (raw: Buffer) => {
      const reply = await send('POST', ROUTE, raw);
      expect(reply).toMatchObject({ status: 413, headers: { connection: 'close' } });
      expect(reply.body).toEqual(refusal());
    };
    const answered = () => vi.spyOn(getAgentRuntime('durable_chat') as unknown as { answerQuestion: () => Promise<void> }, 'answerQuestion');

    /**
     * What a phone sees on the wire: uploads over a raw mTLS socket, reading the
     * answer as it goes. `send` stops at `stopAt` bytes (default all) and honors
     * backpressure, so `sent` is how far the upload had got. A socket error is
     * kept, not thrown: past the drain bound the client can see one.
     */
    function upload(payload: Buffer | number, opts: { chunked?: boolean; stopAt?: number; closeOnAnswer?: boolean } = {}) {
      const total = typeof payload === 'number' ? payload : payload.length;
      const block = Buffer.alloc(64 * 1024, 'a');
      return new Promise<{ raw: string; sent: number; sentAtAnswer: number | null; socketError: string | null; closedBeforeAllSent: boolean }>((resolve) => {
        let raw = '';
        let sent = 0;
        let sentAtAnswer: number | null = null;
        let socketError: string | null = null;
        const stopAt = opts.stopAt ?? total;
        const socket = tls.connect({ host: '127.0.0.1', port, ...client, rejectUnauthorized: false }, () => {
          socket.write(`POST ${ROUTE} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n${opts.chunked ? 'Transfer-Encoding: chunked' : `Content-Length: ${total}`}\r\n\r\n`);
          pump();
        });
        const pump = () => {
          while (sent < stopAt && !socket.destroyed) {
            const size = Math.min(block.length, stopAt - sent);
            const part = typeof payload === 'number' ? block.subarray(0, size) : payload.subarray(sent, sent + size);
            sent += size;
            const framed = opts.chunked ? Buffer.concat([Buffer.from(`${size.toString(16)}\r\n`), part, Buffer.from('\r\n')]) : part;
            if (!socket.write(framed)) { socket.once('drain', pump); return; }
          }
          if (opts.chunked && sent >= stopAt && !socket.destroyed) socket.write('0\r\n\r\n');
        };
        socket.on('data', (data) => {
          sentAtAnswer ??= sent;
          raw += data.toString();
          if (opts.closeOnAnswer) socket.destroy();
        });
        socket.on('error', (err) => { socketError = err.message; });
        socket.on('close', () => resolve({ raw, sent, sentAtAnswer, socketError, closedBeforeAllSent: sent < stopAt }));
      });
    }
    /** The response head and body exactly as sent. Date changes every run, so it's left out. */
    const parsed = (raw: string) => {
      const [head, bytes] = raw.split('\r\n\r\n');
      const [statusLine, ...lines] = head.split('\r\n');
      return { statusLine, headers: Object.fromEntries(lines.map((l) => l.split(': ')).filter(([name]) => name !== 'Date')), bytes };
    };
    const onTheWire = () => {
      const bytes = JSON.stringify(refusal());
      return { statusLine: 'HTTP/1.1 413 Payload Too Large', headers: { 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bytes)), Connection: 'close' }, bytes };
    };

    it('takes exactly 1 MiB and refuses one byte more', async () => {
      const atLimit = body(ids('k', 15), LIMIT);
      expect(atLimit).toHaveLength(LIMIT);
      expect(await send('POST', ROUTE, atLimit)).toMatchObject(accepted);
      const over = body(ids('k', 15), LIMIT + 1);
      expect(over).toHaveLength(LIMIT + 1);
      await refused(over);
    });
    it('counts encoded bytes, not characters', async () => {
      const over = body(ids('€', 6));
      expect(over.toString()).not.toHaveLength(over.length);
      expect(over.toString().length).toBeLessThan(LIMIT);
      expect(over.length).toBeGreaterThan(LIMIT);
      await refused(over);
    });
    it('does not run a refused command or keep anything for it', async () => {
      const spy = answered();
      const named = (commandId: string) => ({ ...JSON.parse(body(ids('k', 15)).toString()), commandId });
      const pad = (request: Record<string, any>, bytes: number) => {
        const key = Object.keys(request.answers)[0];
        request.answers[key] = 'a'.repeat(request.answers[key].length + bytes - Buffer.byteLength(JSON.stringify(request)));
        const raw = Buffer.from(JSON.stringify(request));
        expect(raw).toHaveLength(bytes);
        return raw;
      };
      // The same command at the limit does run, so not running below means something.
      expect(await send('POST', ROUTE, pad(named('cmd_runs_at_limit'), LIMIT))).toMatchObject(accepted);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();

      const over = pad(named('cmd_refused'), LIMIT + 1);
      await refused(over);
      await refused(over);
      expect(parsed((await upload(over, { chunked: true })).raw)).toEqual(onTheWire());
      expect(spy).not.toHaveBeenCalled();
      // No receipt holds the id: different content under it runs, where a kept id would be command_conflict.
      const small = { version: 1, epoch, commandId: 'cmd_refused', type: 'chat.question', agentId: 'durable_chat', sessionId: 'sess_live', requestId: 'q_1', answers: { which: 'main' } };
      expect(await send('POST', ROUTE, small)).toMatchObject(accepted);
      expect(spy).toHaveBeenCalledTimes(1);
    });
    it('delivers the answer during an upload just over the limit, and reads the upload to its end', async () => {
      const over = body(ids('k', 15), LIMIT + 1);
      const result = await upload(over);
      expect(parsed(result.raw)).toEqual(onTheWire());
      expect(result).toMatchObject({ sent: over.length, socketError: null, closedBeforeAllSent: false });
      fixtures.set('command-too-large.json', {
        note: 'requestBytes replaces the request: a real one is over 1 MiB. bodyBytes is the response body exactly as sent; Date is left out. Epoch is the desktop\'s, there is no commandId, and no receipt is kept.',
        request: { method: 'POST', path: ROUTE, requestBytes: LIMIT + 1 },
        response: { status: 413, statusLine: 'HTTP/1.1 413 Payload Too Large', headers: parsed(result.raw).headers, body: refusal(), bodyBytes: parsed(result.raw).bytes },
      });
    });
    it('answers a chunked upload once it passes the limit, before it ends', async () => {
      const result = await upload(LIMIT * 4, { chunked: true });
      expect(parsed(result.raw)).toEqual(onTheWire());
      expect(result.sentAtAnswer).toBeLessThan(LIMIT * 4);
    });
    it('answers an upload over the drain bound, then closes before taking all of it', async () => {
      const total = 64 * LIMIT;
      const result = await upload(total);
      expect(parsed(result.raw)).toEqual(onTheWire());
      // Answered from Content-Length, long before the bound; closed well short of the whole upload.
      expect(result.sentAtAnswer).toBeLessThan(16 * LIMIT);
      expect(result.closedBeforeAllSent).toBe(true);
      expect(result.sent).toBeLessThan(total);
    });
    it('closes a stalled upload at the time bound, having answered at once', async () => {
      const realSetTimeout = globalThis.setTimeout;
      // Ten real seconds would only slow the suite; what's checked is that this delay is asked for and the socket closes on it.
      const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => realSetTimeout(fn, ms === 10_000 ? 200 : ms)) as typeof setTimeout);
      const result = await upload(4 * LIMIT, { stopAt: 64 * 1024 });
      expect(timers).toHaveBeenCalledWith(expect.any(Function), 10_000);
      expect(parsed(result.raw)).toEqual(onTheWire());
      expect(result.sent).toBe(64 * 1024);
    });
    it('stops draining when the client hangs up on the answer', async () => {
      const result = await upload(64 * LIMIT, { closeOnAnswer: true });
      expect(parsed(result.raw).statusLine).toBe('HTTP/1.1 413 Payload Too Large');
      expect(await send('POST', ROUTE, body(ids('k', 1)))).toMatchObject(accepted);
    });
    it.each([
      ['ASCII', 'k', 15],
      ['three-byte', '€', 5],
      ['four-byte', '😀', 7],
    ])('fits only so many full-length %s ids', async (_name, unit, most) => {
      const fits = ids(unit, most);
      for (const id of fits) expect(id).toHaveLength(65536);
      expect(await send('POST', ROUTE, body(fits))).toMatchObject(accepted);
      await refused(body(ids(unit, most + 1)));
    });
    it('always fits one full-length id, even when every character is escaped in JSON', async () => {
      const raw = body([`\u0001`.repeat(65536)]);
      expect(raw.length).toBeLessThan(LIMIT);
      expect(await send('POST', ROUTE, raw)).toMatchObject(accepted);
    });
  });

  it('chat commands', async () => {
    const chat = { agentId: 'durable_chat', sessionId: 'sess_live' };
    await command('accepted', { type: 'chat.send', ...chat, text: 'Run the tests', delivery: 'auto' });
    await command('accepted queued', { type: 'chat.send', ...chat, text: 'Then the linter', delivery: 'queued' });
    await command('session_mismatch', { type: 'chat.send', ...chat, sessionId: 'sess_stale', text: 'hi' });
    await command('not_chat', { type: 'chat.send', agentId: 'durable_sleepy', sessionId: 'sess_old', text: 'hi' });
    await command('agent_not_found', { type: 'chat.send', agentId: 'missing', sessionId: 's', text: 'hi' });
    W.revert.add('durable_chat');
    await command('revert_in_progress', { type: 'chat.send', ...chat, text: 'hi' });
    W.revert.clear();
    await command('images_not_supported', { type: 'chat.send', agentId: 'durable_basic', sessionId: 'sess_basic', text: '', attachmentIds: ['att_x'] });
    await command('attachment_unavailable', { type: 'chat.send', ...chat, text: '', attachmentIds: ['not-uploaded'] });
    await command('invalid_command (empty text without images)', { type: 'chat.send', ...chat, text: '' });

    await command('accepted', { type: 'chat.interrupt', ...chat });
    await command('not_chat', { type: 'chat.interrupt', agentId: 'durable_sleepy', sessionId: 'sess_old' });

    await command('accepted', { type: 'chat.queue.remove', ...chat, messageIds: ['msg_q'] });
    await command('queue_removal_not_supported', { type: 'chat.queue.remove', agentId: 'durable_basic', sessionId: 'sess_basic', messageIds: ['msg_q'] });

    await command('accepted', { type: 'chat.permission', ...chat, requestId: 'perm_1', optionId: 'allow' });
    await command('accepted persistent option', { type: 'chat.permission', ...chat, requestId: 'perm_1', optionId: 'always' });
    await command('pending_request_not_found', { type: 'chat.permission', ...chat, requestId: 'perm_gone', optionId: 'allow' });

    await command('accepted', { type: 'chat.question', ...chat, requestId: 'q_1', answers: { which: 'main' } });
    await command('accepted multiple choices', { type: 'chat.question', ...chat, requestId: 'q_1', answers: { which: ['main', 'dev'] } });
    await command('pending_request_not_found', { type: 'chat.question', ...chat, requestId: 'q_gone', answers: { which: 'main' } });
    // A Claude question's id is its text. Its own commandId keeps the numbering of the fixtures after it.
    const longId = `  Long question ${'x'.repeat(349 - 19)}?  `;
    const shorterId = `Shorter question é ${'y'.repeat(212 - 20)}?`;
    expect([longId.length, shorterId.length]).toEqual([349, 212]);
    await command('accepted long question ids', { type: 'chat.question', ...chat, requestId: 'q_1', answers: { [longId]: 'main', [shorterId]: ['main', 'dev'] } }, { commandId: 'cmd_long_questions' });

    await command('accepted switch', { type: 'chat.setModel', ...chat, model: 'sonnet' });
    await command('accepted effort', { type: 'chat.setModel', ...chat, model: 'opus', effort: 'low' });
    await command('unchanged', { type: 'chat.setModel', ...chat, model: 'opus' });
    await command('unknown_model', { type: 'chat.setModel', ...chat, model: 'gpt-9' });
    await command('unknown_effort', { type: 'chat.setModel', ...chat, model: 'opus', effort: 'max' });
    await command('effort_default_not_supported', { type: 'chat.setModel', ...chat, model: 'opus', effort: null });
    await command('model_switch_not_supported', { type: 'chat.setModel', agentId: 'durable_basic', sessionId: 'sess_basic', model: 'o3' });
    await command('effort_switch_not_supported', { type: 'chat.setModel', agentId: 'durable_basic', sessionId: 'sess_basic', model: 'gpt-5', effort: 'high' });

    await command('accepted', { type: 'chat.setLevel', ...chat, level: 'full_access' });
    await command('unchanged', { type: 'chat.setLevel', ...chat, level: 'ask' });
    await command('level_not_live', { type: 'chat.setLevel', ...chat, level: 'auto' });
    await command('level_switch_not_supported', { type: 'chat.setLevel', agentId: 'durable_basic', sessionId: 'sess_basic', level: 'plan' });
    await command('invalid_command (unknown level)', { type: 'chat.setLevel', ...chat, level: 'yolo' });
  });

  it('agent commands', async () => {
    await command('accepted', { type: 'agent.start', agentId: 'durable_sleepy', message: 'Pick up where you left off', resume: true });
    // The phone's Wake: resume the last session, no first message.
    await command('accepted wake', { type: 'agent.start', agentId: 'durable_sleepy', resume: true });
    await command('agent_already_running', { type: 'agent.start', agentId: 'durable_chat' });
    await command('agent_not_found', { type: 'agent.start', agentId: 'missing' });
    await command('accepted', { type: 'agent.stop', agentId: 'durable_term' });
    await command('agent_not_found', { type: 'agent.stop', agentId: 'missing' });
    await command('accepted', { type: 'agent.spawn', projectId: 'proj_app', prompt: 'Fix the flaky test', model: 'sonnet', orchestrator: 'claude-code' });
    await command('project_not_found', { type: 'agent.spawn', projectId: 'missing', prompt: 'x' });
    annexServer._testing.trackedQuickAgents.delete('quick_new');

    const create = { type: 'agent.create', projectId: 'proj_app', name: 'calm-otter', color: 'emerald' };
    await command('accepted', { ...create, orchestrator: 'claude-code', model: 'opus', persona: 'qa', freeAgentMode: true, useWorktree: true, mcpIds: ['github'], branchFrom: 'main' });
    await command('accepted minimal', { ...create, name: 'quiet-wren' });
    await command('accepted with folder and branch', { ...create, name: 'calm-otter', folderName: 'otter', branchName: 'feature/otter', useWorktree: true });
    await command('project_not_found', { ...create, projectId: 'missing' });
    await command('invalid_name', { ...create, name: 'bad..name' });
    await command('invalid_color', { ...create, color: 'chartreuse' });
    await command('not_git_repo', { ...create, projectId: 'proj_docs', useWorktree: true });
    await command('worktree_options_require_worktree', { ...create, useWorktree: false, branchName: 'feature/x' });
    await command('invalid_folder_name', { ...create, folderName: 'bad..folder' });
    await command('invalid_branch_name', { ...create, branchName: 'bad..branch' });
    await command('orchestrator_unavailable', { ...create, orchestrator: 'copilot-cli' });
    await command('free_agent_mode_unavailable', { ...create, orchestrator: 'codex-cli', freeAgentMode: true });
    await command('unknown_persona', { ...create, persona: 'pirate' });
    await command('unknown_mcp', { ...create, mcpIds: ['jira'] });
    await command('create_refused', { ...create, name: 'taken' });
    await command('invalid_command (unknown field)', { ...create, instructions: 'be nice' });
    await command('accepted with orchestration', { ...create, name: 'lead-otter', orchestration: { orchestrate: true, control: 'ask-before-start', maxHelpers: 4 } });
    await command('invalid_orchestration (maxHelpers above the cap)', { ...create, orchestration: { maxHelpers: 21 } });
    await command('invalid_orchestration (clear on create)', { ...create, orchestration: { access: null } });
    await command('invalid_command (orchestration null)', { ...create, orchestration: null });
    W.durables[APP] = W.durables[APP].filter((d) => d.id !== 'durable_created');

    await command('accepted', { type: 'agent.update', agentId: 'durable_sleepy', name: 'bright-otter', color: 'rose', emoji: '🦦', model: 'sonnet', persona: 'architect', freeAgentMode: true, runtime: 'chat', idleSleep: 30 });
    await command('accepted clear', { type: 'agent.update', agentId: 'durable_sleepy', emoji: null, persona: null, runtime: 'default', idleSleep: 'inherit' });
    await command('accepted orchestrator', { type: 'agent.update', agentId: 'durable_sleepy', orchestrator: 'claude-code' });
    await command('accepted while running (idleSleep)', { type: 'agent.update', agentId: 'durable_chat', idleSleep: 'never' });
    await command('agent_not_found', { type: 'agent.update', agentId: 'missing', idleSleep: 30 });
    await command('agent_running', { type: 'agent.update', agentId: 'durable_chat', name: 'renamed' });
    await command('agent_creating', { type: 'agent.update', agentId: 'durable_fresh', name: 'renamed' });
    await command('invalid_name', { type: 'agent.update', agentId: 'durable_sleepy', name: 'bad..name' });
    await command('orchestrator_unavailable', { type: 'agent.update', agentId: 'durable_sleepy', orchestrator: 'copilot-cli' });
    await command('runtime_unavailable', { type: 'agent.update', agentId: 'durable_sleepy', orchestrator: 'codex-cli', runtime: 'chat' });
    await command('free_agent_mode_unavailable', { type: 'agent.update', agentId: 'durable_sleepy', orchestrator: 'codex-cli', freeAgentMode: true });
    await command('clubhouse_mode_unavailable', { type: 'agent.update', agentId: 'durable_sleepy', clubhouseMode: true });
    await command('unknown_persona', { type: 'agent.update', agentId: 'durable_sleepy', persona: 'pirate' });
    await command('invalid_color', { type: 'agent.update', agentId: 'durable_sleepy', color: 'chartreuse' });
    await command('invalid_command (no settings)', { type: 'agent.update', agentId: 'durable_sleepy' });
    await command('invalid_command (unknown field)', { type: 'agent.update', agentId: 'durable_sleepy', instructions: 'be nice' });

    // Orchestration (#2228): changes while the agent runs, as on the Orchestration card.
    const chatPolicy = { ...W.durables[APP][0].orchestration };
    await command('accepted orchestration', { type: 'agent.update', agentId: 'durable_chat', orchestration: { access: 'auto', control: 'ask-everything', maxHelpers: 20 } });
    await command('accepted orchestration clear field', { type: 'agent.update', agentId: 'durable_chat', orchestration: { maxHelpers: null } });
    await command('accepted orchestration clear all', { type: 'agent.update', agentId: 'durable_sleepy', orchestration: null });
    await command('invalid_orchestration (maxHelpers above the cap)', { type: 'agent.update', agentId: 'durable_chat', orchestration: { maxHelpers: 21 } });
    await command('invalid_orchestration (control)', { type: 'agent.update', agentId: 'durable_chat', orchestration: { control: 'yolo' } });
    await command('invalid_orchestration (unknown field)', { type: 'agent.update', agentId: 'durable_chat', orchestration: { helpers: 2 } });
    await command('orchestration_has_helpers', { type: 'agent.update', agentId: 'durable_chat', orchestration: { orchestrate: false } });
    await command('invalid_command (orchestration not an object)', { type: 'agent.update', agentId: 'durable_chat', orchestration: 'on' });
    W.durables[APP][0].orchestration = chatPolicy;
  });

  it('project, finished quick agent and helper commands', async () => {
    await command('accepted', { type: 'project.setPinned', projectId: 'proj_docs', pinned: true });
    await command('accepted unpin', { type: 'project.setPinned', projectId: 'proj_docs', pinned: false });
    await command('project_not_found', { type: 'project.setPinned', projectId: 'missing', pinned: true });
    await command('accepted', { type: 'project.setInactive', projectId: 'proj_docs', inactive: true });
    await command('accepted mark active', { type: 'project.setInactive', projectId: 'proj_docs', inactive: false });
    await command('project_pinned', { type: 'project.setInactive', projectId: 'proj_app', inactive: true });
    W.projectStateReady = false;
    await command('project_state_unavailable', { type: 'project.setPinned', projectId: 'proj_app', pinned: false });
    await command('project_state_unavailable', { type: 'project.setInactive', projectId: 'proj_app', inactive: false });
    W.projectStateReady = true;

    await command('accepted', { type: 'quick.dismiss', projectId: 'proj_app', agentId: 'quick_done' });
    await command('accepted not listed', { type: 'quick.dismiss', projectId: 'proj_app', agentId: 'quick_unknown' });
    await command('project_not_found', { type: 'quick.dismiss', projectId: 'missing', agentId: 'quick_done' });
    await command('accepted', { type: 'quick.clear', projectId: 'proj_app' });
    await command('project_not_found', { type: 'quick.clear', projectId: 'missing' });
    W.finishedReady = false;
    await command('finished_quick_agents_unavailable', { type: 'quick.dismiss', projectId: 'proj_app', agentId: 'quick_done' });
    await command('finished_quick_agents_unavailable', { type: 'quick.clear', projectId: 'proj_app' });
    W.finishedReady = true;

    await command('accepted start', { type: 'helper.approve', requestId: helperStart() });
    W.helperStart = 'blocked';
    await command('helper_start_blocked', { type: 'helper.approve', requestId: helperStart() });
    _resetStartRequestsForTesting({ keepListeners: true });
    W.helperStart = 'refused';
    await command('helper_start_refused', { type: 'helper.approve', requestId: helperStart() });
    // Definite, and the request is used up: a phone shows the sentence and offers no retry (#2671).
    W.helperStart = 'no_valid_mapping';
    const held = helperStart();
    const removal = await connect();
    removal.send.mockClear();
    const NO_MAPPING_MESSAGE = 'Couldn’t start impl-ipc because no hard preset for codex-cli is offered now. Change it in Settings > Helpers.';
    const noMapping = await command('no_valid_mapping', { type: 'helper.approve', requestId: held }, { commandId: 'cmd_no_mapping' });
    expect(noMapping).toEqual({ status: 409, body: {
      version: 1, commandId: 'cmd_no_mapping', epoch, status: 'rejected', error: { code: 'no_valid_mapping', message: NO_MAPPING_MESSAGE },
    } });
    // A fresh snapshot takes the row away, whichever arrives first.
    await eventually(() => {
      const snapshot = frames(removal).filter((f) => f.type === 'snapshot').at(-1);
      expect(snapshot?.payload.helperRequests.map((r: { requestId: string }) => r.requestId)).not.toContain(held);
    });
    expect(W.helperStartRefusals).toBe(1);
    // The same command again gets the same receipt, and the start isn't tried twice.
    const replay = await command('no_valid_mapping (same commandId replays the receipt)', { type: 'helper.approve', requestId: held }, { commandId: 'cmd_no_mapping' });
    expect(replay).toEqual(noMapping);
    expect(W.helperStartRefusals).toBe(1);
    // A new command finds nothing to approve, so nothing can be created twice.
    const again = await command('helper_request_not_found (consumed, new commandId)', { type: 'helper.approve', requestId: held }, { commandId: 'cmd_no_mapping_again' });
    expect(again).toMatchObject({ status: 404, body: { commandId: 'cmd_no_mapping_again', status: 'rejected', error: { code: 'helper_request_not_found' } } });
    expect(W.helperStartRefusals).toBe(1);
    W.helperStart = 'approve';
    await command('accepted dispose anyway', { type: 'helper.approve', requestId: helperDispose(), force: true });
    await command('accepted dispose (nothing at risk)', { type: 'helper.approve', requestId: helperDispose({ dirty: 0, unpushed: 0, unmerged: 3 }, false) });
    await command('helper_work_at_risk', { type: 'helper.approve', requestId: helperDispose() });
    _resetDisposeRequestsForTesting();
    await command('helper_check_failed', { type: 'helper.approve', requestId: helperDispose({ dirty: 0, unpushed: 0, unmerged: null, error: 'git status failed' }, false) });
    _resetDisposeRequestsForTesting();
    W.dispose = { ok: false, changed: true, message: 'Docs has new work.', checks: { dirty: 3, unpushed: 1, unmerged: 0 }, stopped: true };
    await command('helper_work_changed', { type: 'helper.approve', requestId: helperDispose(), force: true });
    _resetDisposeRequestsForTesting();
    W.dispose = { ok: false, message: 'Couldn’t remove the worktree.', stopped: true };
    await command('helper_dispose_failed', { type: 'helper.approve', requestId: helperDispose(), force: true });
    _resetDisposeRequestsForTesting();
    W.dispose = { ok: true, stopped: true };
    await command('helper_request_not_found', { type: 'helper.approve', requestId: 'hstart_gone' });

    await command('accepted start', { type: 'helper.decline', requestId: helperStart() });
    await command('accepted dispose', { type: 'helper.decline', requestId: helperDispose() });
    await command('helper_request_not_found', { type: 'helper.decline', requestId: 'hdispose_gone' });
  });

  it('errors common to every command', async () => {
    const base = { type: 'agent.stop', agentId: 'durable_term' };
    await command('common:invalid_command (unknown type)', { type: 'agent.teleport', agentId: 'durable_term' });
    await command('common:invalid_command (unknown field)', { ...base, extra: true });
    await command('common:invalid_command (wrong field type)', { type: 'project.setPinned', projectId: 'proj_app', pinned: 'yes' });
    await command('common:unsupported_version', base, { version: 2 });
    await command('common:epoch_mismatch', base, { epoch: 'previous-epoch' });
    await command('common:retry returns the first receipt', base, { commandId: 'cmd_retry' });
    await command('common:retry returns the first receipt', base, { commandId: 'cmd_retry' });
    await command('common:command_conflict', { ...base, agentId: 'durable_chat' }, { commandId: 'cmd_retry' });
    const bearer = await send('POST', '/api/v1/mobile/commands', { version: 1, epoch, commandId: 'cmd_bearer', ...base }, { client: null, headers: { Authorization: `Bearer ${bearerToken}` } });
    commandFixtures.get('_common')!.push({ name: 'client_certificate_required (bearer token, no client certificate)', request: { version: 1, epoch, commandId: 'cmd_bearer', ...base }, response: { status: bearer.status, body: bearer.body } });
    // Capacity is 2048 receipts; the same service with room for none answers as a full one does.
    const full = new MobileCommandService(Date.now, 0);
    const capacity = await full.execute('peer', { version: 1, epoch: full.epoch, commandId: 'cmd_full', ...base }, async () => ({}));
    commandFixtures.get('_common')!.push({ name: 'command_capacity (MobileCommandService at capacity)', request: { version: 1, epoch: full.epoch, commandId: 'cmd_full', ...base }, response: { status: capacity.statusCode, body: capacity.body } });
  });

  it('chat events: one of every type, then each form of routed, as the WebSocket sends them', async () => {
    const ws = await connect();
    const turn = { turnId: 'turn_2' };
    const samples: Record<string, [Record<string, unknown>, Record<string, unknown>?]> = {
      session_started: [{ driver: 'claude_agent_sdk', provider: 'claude-code', cwd: '/work/app/.clubhouse/agents/planner', resumed: true, nativeSessionId: 'native-live', cliVersion: '2.1.0', model: 'opus', level: 'ask', capabilities: CHAT_CAPS }],
      session_info: [{ nativeSessionId: 'native-live', title: 'Wire the IPC', cliVersion: '2.1.0', model: null, models: [{ id: 'opus', label: 'Opus' }], efforts: ['low', 'high'], levelNames: { ask: 'default' }, mcpServers: [{ name: 'github', status: 'needs_auth' }], capabilities: { images: true } }],
      session_state: [{ state: 'running' }],
      session_ended: [{ reason: 'process_exit', exitCode: 1, message: 'CLI exited' }],
      turn_started: [{ trigger: 'prompt', nativeTurnId: 'native-turn' }, turn],
      turn_ended: [{ stopReason: 'end_turn', durationMs: 4200, usage: { input: 1000, output: 200 }, costUsd: 0.02 }, turn],
      user_message: [{ messageId: 'msg_10', clientCommandId: 'cmd_photo', source: 'annex', delivery: 'steer', queuedWith: 'msg_9', content: [
        { type: 'text', text: 'Like this?' },
        { type: 'image', mimeType: 'image/jpeg', path: '/Users/me/Library/Application Support/Clubhouse/chat-attachments/durable_chat/p.jpg', mediaRef: `${'cd'.repeat(32)}.jpg`, width: 640, height: 480 },
        { type: 'resource', uri: 'file:///work/app/README.md', mimeType: 'text/markdown', text: '# App' },
        { type: 'file', path: 'src/main.ts' },
      ] }, turn],
      queue_removed: [{ messageIds: ['msg_q'] }],
      queue_state: [{ queuedMessageIds: [], transition: { messageIds: ['msg_q'], status: 'dispatching' } }],
      agent_message_chunk: [{ messageId: 'amsg_2', text: 'Look', subagentId: 'sub_1' }, turn],
      agent_message: [{ messageId: 'amsg_2', text: 'Looks good. See `src/main.ts:12`.' }, turn],
      agent_thought_chunk: [{ messageId: 'th_1', text: 'Considering' }, turn],
      agent_thought: [{ messageId: 'th_1', text: 'Considering the options', durationMs: 900 }, turn],
      tool_call: [{ toolCallId: 'tool_2', kind: 'read', title: 'Screenshot', status: 'completed', toolName: 'mcp__browser__screenshot', locations: [{ path: 'src/main.ts', line: 12 }],
        content: [{ type: 'text', text: 'Captured' }, { type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }, { type: 'terminal', command: 'ls', cwd: '/work/app', output: 'a.ts\n', exitCode: 0 }],
        media: [{ type: 'image', mimeType: 'image/png', mediaRef: MEDIA_REF, width: 800, height: 600, sourcePath: '/work/app/shot.png' }], mediaOnly: false }, turn],
      tool_call_update: [{ toolCallId: 'tool_2', status: 'completed', title: 'Screenshot', contentMode: 'append', content: [{ type: 'text', text: 'done' }],
        media: [{ type: 'image', mimeType: 'image/png', mediaRef: `${'ef'.repeat(32)}.png`, width: 10, height: 10 }, { type: 'image', mimeType: 'image/png', unavailable: true }], rawOutput: { ok: true }, durationMs: 1200, error: undefined }, turn],
      permission_request: [{ requestId: 'perm_2', title: 'Edit src/a.ts', description: 'src/a.ts', content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }], toolCallId: 'tool_3', toolName: 'Edit', options: PERMISSION_OPTIONS }, turn],
      permission_resolved: [{ requestId: 'perm_2', optionId: 'allow', decision: 'allow', by: 'annex' }, turn],
      question: [{ requestId: 'q_2', questions: [{ id: 'name', prompt: 'Name it?', allowFreeText: true }], routedTo: { agentId: 'durable_chat', name: 'planner' } }, turn],
      question_resolved: [{ requestId: 'q_2', answers: { name: 'otter' } }, turn],
      plan: [{ entries: [{ id: 'p1', content: 'Write tests', status: 'completed', priority: 'high' }, { content: 'Ship', status: 'pending' }] }, turn],
      plan_document: [{ planId: 'plan_1', markdown: '# Plan\n\n1. Tests', status: 'ready', toolCallId: 'tool_4' }, turn],
      subagent: [{ subagentId: 'sub_1', name: 'Explore', description: 'Find usages', status: 'completed', parentToolCallId: 'tool_5', toolCount: 4, usage: { input: 100, output: 20 } }, turn],
      usage: [{ scope: 'turn', tokens: { input: 1000, cachedInput: 800, cacheWrite: 100, output: 200, reasoning: 50, total: 1200 }, costUsd: 0.01, costIsEstimate: true,
        context: { used: 272000, size: 400000, window: 'input' }, limits: [{ window: '5h', utilization: 0.42, resetsAt: NOW + 3_600_000 }, { window: 'week', status: 'warning' }] }],
      mode_changed: [{ level: 'auto_edit', nativeMode: 'acceptEdits' }],
      model_changed: [{ modelId: 'sonnet', effort: 'medium', effortIsDefault: true }],
      commands_available: [{ commands: [{ name: 'compact', description: 'Compact the context', startOnly: true }, { name: 'review', inputHint: '<pr>' }] }],
      workspace_changed: [{ reason: 'vcs', vcsKind: 'commit', branch: 'planner/standby' }],
      notice: [{ level: 'info', code: 'compaction_in_progress', message: 'Compacting the conversation' }],
      error: [{ code: 'rate_limited', message: 'Rate limited', fatal: false, willRetry: true }],
      protocol_unknown: [{ driver: 'claude_agent_sdk', kind: 'notification', name: 'future/thing' }],
    };
    expect(Object.keys(samples).sort()).toEqual([...CHAT_EVENT_TYPES].sort());
    ws.send.mockClear();
    let seq = 100;
    for (const type of CHAT_EVENT_TYPES) {
      const [data, extra] = samples[type];
      publishChatEvent(envelope(++seq, type, JSON.parse(JSON.stringify(data)), extra));
    }
    // Messages from other agents and Clubhouse (#2605): content is what the agent received, routed is who sent what.
    const routedMessages: Array<{ messageId: string; text: string; routed: Array<Record<string, unknown>> }> = [
      { messageId: 'msg_routed_one', text: '[FROM:Docs@App] The docs are up to date.',
        routed: [{ sender: { agentId: 'durable_docs', name: 'Docs' }, text: 'The docs are up to date.' }] },
      { messageId: 'msg_routed_burst', text: '2 updates, oldest first:\n\n--- 1 of 2 ---\n[FROM:Docs@App] Started on the guide.\n\n--- 2 of 2 ---\n[FROM:reviewer@App] The tests pass.',
        routed: [{ sender: { agentId: 'durable_docs', name: 'Docs' }, text: 'Started on the guide.' }, { sender: { name: 'reviewer' }, text: 'The tests pass.' }] },
      { messageId: 'msg_routed_clubhouse', text: '[Clubhouse] Docs was disposed.',
        routed: [{ fromClubhouse: true, text: 'Docs was disposed.' }] },
      { messageId: 'msg_routed_no_sender', text: 'The nightly build finished.',
        routed: [{ text: 'The nightly build finished.' }] },
    ];
    for (const { messageId, text, routed } of routedMessages) {
      publishChatEvent(envelope(++seq, 'user_message', { messageId, source: 'mcp', delivery: 'prompt', content: [{ type: 'text', text }], routed }, turn));
    }
    const chat = frames(ws).filter((f) => f.type === 'chat:event');
    expect(chat.map((f) => f.payload.event.type)).toEqual([...CHAT_EVENT_TYPES, ...routedMessages.map(() => 'user_message')]);
    expect(chat.slice(-routedMessages.length).map((f) => f.payload.event.data.routed)).toEqual(routedMessages.map((m) => m.routed));
    expect(JSON.stringify(chat)).not.toContain('/Users/me');
    fixtures.set('chat-events.json', { direction: 'desktop-to-phone', frames: chat });
  });

  it('terminal (pty:*) messages', async () => {
    const ws = await connect();
    const other = await connect();
    const bearer = await connect('bearer');
    const cases: Array<{ name: string; request?: object; replies: unknown[] }> = [];
    const step = async (name: string, socket: FakeWs, frame: object, count = 1) => { cases.push({ name, request: frame, replies: await roundTrip(socket, frame, count) }); };
    await step('spawn project shell', ws, { type: 'pty:spawn-shell', payload: { sessionId: 'shell_1', projectId: 'proj_app' } });
    await step('spawn agent worktree shell', ws, { type: 'pty:spawn-shell', payload: { sessionId: 'shell_2', projectId: 'proj_app', agentId: 'durable_sleepy' } });
    await step('spawn: invalid_session_id', ws, { type: 'pty:spawn-shell', payload: { projectId: 'proj_app' } });
    await step('spawn: project_not_found', ws, { type: 'pty:spawn-shell', payload: { sessionId: 'shell_3', projectId: 'missing' } });
    await step('spawn: agent_not_found', ws, { type: 'pty:spawn-shell', payload: { sessionId: 'shell_3', projectId: 'proj_app', agentId: 'missing' } });
    await step('spawn: session_in_use', other, { type: 'pty:spawn-shell', payload: { sessionId: 'durable_term', projectId: 'proj_app' } });
    W.spawnShellError = 'cwd_invalid';
    await step('spawn: spawn error text', ws, { type: 'pty:spawn-shell', payload: { sessionId: 'shell_3', projectId: 'proj_app' } });
    W.spawnShellError = null;
    W.projectsThrow = true;
    await step('spawn: internal_error', ws, { type: 'pty:spawn-shell', payload: { sessionId: 'shell_3', projectId: 'proj_app' } });
    W.projectsThrow = false;
    for (let i = 3; i <= 8; i++) await roundTrip(ws, { type: 'pty:spawn-shell', payload: { sessionId: `shell_${i}`, projectId: 'proj_app' } });
    await step('spawn: too_many_shells', ws, { type: 'pty:spawn-shell', payload: { sessionId: 'shell_9', projectId: 'proj_app' } });
    await step('input', ws, { type: 'pty:input', payload: { agentId: 'shell_1', data: 'ls\r' } }, 0);
    await step('resize', ws, { type: 'pty:resize', payload: { agentId: 'shell_1', cols: 80, rows: 24 } }, 0);
    await step('input: session_not_found', other, { type: 'pty:input', payload: { agentId: 'shell_1', data: 'ls\r' } });
    await step('resize: session_not_found', other, { type: 'pty:resize', payload: { agentId: 'shell_1', cols: 80, rows: 24 } });
    await step('input: too long', ws, { type: 'pty:input', payload: { agentId: 'shell_1', data: 'x'.repeat(65537) } });
    cases[cases.length - 1].request = { type: 'pty:input', payload: { agentId: 'shell_1', data: '<65537 × "x">' } };
    // Shell output and exit go only to the connection that owns the shell.
    ws.send.mockClear(); other.send.mockClear();
    W.ptyData.at(-1)!('shell_1', 'a.ts\r\nb.ts\r\n', 12);
    W.ptyExit.at(-1)!('shell_2', 0);
    expect(other.send).not.toHaveBeenCalled();
    cases.push({ name: 'shell output and exit (owner only, no seq)', replies: frames(ws) });
    // Agent PTY output is broadcast to every controller, with a replay seq.
    ws.send.mockClear();
    W.ptyData.at(-1)!('durable_term', 'npm test\r\n', 52);
    W.ptyExit.at(-1)!('durable_term', 0);
    cases.push({ name: 'agent output and exit (broadcast)', replies: frames(ws) });
    W.running.add('durable_term');
    await step('close', ws, { type: 'pty:close', payload: { sessionId: 'shell_1' } });
    await step('close: session_not_found', other, { type: 'pty:close', payload: { sessionId: 'shell_3' } });
    await step('attach', ws, { type: 'pty:attach', payload: { agentId: 'durable_term' } });
    await step('attach: agent_not_terminal', ws, { type: 'pty:attach', payload: { agentId: 'durable_chat' } });
    await step('attach: agent_not_running', ws, { type: 'pty:attach', payload: { agentId: 'durable_sleepy' } });
    await step('attach: agent_not_found', ws, { type: 'pty:attach', payload: {} });
    await step('bearer connection refused', bearer, { type: 'pty:spawn-shell', payload: { sessionId: 'shell_b', projectId: 'proj_app' } });
    fixtures.set('pty.json', { cases });
  });

  it('replay', async () => {
    const ws = await connect();
    const before = eventReplay.getLastSeq();
    publishChatEvent(envelope(200, 'agent_message', { messageId: 'amsg_r', text: 'replayed' }));
    const replay = await roundTrip(ws, { type: 'mobile:replay', epoch, since: before }, 3);
    const gap = await roundTrip(ws, { type: 'mobile:replay', epoch: 'previous-epoch', since: before });
    const ahead = await roundTrip(ws, { type: 'mobile:replay', epoch, since: before + 1000 });
    const renumber = (list: any[]) => renumberFrames(list, before);
    fixtures.set('replay.json', {
      note: 'Sequence numbers are renumbered so the cursor sent is 1000.',
      cases: [
        { name: 'replay', request: { type: 'mobile:replay', epoch, since: 1000 }, replies: renumber(replay) },
        { name: 'gap: stale epoch', request: { type: 'mobile:replay', epoch: 'previous-epoch', since: 1000 }, replies: renumber(gap) },
        { name: 'gap: cursor ahead of lastSeq', request: { type: 'mobile:replay', epoch, since: 2000 }, replies: renumber(ahead) },
      ],
    });
  });

  it('attachments', async () => {
    // Staging prunes files by their real age; nothing here records a time.
    vi.mocked(Date.now).mockRestore();
    const route = '/api/v1/mobile/agents/durable_chat/attachments';
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x04, 0x9b, 0, 0, 0x09, 0xfc, 8, 6, 0, 0, 0]);
    const cases: Array<{ name: string; request: object; response: Reply }> = [];
    const upload = async (name: string, body: Buffer | object, headers: Record<string, string>, opts: { route?: string; client?: null; bearer?: boolean } = {}) => {
      const res = await send('POST', opts.route ?? route, body, { headers: opts.bearer ? { ...headers, Authorization: `Bearer ${bearerToken}` } : headers, client: opts.client });
      cases.push({ name, request: { method: 'POST', path: opts.route ?? route, headers, body: Buffer.isBuffer(body) ? `<${body.length} bytes>` : body },
        response: { status: res.status, body: res.body, ...(res.headers?.['retry-after'] && { headers: { 'retry-after': res.headers['retry-after'] } }) } });
      return res;
    };
    const uploaded = await upload('accepted', png, { 'Content-Type': 'image/png' });
    expect(uploaded.body.attachmentId).toBeTruthy();
    await upload('accepted (octet-stream, sniffed)', png, { 'Content-Type': 'application/octet-stream' });
    await upload('accepted without dimensions', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]), { 'Content-Type': 'image/jpeg' });
    await command('accepted with images', { type: 'chat.send', agentId: 'durable_chat', sessionId: 'sess_live', text: '', attachmentIds: [uploaded.body.attachmentId] });
    await upload('empty_body', Buffer.alloc(0), { 'Content-Type': 'image/png' });
    await upload('unsupported_media_type', { base64: 'x' }, { 'Content-Type': 'application/json' });
    await upload('unsupported_image', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { 'Content-Type': 'image/png' });
    await upload('agent_not_found', png, { 'Content-Type': 'image/png' }, { route: '/api/v1/mobile/agents/missing/attachments' });
    await upload('not_chat', png, { 'Content-Type': 'image/png' }, { route: '/api/v1/mobile/agents/durable_sleepy/attachments' });
    await upload('images_not_supported', png, { 'Content-Type': 'image/png' }, { route: '/api/v1/mobile/agents/durable_basic/attachments' });
    await upload('client_certificate_required (bearer token, no client certificate)', png, { 'Content-Type': 'image/png', Authorization: 'Bearer <token>' }, { client: null, bearer: true });
    const tooLarge = await new Promise<Reply>((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port, path: route, method: 'POST', ...client, rejectUnauthorized: false, agent: false,
        headers: { 'Content-Type': 'image/png', 'Content-Length': '3932161' } }, (res) => {
        let data = ''; res.on('data', (c) => { data += c; });
        res.on('end', () => { resolve({ status: res.statusCode!, body: JSON.parse(data) }); req.destroy(); });
      }); req.on('error', reject); req.flushHeaders();
    });
    cases.push({ name: 'too_large', request: { method: 'POST', path: route, headers: { 'Content-Type': 'image/png', 'Content-Length': '3932161' } }, response: tooLarge });
    let limited: Reply | undefined;
    for (let i = 0; i < 30 && !limited; i++) {
      const res = await send('POST', route, png, { headers: { 'Content-Type': 'image/png' } });
      if (res.status === 429) limited = res;
    }
    expect(limited).toBeDefined();
    cases.push({ name: 'rate_limited', request: { method: 'POST', path: route, headers: { 'Content-Type': 'image/png' }, body: `<${png.length} bytes>` },
      response: { status: limited!.status, body: limited!.body, headers: { 'retry-after': '<seconds>' } } });
    fixtures.set('attachments.json', { cases });
  });

  it('the Dispatcher (#2533)', async () => {
    const off = { type: 'dispatcher.setEnabled', enabled: true };
    await command('dispatcher_flag_off', off);
    W.dispatcher.flagOn = true;
    W.dispatcher.newLayout = false;
    await command('dispatcher_layout_off', off);
    W.dispatcher.newLayout = true;
    // Off: its id answers nothing, and nothing connects to it.
    const routes: Record<string, unknown> = {
      offChat: await exchange('GET', '/api/v1/mobile/agents/durable_dispatcher/chat'),
      offSettings: await exchange('GET', '/api/v1/mobile/agents/durable_dispatcher/settings'),
    };
    await command('dispatcher_off', { type: 'agent.start', agentId: 'durable_dispatcher' });
    await command('dispatcher_off', { type: 'agent.update', agentId: 'durable_dispatcher', model: 'sonnet' });
    await command('dispatcher_off (connectToDispatcher)', { type: 'agent.update', agentId: 'durable_chat', orchestration: { connectToDispatcher: true } });

    const ws = await connect();
    ws.send.mockClear();
    const on = await command('accepted', { type: 'dispatcher.setEnabled', enabled: true });
    expect(on.body.result).toEqual({ enabled: true, flagOn: true, agentId: 'durable_dispatcher' });
    await eventually(() => expect(frames(ws).some((f) => f.type === 'snapshot')).toBe(true));
    const changedOn = frames(ws).find((f) => f.type === 'dispatcher:changed');
    const snapshot = frames(ws).find((f) => f.type === 'snapshot').payload;
    expect(snapshot.dispatcher.agent).toMatchObject({ id: 'durable_dispatcher', projectId: '__dispatcher__', isDispatcher: true });
    expect(Object.values(snapshot.agents).flat().some((a: any) => a.id === 'durable_dispatcher')).toBe(false);
    await command('accepted unchanged', { type: 'dispatcher.setEnabled', enabled: true });
    const state = await exchange('GET', '/api/v1/mobile/agents/state');
    fixtures.set('snapshot-dispatcher.json', { direction: 'desktop-to-phone', field: 'dispatcher', value: snapshot.dispatcher,
      agentStateRow: state.response.body.agents.find((a: any) => a.agentId === 'durable_dispatcher') });

    // On: the usual agent routes and commands, with Settings > Dispatcher's rules.
    const settings = await exchange('GET', '/api/v1/mobile/agents/durable_dispatcher/settings');
    expect(settings.response.body).toMatchObject({ isDispatcher: true, orchestration: null, details: { changes: null } });
    fixtures.set('agent-settings-dispatcher.json', settings);
    routes.chat = await exchange('GET', '/api/v1/mobile/agents/durable_dispatcher/chat');
    routes.chatSessions = await exchange('GET', '/api/v1/mobile/agents/durable_dispatcher/chat/sessions');
    routes.git = await exchange('GET', '/api/v1/projects/__dispatcher__/git/info');
    routes.shell = { request: { type: 'pty:spawn-shell', payload: { sessionId: 'shell_dispatch', projectId: '__dispatcher__', agentId: 'durable_dispatcher' } },
      replies: await roundTrip(ws, { type: 'pty:spawn-shell', payload: { sessionId: 'shell_dispatch', projectId: '__dispatcher__', agentId: 'durable_dispatcher' } }) };
    await roundTrip(ws, { type: 'pty:close', payload: { sessionId: 'shell_dispatch' } });

    await command('accepted (Dispatcher)', { type: 'agent.update', agentId: 'durable_dispatcher', model: 'sonnet', idleSleep: 30, freeAgentMode: false });
    await command('accepted orchestrator (Dispatcher, model back to default)', { type: 'agent.update', agentId: 'durable_dispatcher', orchestrator: 'codex-cli' });
    await command('invalid_model (Dispatcher)', { type: 'agent.update', agentId: 'durable_dispatcher', model: 'opus' });
    await command('dispatcher_locked (name)', { type: 'agent.update', agentId: 'durable_dispatcher', name: 'Boss' });
    await command('dispatcher_locked (persona)', { type: 'agent.update', agentId: 'durable_dispatcher', persona: 'qa' });
    await command('dispatcher_locked (orchestration)', { type: 'agent.update', agentId: 'durable_dispatcher', orchestration: { orchestrate: true } });
    await command('accepted (Dispatcher)', { type: 'agent.start', agentId: 'durable_dispatcher', resume: true });
    await command('accepted (Dispatcher)', { type: 'agent.stop', agentId: 'durable_dispatcher' });
    await command('dispatcher_locked', { type: 'agent.create', projectId: '__dispatcher__', name: 'second', color: 'indigo' });
    await command('dispatcher_locked', { type: 'agent.spawn', projectId: '__dispatcher__', prompt: 'x' });
    const chatPolicy = { ...W.durables[APP][0].orchestration };
    await command('accepted cross-project and Dispatcher', { type: 'agent.update', agentId: 'durable_chat', orchestration: { crossProjectHelpers: true, connectToDispatcher: true } });
    W.durables[APP][0].orchestration = chatPolicy;

    ws.send.mockClear();
    await command('accepted off', { type: 'dispatcher.setEnabled', enabled: false });
    // A refresh from before the switch can still be on its way: wait for the one after it.
    await eventually(() => expect(frames(ws).some((f) => f.type === 'snapshot' && f.payload.dispatcher === null)).toBe(true));
    const changedOff = frames(ws).find((f) => f.type === 'dispatcher:changed');
    const seq = (f: any) => ({ ...f, seq: 1000 });
    fixtures.set('dispatcher-changed.json', { direction: 'desktop-to-phone', note: 'seq is the replay sequence; a snapshot follows each.', frames: [seq(changedOn), seq(changedOff)] });
    fixtures.set('dispatcher-routes.json', routes);
    W.dispatcher = { flagOn: false, enabled: false, newLayout: true };
    W.durables[DISPATCHER_PATH][0] = { ...W.durables[DISPATCHER_PATH][0], model: undefined, orchestrator: 'claude-code' };
  });

  it('serves the Dispatcher\'s image, which is in no project, only while it is on (#2645)', async () => {
    const route = '/api/v1/icons/agent/durable_dispatcher';
    const saved = W.durables[DISPATCHER_PATH][0];
    W.durables[DISPATCHER_PATH][0] = { ...saved, icon: 'durable_dispatcher.abc.png' };
    W.dispatcher = { flagOn: true, enabled: true, newLayout: true };
    expect((await send('GET', route)).status).toBe(200);
    W.dispatcher = { flagOn: false, enabled: false, newLayout: true };
    expect((await send('GET', route)).status).toBe(404);
    W.durables[DISPATCHER_PATH][0] = saved;
  });

  it('sender identity: every kind of sender, drawn from the snapshot alone', async () => {
    resetWorld();
    W.dispatcher = { flagOn: true, enabled: true, newLayout: true };
    W.durables[DISPATCHER_PATH][0] = { ...W.durables[DISPATCHER_PATH][0], icon: 'durable_dispatcher.abc.png' };
    // A disposed helper keeps its config row; a helper in another project shares a name with one here.
    W.durables[APP].push({ id: 'durable_gone', name: 'old-helper', color: 'rose', parentAgentId: 'durable_chat', disposedAt: '2026-10-09T09:00:00.000Z', createdAt: '2026-10-08T09:00:00.000Z' });
    W.durables['/work/docs'] = [{ id: 'durable_cross', name: 'Docs', color: 'orange', parentAgentId: 'durable_chat', createdAt: '2026-10-08T09:00:00.000Z' }];
    const part = (agentId: string | undefined, name: string, text: string) => ({ sender: { ...(agentId && { agentId }), name }, text });
    const messages: Array<Record<string, unknown> & { messageId: string; text: string; source?: string }> = [
      { messageId: 'top_level', text: '[FROM:brave-otter@App] Ready.', routed: [part('durable_sleepy', 'brave-otter', 'Ready.')] },
      { messageId: 'emoji_over_image', text: '[FROM:planner@App] Go.', routed: [part('durable_chat', 'planner', 'Go.')] },
      { messageId: 'helper', text: '[FROM HELPER:Docs (durable_docs)] Halfway.', routed: [part('durable_docs', 'Docs', 'Halfway.')] },
      { messageId: 'dispatcher_image', text: '[FROM:Dispatcher] Status?', routed: [part('durable_dispatcher', 'Dispatcher', 'Status?')] },
      { messageId: 'cross_project', text: '[FROM HELPER:Docs (durable_cross)] Done there.', routed: [part('durable_cross', 'Docs', 'Done there.')] },
      { messageId: 'quick_agent', text: '[FROM:swift-fox@App] Fixed.', routed: [part('quick_1', 'swift-fox', 'Fixed.')] },
      { messageId: 'disposed_helper', text: '[FROM HELPER:old-helper (durable_gone)] Bye.', routed: [part('durable_gone', 'old-helper', 'Bye.')] },
      { messageId: 'unknown_id_same_name', text: '[FROM:reviewer@Gone] Old id.', routed: [part('durable_deleted', 'reviewer', 'Old id.')] },
      { messageId: 'name_only_unique', text: '[FROM:reviewer@App] By name.', routed: [part(undefined, 'reviewer', 'By name.')] },
      { messageId: 'name_only_ambiguous', text: '[FROM:Docs@App] Which one?', routed: [part(undefined, 'Docs', 'Which one?')] },
      { messageId: 'burst', text: '2 updates, oldest first:\n\n--- 1 of 2 ---\n[FROM HELPER:Docs (durable_docs)] Started.\n\n--- 2 of 2 ---\n[Clubhouse] Docs is asleep.',
        routed: [part('durable_docs', 'Docs', 'Started.'), { fromClubhouse: true, text: 'Docs is asleep.' }] },
      { messageId: 'queue_first', delivery: 'queued', text: '[FROM HELPER:Docs (durable_docs)] One.', routed: [part('durable_docs', 'Docs', 'One.')] },
      { messageId: 'queue_joined', delivery: 'queued', queuedWith: 'queue_first', text: '[FROM:brave-otter@App] Two.', routed: [part('durable_sleepy', 'brave-otter', 'Two.')] },
      { messageId: 'task_result_marker', text: '[TASK:t_1] [FROM:reviewer@App] TASK_RESULT:t_1: Looks good.', routed: [part('durable_basic', 'reviewer', 'TASK_RESULT:t_1: Looks good.')] },
      { messageId: 'clubhouse_notice', text: '[Clubhouse] Docs was disposed.', routed: [{ fromClubhouse: true, text: 'Docs was disposed.' }] },
      { messageId: 'no_sender', text: 'The nightly build finished.', routed: [{ text: 'The nightly build finished.' }] },
      // Older transcripts and deliveries with no routed.
      { messageId: 'parsed_from', text: '[TASK:t_2] [FROM:reviewer@App] An old one.' },
      { messageId: 'parsed_helper', text: '[FROM HELPER:Docs (durable_docs)] An old report.' },
      { messageId: 'parsed_clubhouse', text: '[Clubhouse] An old notice.' },
      { messageId: 'parsed_tap', source: 'shoulder_tap', text: 'Group Project notification — shoulder tap from "brave-otter@App" in "Team"\nLook at this.\n\n---\nRESPONSE INSTRUCTIONS:\nReply on the board.' },
      { messageId: 'parsed_tap_user', source: 'shoulder_tap', text: 'Group Project notification — shoulder tap from "user" in "Team"\nFrom the desktop.\n\n---\nRESPONSE INSTRUCTIONS:\nReply on the board.' },
      { messageId: 'system', source: 'system', text: 'Continued from the terminal.' },
      { messageId: 'group_project', source: 'group_project', text: 'New bulletin posts.' },
      { messageId: 'mission_from_user', source: 'mission', text: 'Fix the login bug.' },
      { messageId: 'from_a_phone', source: 'annex', text: '[FROM:x] Typed by the user.' },
    ];
    const ws = await connect();
    const catalog = frames(ws).find((f) => f.type === 'snapshot').payload;
    const before = eventReplay.getLastSeq();
    ws.send.mockClear();
    const events = messages.map(({ messageId, text, source = 'mcp', ...rest }, i) => envelope(i + 1, 'user_message',
      { messageId, source, delivery: 'prompt', content: [{ type: 'text', text }], ...rest }));
    for (const event of events) publishChatEvent(event);
    const live = frames(ws).filter((f) => f.type === 'chat:event');
    expect(live).toHaveLength(events.length);

    // What the desktop's own code draws, given only the snapshot's rows and the event.
    const rows: any[] = [...Object.values(catalog.agents).flat(), ...Object.values(catalog.quickAgents).flat(), catalog.dispatcher.agent];
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    const expected = events.map((event: any) => {
      const { messageId, source, content, routed } = event.data;
      const display = messageDisplay({ source, text: content[0].text, routed });
      if (display.from === 'you') return { messageId, from: 'you', text: display.text };
      return { messageId, from: 'others', ...(event.data.queuedWith && { queuedWith: event.data.queuedWith }), parts: display.parts.map((sent) => {
        const agent = findSenderAgent(sent.sender, byId);
        const subject = agent ?? sent.sender;
        return { name: sentPartName(sent, source, agent), agentId: agent?.id ?? null, text: sent.text,
          avatar: subject ? agentAvatarSpec(subject, agent && catalog.agentIcons[agent.id]) : null };
      }) };
    });
    const first = (id: string) => expected.find((e) => e.messageId === id)!.parts![0];
    expect(first('top_level')).toMatchObject({ agentId: 'durable_sleepy', avatar: { type: 'initials', initials: 'BO', background: '#f59e0b' } });
    expect(first('emoji_over_image').avatar).toEqual({ type: 'emoji', emoji: '🦊', background: '#6366f120' });
    expect(first('helper').avatar).toEqual({ type: 'initials', initials: 'D', background: '#8b5cf6' });
    expect(first('dispatcher_image').avatar).toEqual({ type: 'image', image: catalog.agentIcons.durable_dispatcher });
    expect(first('cross_project')).toMatchObject({ agentId: 'durable_cross', avatar: { background: '#f97316' } });
    expect(first('quick_agent').avatar).toEqual({ type: 'quick' });
    expect(first('disposed_helper')).toEqual({ name: 'old-helper', agentId: null, text: 'Bye.', avatar: { type: 'initials', initials: 'OH', background: '#6366f1' } });
    expect(first('unknown_id_same_name')).toMatchObject({ agentId: null, avatar: { initials: 'R', background: '#6366f1' } });
    expect(first('name_only_unique')).toMatchObject({ agentId: 'durable_basic', avatar: { background: '#14b8a6' } });
    expect(first('name_only_ambiguous')).toMatchObject({ agentId: null, avatar: { background: '#6366f1' } });
    expect(first('task_result_marker').text).toBe('Looks good.');
    expect(first('clubhouse_notice')).toMatchObject({ name: 'Clubhouse', avatar: null });
    expect(first('no_sender')).toMatchObject({ name: 'Another agent', avatar: null });
    expect(first('parsed_helper').agentId).toBe('durable_docs');
    expect(first('group_project')).toMatchObject({ name: 'Group project', avatar: null });

    // Restored history and replay carry the same parts as the live event.
    const routedOf = (list: any[]) => list.filter((e) => e.type === 'user_message').map((e) => e.data.routed);
    W.transcripts.durable_sleepy = events.map((event) => ({ ...event, agentId: 'durable_sleepy', sessionId: 'sess_old' })) as never;
    const history = await exchange('GET', '/api/v1/mobile/agents/durable_sleepy/chat');
    expect(routedOf(history.response.body.events)).toEqual(routedOf(events));
    const replay = await roundTrip(ws, { type: 'mobile:replay', epoch, since: before }, events.length + 2);
    expect(routedOf(replay.filter((f) => f.type === 'chat:event').map((f) => f.payload.event))).toEqual(routedOf(events));

    fixtures.set('sender-identity.json', {
      direction: 'desktop-to-phone',
      note: 'Resolve each frame\'s sender from `catalog` alone; `expected` is what the desktop draws for that event.',
      catalog: { agents: catalog.agents, quickAgents: catalog.quickAgents, dispatcher: catalog.dispatcher, agentIcons: catalog.agentIcons },
      colors: AGENT_COLORS.map(({ id, hex }) => ({ id, hex, initialsText: initialsTextColor(hex) })),
      initials: ['Dispatcher', 'clever-fox', 'Clubhouse-Orchestrator', 'one-two-three', 'my_agent', 'Two Words', 'double--dash', '7-up', '🦊-fox']
        .map((name) => ({ name, initials: agentInitials(name) })),
      frames: renumberFrames(live, before),
      expected,
      history,
      replay: renumberFrames(replay, before),
    });
    resetWorld();
  });

  it('queued bursts, from the real runtime: delivery sends no user_message (#2414, #2605)', async () => {
    const part = (agentId: string, name: string, text: string) => [{ sender: { agentId, name }, text }];
    // `drained`: this turn_ended sends the next queued message, and the wait includes that send's result.
    type Turn = (type: 'turn_started' | 'turn_ended', drained?: 'delivered' | 'failed', trigger?: 'prompt' | 'system') => Promise<void>;
    const run = async (name: string, caps: ChatCapabilities, script: (turn: Turn, driver: FakeChatDriver, runtime: ChatAgentRuntime) => Promise<void>) => {
      const seen: ChatEvent[] = [];
      const off = onChatEvent((event) => { if (event.agentId === `durable_${name}`) seen.push(event); });
      let n = 0;
      const driver = new FakeChatDriver('copilot_acp', 'copilot-cli', caps);
      const runtime = new ChatAgentRuntime({
        agentId: `durable_${name}`, provider: 'copilot-cli', driverId: driver.id, cwd: APP, level: 'ask', idleTimeoutMs: 0,
        startSession: () => driver.start({ agentId: `durable_${name}`, provider: 'copilot-cli', cwd: APP, binaryPath: '/bin/copilot', level: 'ask' }),
        newId: () => `${name}_${++n}`, now: () => NOW, onEnded: () => {},
      });
      await runtime.start();
      const turn: Turn = async (type, drained, trigger = 'prompt') => {
        const from = seen.length;
        driver.last.emit(type === 'turn_started' ? { type, data: { trigger } } : { type, data: { stopReason: 'end_turn' } });
        await eventually(() => {
          const since = seen.slice(from);
          expect(since.some((e) => e.type === type)).toBe(true);
          if (drained) expect(since.some((e) => e.type === 'queue_state' && e.data.transition.status === drained)).toBe(true);
          // The state changes just after the event, and whether a send queues depends on it.
          if (type === 'turn_started') expect(runtime.getState()).toBe('running');
        });
      };
      await script(turn, driver, runtime);
      off();
      return seen.filter((e) => ['user_message', 'queue_state', 'queue_removed', 'turn_started', 'turn_ended'].includes(e.type));
    };
    const steerless = { ...MINIMAL_CHAT_CAPABILITIES, steer: false, queue: 'client' as const, interrupt: true };

    const burst = await run('burst', steerless, async (turn, _driver, runtime) => {
      await turn('turn_started');
      await runtime.sendMessage('[FROM HELPER:Docs (durable_docs)] One.', { source: 'mcp', routed: part('durable_docs', 'Docs', 'One.') });
      await runtime.sendMessage('[FROM:brave-otter@App] Two.', { source: 'mcp', routed: part('durable_sleepy', 'brave-otter', 'Two.') });
      await runtime.sendMessage('And another thing.', { source: 'annex' });
      await turn('turn_ended', 'delivered');
      await turn('turn_started');
      await turn('turn_ended', 'delivered');
      await turn('turn_started');
      await turn('turn_ended');
    });
    const users = burst.filter((e): e is Extract<ChatEvent, { type: 'user_message' }> => e.type === 'user_message');
    expect(users.map((e) => [e.data.source, e.data.delivery, e.data.queuedWith])).toEqual([['mcp', 'queued', undefined], ['mcp', 'queued', users[0].data.messageId], ['annex', 'queued', undefined]]);
    const lastUser = burst.indexOf(users[2]);
    const statuses = burst.slice(lastUser + 1).filter((e) => e.type === 'queue_state').map((e) => [(e.data as any).transition.status, (e.data as any).transition.messageIds, (e.data as any).queuedMessageIds]);
    expect(statuses).toEqual([
      ['queued', [users[2].data.messageId], [users[0].data.messageId, users[2].data.messageId]],
      ['dispatching', [users[0].data.messageId], [users[2].data.messageId]],
      ['delivered', [users[0].data.messageId], [users[2].data.messageId]],
      ['dispatching', [users[2].data.messageId], []],
      ['delivered', [users[2].data.messageId], []],
    ]);

    const failed = await run('failed', steerless, async (turn, driver, runtime) => {
      await turn('turn_started');
      await runtime.sendMessage('Never sent.', { source: 'annex' });
      driver.last.send = async () => { throw new Error('driver refused'); };
      await turn('turn_ended', 'failed');
    });
    expect(failed.filter((e) => e.type === 'queue_state').map((e) => (e.data as any).transition.status)).toEqual(['queued', 'dispatching', 'failed']);

    const native = await run('native', { ...steerless, queue: 'native' }, async (turn, _driver, runtime) => {
      await turn('turn_started');
      await runtime.sendMessage('Held by the CLI.', { source: 'annex', delivery: 'queued' });
      await turn('turn_ended');
      await turn('turn_started');
    });
    expect(native.some((e) => e.type === 'queue_state')).toBe(false);
    expect(native.find((e) => e.type === 'user_message')?.data).toMatchObject({ delivery: 'queued' });

    const systemTurn = await run('system', { ...steerless, queue: 'native' }, async (turn, _driver, runtime) => {
      await turn('turn_started');
      await runtime.sendMessage('Held through the compaction.', { source: 'annex', delivery: 'queued' });
      await turn('turn_ended');
      await turn('turn_started', undefined, 'system');
      await turn('turn_ended');
      await turn('turn_started');
    });
    const held = systemTurn.find((e): e is Extract<ChatEvent, { type: 'user_message' }> => e.type === 'user_message')!;
    expect(systemTurn.filter((e) => e.type === 'turn_started').map((e) => (e.data as any).trigger)).toEqual(['prompt', 'system', 'prompt']);
    expect(systemTurn.some((e) => e.type === 'queue_state')).toBe(false);

    fixtures.set('queued-bursts.json', {
      direction: 'desktop-to-phone',
      note: 'Events from the real chat runtime, without the session and state events around them. See docs/mobile-control-v1.md#queued-messages.',
      burst: { events: burst, rowId: users[0].data.messageId, routed: [...users[0].data.routed!, ...users[1].data.routed!] },
      missingJoinTarget: {
        note: 'The burst read from its tail: the join is the first event, so the row takes the queuedWith id.',
        events: burst.slice(burst.indexOf(users[1])), rowId: users[0].data.messageId, routed: users[1].data.routed,
      },
      failed: { events: failed },
      nativeQueue: { note: 'A provider-held queue has no queue_state: turn_started is its only signal.', events: native },
      systemTurn: {
        note: 'A trigger: system turn consumes no row. rowId stays queued through it, and the last turn_started, which is not system, delivers it.',
        events: systemTurn, rowId: held.data.messageId,
      },
    });
  });

  it('Clubhouse MCP off refuses turning orchestration on (#2589)', async () => {
    W.durables[APP][0].mcpOverride = false;
    await command('mcp_off', { type: 'agent.update', agentId: 'durable_chat', orchestration: { orchestrate: true } });
    delete W.durables[APP][0].mcpOverride;
  });

  it('helper presets (#2671)', async () => {
    // Quota and serverTime are read from the clock, and the file has to be the same on every run.
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const level = (id: string, label: string, efforts: string[] = ['low', 'medium', 'high']) => ({ id, label, efforts });
    const claude = (source: 'live' | 'fallback' = 'live', models = [level('opus', 'Opus'), level('sonnet', 'Sonnet'), level('haiku', 'Haiku')]) =>
      ({ models, source, via: source === 'live' ? 'handshake' : 'static', fetchedAt: NOW });
    const codex = (models = [level('gpt-6.1-sol', 'Sol'), level('gpt-6.1-terra', 'Terra'), level('gpt-6-luna', 'Luna')]) =>
      ({ models, source: 'live', via: 'handshake', fetchedAt: NOW });
    const lists: Record<string, unknown> = { 'claude-code': claude(), 'codex-cli': codex() };
    // What each CLI says about its limits: a healthy plan unless a case says otherwise.
    const inDays = (days: number) => NOW + days * 86_400_000;
    const plan = (usedPercent: number, extra: object = {}) => ({ kind: 'windows', windows: [
      { name: 'week', usedPercent, resetsAt: inDays(3), asOf: NOW, ...extra },
      { name: '5h', usedPercent: 12, resetsAt: inDays(0.1), asOf: NOW },
    ] });
    const quotas: Record<string, () => Promise<unknown>> = { 'claude-code': async () => plan(41), 'codex-cli': async () => plan(41) };
    W.providers = Object.fromEntries(['claude-code', 'codex-cli', 'copilot-cli'].map((id) => [id, {
      id,
      checkAvailability: async () => ({ available: true }),
      ...(id !== 'copilot-cli' && { listModels: async () => lists[id], readPlanQuota: () => quotas[id]() }),
    }]));
    const ROUTE = '/api/v1/mobile/helper-routing';
    const FAMILIES = ['reason', 'fallback', 'skipped', 'quota', 'unknown', 'window', 'autoSource', 'autoOff', 'cell', 'generic'];
    const cell = (res: Awaited<ReturnType<typeof exchange>>, provider: string, difficulty: string) => res.response.body.providers[provider].cells[difficulty];

    // A bare read has every label family, so a phone can cache them once per revision.
    const bare = await exchange('GET', ROUTE);
    expect(Object.keys(bare.response.body.labels)).toEqual(FAMILIES);
    expect(cell(bare, 'codex-cli', 'hard')).toMatchObject({ effective: { model: 'gpt-6.1-sol', effort: 'high' }, source: 'builtin', state: 'valid', custom: null });
    expect(bare.response.body.providers['copilot-cli']).toEqual({
      autoEligible: false, reason: 'auto_not_supported', cells: null, quota: { state: 'unknown', unknownReason: 'not_supported', source: 'none', asOf: null },
    });
    const revision = bare.response.body.revision;
    const cases: Record<string, unknown> = { bare };
    cases.project = await exchange('GET', `${ROUTE}?projectId=proj_app`);
    expect(Object.keys((cases.project as typeof bare).response.body.labels)).toEqual(FAMILIES);
    cases.agent = await exchange('GET', `${ROUTE}?agentId=durable_chat`);
    W.durables[APP][0].mcpOverride = false;
    cases.mcpOff = await exchange('GET', `${ROUTE}?agentId=durable_chat`);
    expect((cases.mcpOff as typeof bare).response.body.agent).toEqual({ usable: false, reason: 'mcp_off' });
    delete W.durables[APP][0].mcpOverride;
    cases.orchestrationOff = await exchange('GET', `${ROUTE}?agentId=durable_sleepy`);
    W.dispatcher.flagOn = true;
    W.dispatcher.enabled = true;
    W.dispatcher.newLayout = true;
    cases.dispatcher = await exchange('GET', `${ROUTE}?agentId=durable_dispatcher`);
    expect((cases.dispatcher as typeof bare).response.body.agent).toEqual({ usable: false, reason: 'dispatcher_locked' });
    W.dispatcher.enabled = false;
    cases.agentNotFound = await exchange('GET', `${ROUTE}?agentId=missing`);
    cases.projectNotFound = await exchange('GET', `${ROUTE}?projectId=missing`);

    // A saved choice no longer offered: the built-in is used, and it says so. Nothing is rewritten.
    W.presets = { 'codex-cli': { hard: { model: 'gone', effort: 'high' } } };
    cases.stalePreset = await exchange('GET', ROUTE);
    expect(cell(cases.stalePreset as typeof bare, 'codex-cli', 'hard')).toMatchObject({ state: 'stale', staleReason: 'model_unavailable', fallback: 'builtin_preset', source: 'builtin', effective: { model: 'gpt-6.1-sol' }, custom: { model: 'gone' } });
    W.presets = { 'codex-cli': { hard: { model: 'gpt-6.1-sol', effort: 'ultra' } } };
    cases.staleEffort = await exchange('GET', ROUTE);
    expect(cell(cases.staleEffort as typeof bare, 'codex-cli', 'hard')).toMatchObject({ state: 'stale', staleReason: 'effort_unavailable', effective: { effort: 'high' } });
    // Nothing valid left: a start is refused with no_valid_mapping.
    W.presets = {};
    lists['codex-cli'] = codex([level('gpt-6.1-terra', 'Terra'), level('gpt-6-luna', 'Luna')]);
    cases.staleNothingValid = await exchange('GET', ROUTE);
    expect(cell(cases.staleNothingValid as typeof bare, 'codex-cli', 'hard')).toMatchObject({ state: 'stale', effective: null });
    lists['codex-cli'] = codex();
    // A list that may be out of date: usable, and it says so.
    lists['claude-code'] = claude('fallback', [level('sonnet', 'Sonnet')]);
    cases.unverified = await exchange('GET', ROUTE);
    expect(cell(cases.unverified as typeof bare, 'claude-code', 'hard')).toMatchObject({ state: 'unverified', fallback: 'model_unverified', effective: { model: 'opus' } });
    lists['claude-code'] = claude();
    fixtures.set('helper-routing.json', cases);

    // Changing them: a write returns fresh values, and a changed event tells open pages.
    const ws = await connect();
    ws.send.mockClear();
    const fresh = (await exchange('GET', ROUTE)).response.body.revision;
    const write = (fields: Record<string, unknown>) => ({ type: 'helperRouting.update', scope: 'app', ...fields });
    const set = await command('accepted set', write({ revision: fresh, cells: [{ provider: 'codex-cli', difficulty: 'easy', model: 'gpt-6.1-terra', effort: 'low' }] }));
    expect(set.status).toBe(200);
    expect(set.body.result.providers['codex-cli'].cells.easy).toMatchObject({ source: 'custom', effective: { model: 'gpt-6.1-terra' } });
    const changed = frames(ws).filter((f) => f.type === 'helper_routing:changed');
    expect(changed.at(-1).payload).toEqual({ revision: set.body.result.revision });
    fixtures.set('helper-routing-changed.json', { direction: 'desktop-to-phone', frames: [changed.at(-1)] });
    // Fresh values come back with the refusal, and nothing is written. A client doesn't retry.
    const stale = await command('helper_routing_stale', write({ revision: fresh, cells: [{ provider: 'codex-cli', difficulty: 'easy', model: 'gpt-6-luna', effort: 'low' }] }));
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'helper_routing_stale' }, revision: set.body.result.revision, settings: { revision: set.body.result.revision } } });
    expect(W.presets['codex-cli'].easy.model).toBe('gpt-6.1-terra');
    const current = set.body.result.revision;
    await command('model_unavailable', write({ revision: current, cells: [{ provider: 'codex-cli', difficulty: 'easy', model: 'gone', effort: 'low' }] }));
    await command('effort_unavailable', write({ revision: current, cells: [{ provider: 'codex-cli', difficulty: 'easy', model: 'gpt-6-luna', effort: 'ultra' }] }));
    await command('invalid_helper_routing (Copilot)', write({ revision: current, cells: [{ provider: 'copilot-cli', difficulty: 'easy', model: 'x', effort: null }] }));
    await command('invalid_helper_routing (project scope)', { type: 'helperRouting.update', scope: 'project', revision: current, reset: {} });
    await command('invalid_command (nothing to do)', write({ revision: current }));
    const cellReset = await command('accepted reset one cell', write({ revision: current, reset: { provider: 'codex-cli', difficulty: 'easy' } }));
    expect(W.presets).toEqual({});
    const again = await command('accepted set several', write({ revision: cellReset.body.result.revision, cells: [
      { provider: 'claude-code', difficulty: 'hard', model: 'sonnet', effort: 'high' }, { provider: 'codex-cli', difficulty: 'medium', model: 'gpt-6-luna', effort: null },
    ] }));
    const providerReset = await command('accepted reset one provider', write({ revision: again.body.result.revision, reset: { provider: 'claude-code' } }));
    await command('accepted reset all', write({ revision: providerReset.body.result.revision, reset: {} }));
    expect(W.presets).toEqual({});
    expect(revision).toMatch(/^r\d+\.\d+$/);

    // What a helper's start decided: codes in the snapshot, words in its settings.
    const docs = W.durables[APP].find((a: { id: string }) => a.id === 'durable_docs')!;
    const decision = (fields: Record<string, unknown>) => ({
      mode: 'preset', balanced: false, decidedAt: new Date(NOW).toISOString(), policyVersion: 1, fallback: 'none', context: { status: 'none' }, ...fields,
    });
    const field = (provider: string | null, model: string | null, effort: string | null, difficulty: string | null) => ({ provider, model, effort, difficulty });
    const routed: Record<string, unknown> = {
      preset: decision({
        requested: field(null, null, null, 'hard'), resolved: field('codex-cli', 'gpt-6.1-sol', 'high', 'hard'),
        source: { provider: 'orchestrator', model: 'builtin_mapping', effort: 'builtin_mapping' }, reason: 'preset_on_cli',
      }),
      explicitOverride: decision({
        mode: 'explicit', requested: field('codex-cli', 'gpt-6.1-sol', 'high', null), resolved: field('codex-cli', 'gpt-6.1-sol', 'high', null),
        source: { provider: 'request', model: 'request', effort: 'request' }, reason: 'explicit_request',
      }),
      personaPin: decision({
        requested: field(null, null, null, 'easy'), resolved: field('claude-code', 'opus', null, 'easy'),
        source: { provider: 'persona', model: 'persona', effort: 'cli_default' }, reason: 'persona_pinned',
      }),
      builtinFallback: decision({
        requested: field(null, null, null, 'hard'), resolved: field('codex-cli', 'gpt-6.1-sol', 'high', 'hard'),
        source: { provider: 'orchestrator', model: 'builtin_mapping', effort: 'builtin_mapping' }, reason: 'preset_on_cli', fallback: 'builtin_preset',
      }),
      contextReset: decision({
        requested: field(null, null, null, 'easy'), resolved: field('claude-code', 'haiku', 'low', 'easy'),
        source: { provider: 'orchestrator', model: 'builtin_mapping', effort: 'builtin_mapping' }, reason: 'preset_on_cli', context: { status: 'reset' },
      }),
      contextNotApplied: decision({
        requested: field(null, null, null, 'easy'), resolved: field('claude-code', 'haiku', 'low', 'easy'),
        source: { provider: 'orchestrator', model: 'builtin_mapping', effort: 'builtin_mapping' }, reason: 'preset_on_cli', context: { status: 'not_applied' },
      }),
    };
    const settings: Record<string, unknown> = {};
    for (const [name, routing] of Object.entries(routed)) {
      docs.routing = routing;
      settings[name] = (await exchange('GET', '/api/v1/mobile/agents/durable_docs/settings')).response.body.routing;
    }
    docs.routing = routed.preset;
    const snapshotWs = await connect();
    const snapshot = frames(snapshotWs).find((f) => f.type === 'snapshot').payload;
    const row = snapshot.agents.proj_app.find((a: { id: string }) => a.id === 'durable_docs').routing;
    expect(row).toEqual({ mode: 'preset', difficulty: 'hard', provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high', reason: 'preset_on_cli' });
    expect(snapshot.helperRoutingRevision).toMatch(/^r\d+\.\d+$/);
    delete docs.routing;

    // Each quota state, as a phone reads it. Only the provider's row differs.
    const quotaOf = async (read: () => Promise<unknown>) => {
      _resetProviderQuotaForTesting();
      quotas['codex-cli'] = read;
      const res = await exchange('GET', ROUTE);
      return res.response.body.providers['codex-cli'].quota;
    };
    const quotaCases: Record<string, any> = {
      known: await quotaOf(async () => plan(41)),
      low: await quotaOf(async () => plan(85)),
      nearLimit: await quotaOf(async () => plan(96)),
      exhausted: await quotaOf(async () => plan(96, { limitReached: true })),
      fiveHourLimiting: await quotaOf(async () => ({ kind: 'windows', windows: [
        { name: 'week', usedPercent: 41, resetsAt: inDays(3), asOf: NOW }, { name: '5h', usedPercent: 88, resetsAt: inDays(0.1), asOf: NOW },
      ] })),
      oneWindowUnreadable: await quotaOf(async () => ({ kind: 'windows', windows: [
        { name: 'week', usedPercent: 41, resetsAt: inDays(3), asOf: NOW }, { name: '5h', asOf: NOW },
      ] })),
      noFiveHourWindow: await quotaOf(async () => ({ kind: 'windows', windows: [{ name: 'week', usedPercent: 41, resetsAt: inDays(3), asOf: NOW }] })),
      modelWindow: await quotaOf(async () => ({ kind: 'windows', windows: [
        { name: 'week', usedPercent: 41, resetsAt: inDays(3), asOf: NOW }, { name: 'week:Fable', usedPercent: 99, resetsAt: inDays(3), asOf: NOW },
      ] })),
      unknownNotApplicable: await quotaOf(async () => ({ kind: 'not_applicable' })),
      unknownReadFailed: await quotaOf(async () => { throw new Error('nope'); }),
      unknownNothingReadable: await quotaOf(async () => ({ kind: 'windows', windows: [{ name: 'week', asOf: NOW }] })),
      unknownStale: await quotaOf(async () => ({ kind: 'windows', windows: [{ name: 'week', usedPercent: 41, resetsAt: inDays(3), asOf: NOW - QUOTA_STALE_MS - 1 }] })),
      unknownNotSupported: (await exchange('GET', ROUTE)).response.body.providers['copilot-cli'].quota,
    };
    expect(quotaCases.known).toMatchObject({ state: 'known', source: 'cli_query', limitingWindow: 'weekly', weekly: { usedPercent: 41 }, fiveHour: { usedPercent: 12 } });
    expect(quotaCases.low.state).toBe('low');
    expect(quotaCases.nearLimit.state).toBe('near_limit');
    expect(quotaCases.exhausted.state).toBe('exhausted');
    expect(quotaCases.fiveHourLimiting).toMatchObject({ state: 'low', limitingWindow: 'fiveHour' });
    expect(quotaCases.oneWindowUnreadable).toMatchObject({ state: 'known', unreadableWindows: ['fiveHour'] });
    expect(quotaCases.modelWindow).toMatchObject({ state: 'known', modelWindows: [{ name: 'Fable', usedPercent: 99 }] });
    expect(quotaCases.unknownNotApplicable).toMatchObject({ state: 'unknown', unknownReason: 'not_applicable' });
    expect(quotaCases.unknownReadFailed).toMatchObject({ state: 'unknown', unknownReason: 'read_failed', asOf: null });
    expect(quotaCases.unknownStale).toMatchObject({ state: 'unknown', unknownReason: 'stale', asOf: new Date(NOW - QUOTA_STALE_MS - 1).toISOString() });
    expect(quotaCases.unknownNotSupported).toMatchObject({ state: 'unknown', unknownReason: 'not_supported', source: 'none', asOf: null });
    // Whole responses, to show the polling rule. Each has one provider with no refreshAfterSeconds (Copilot).
    const nextFetch = (body: { providers: Parameters<typeof quotaRefetchDelaySeconds>[0] }) => quotaRefetchDelaySeconds(body.providers);
    // A read still going: not_read, and soon. A real wait, since the budget is a real timer.
    _resetProviderQuotaForTesting();
    let finishRead!: (r: unknown) => void;
    quotas['claude-code'] = () => new Promise((resolve) => { finishRead = resolve; });
    quotas['codex-cli'] = async () => plan(41);
    const mixedTtls = (await exchange('GET', ROUTE)).response.body;
    expect(mixedTtls.providers['claude-code'].quota).toMatchObject({ state: 'unknown', unknownReason: 'not_read', refreshAfterSeconds: 3 });
    expect(mixedTtls.providers['codex-cli'].quota.refreshAfterSeconds).toBe(300);
    expect(mixedTtls.providers['copilot-cli'].quota).not.toHaveProperty('refreshAfterSeconds');
    expect(nextFetch(mixedTtls)).toBe(5);
    finishRead(plan(41));
    // A cache that has just ended, with its new read still going: the last reading, and 0.
    await vi.waitFor(async () => { expect((await exchange('GET', ROUTE)).response.body.providers['claude-code'].quota.state).toBe('known'); });
    vi.mocked(Date.now).mockReturnValue(NOW + 300_000);
    quotas['claude-code'] = () => new Promise((resolve) => { finishRead = resolve; });
    const zeroTtl = (await exchange('GET', ROUTE)).response.body;
    expect(zeroTtl.providers['claude-code'].quota).toMatchObject({ state: 'known', refreshAfterSeconds: 0 });
    expect(nextFetch(zeroTtl)).toBe(5);
    finishRead(plan(41));
    quotas['claude-code'] = async () => plan(41);
    vi.mocked(Date.now).mockReturnValue(NOW);
    const noTtl = { providers: { 'copilot-cli': zeroTtl.providers['copilot-cli'] } };
    expect(nextFetch(noTtl)).toBeNull();
    _resetProviderQuotaForTesting();
    const { labels: _labels, ...withoutLabels } = mixedTtls;
    const { labels: _labelsZero, ...zeroWithoutLabels } = zeroTtl;
    fixtures.set('helper-routing-quota.json', {
      field: 'providers[provider].quota',
      cases: quotaCases,
      // labels are left out here: helper-routing.json has them.
      fullResponses: {
        mixedTtlsAndNotRead: { response: withoutLabels, nextFetchSeconds: nextFetch(mixedTtls) },
        zeroAndMissingTtl: { response: zeroWithoutLabels, nextFetchSeconds: nextFetch(zeroTtl) },
      },
    });
    // Never a credential, an account id or a plan name in any of it.
    expect(JSON.stringify(quotaCases)).not.toMatch(/accountId|planType|subscription|token|key/i);

    fixtures.set('helper-routing-helper.json', { snapshotField: 'routing', snapshotRow: row, snapshotRevisionField: 'helperRoutingRevision', settingsField: 'routing', cases: settings });

    // Auto: on and off at each level, and what a decision looks like.
    W.autoHelpers = false;
    const autoOf = async (route: string) => (await exchange('GET', route)).response.body.auto;
    const autoCases: Record<string, any> = { offByDefault: await autoOf(ROUTE) };
    W.autoHelpers = true;
    autoCases.onAppWide = await autoOf(ROUTE);
    autoCases.projectScope = await autoOf(`${ROUTE}?projectId=proj_app`);
    const projectDefaults = W.projectDefaults;
    W.projectDefaults = { ...projectDefaults, helperAuto: 'off' };
    autoCases.projectOff = await autoOf(`${ROUTE}?projectId=proj_app`);
    W.projectDefaults = projectDefaults;
    autoCases.agentFollowingApp = await autoOf(`${ROUTE}?agentId=durable_chat`);
    autoCases.notOrchestrating = await autoOf(`${ROUTE}?agentId=durable_sleepy`);
    W.durables[APP][0].mcpOverride = false;
    autoCases.mcpOff = await autoOf(`${ROUTE}?agentId=durable_chat`);
    delete W.durables[APP][0].mcpOverride;
    W.dispatcher.enabled = true;
    autoCases.dispatcherLocked = await autoOf(`${ROUTE}?agentId=durable_dispatcher`);
    W.dispatcher.enabled = false;
    expect(autoCases.offByDefault).toMatchObject({ effective: false, source: 'default', reason: 'not_enabled' });
    expect(autoCases.onAppWide).toMatchObject({ effective: true, source: 'app' });
    expect(autoCases.projectOff).toMatchObject({ effective: false, source: 'project', reason: 'project_off', scopes: { project: { value: 'off', choices: ['off', null] } } });
    expect(autoCases.mcpOff).toMatchObject({ effective: false, source: 'mcp_off', reason: 'mcp_off' });
    expect(autoCases.dispatcherLocked).toMatchObject({ effective: false, source: 'dispatcher_locked', reason: 'dispatcher_locked', scopes: { agent: { editable: false } } });
    expect(autoCases.notOrchestrating).toMatchObject({ effective: false, reason: 'orchestration_off' });

    const autoRevision = (await exchange('GET', ROUTE)).response.body.revision;
    const on = await command('accepted auto off app-wide', write({ revision: autoRevision, auto: false }));
    expect(on.body.result.auto).toMatchObject({ effective: false });
    expect(W.autoHelpers).toBe(false);
    const projectWrite = await command('accepted auto off for a project', { type: 'helperRouting.update', scope: 'project', projectId: 'proj_app', revision: on.body.result.revision, auto: 'off' });
    expect(projectWrite.body.result.auto).toMatchObject({ source: 'project', reason: 'project_off' });
    expect(W.projectDefaults).toMatchObject({ helperAuto: 'off' });
    const projectClear = await command('accepted project override removed (null, which never enables)', { type: 'helperRouting.update', scope: 'project', projectId: 'proj_app', revision: projectWrite.body.result.revision, auto: null });
    expect(projectClear.body.result.auto).toMatchObject({ effective: false, source: 'default', reason: 'not_enabled', scopes: { project: { value: null } } });
    await command('invalid_helper_routing (project can\'t turn it on)', { type: 'helperRouting.update', scope: 'project', projectId: 'proj_app', revision: projectClear.body.result.revision, auto: true });
    await command('invalid_helper_routing (app-wide off value)', write({ revision: projectClear.body.result.revision, auto: 'off' }));
    await command('project_not_found', { type: 'helperRouting.update', scope: 'project', projectId: 'missing', revision: projectClear.body.result.revision, auto: 'off' });
    W.autoHelpers = false;

    // The desktop changes a project's defaults while a phone holds the page.
    const held = (await exchange('GET', ROUTE)).response.body.revision;
    const watching = await connect();
    watching.send.mockClear();
    noteRoutingPolicyChanged();
    await _settleHelperRoutingForTesting();
    const moved = frames(watching).filter((f) => f.type === 'helper_routing:changed').at(-1);
    expect(moved.payload.revision).not.toBe(held);
    const staleAfterDesktop = await command('helper_routing_stale (a desktop project change)', write({ revision: held, auto: true }));
    expect(staleAfterDesktop).toMatchObject({ status: 409, body: { status: 'rejected', error: { code: 'helper_routing_stale' }, revision: moved.payload.revision, settings: { revision: moved.payload.revision } } });
    expect(W.autoHelpers).toBe(false);

    // A phone at a project's scope read null, and the desktop set off: its stale null can't clear that, and it gets the project's values.
    const heldProject = (await exchange('GET', `${ROUTE}?projectId=proj_app`)).response.body.revision;
    W.projectDefaults = { ...W.projectDefaults, helperAuto: 'off' };
    noteRoutingPolicyChanged();
    await _settleHelperRoutingForTesting();
    const staleProject = await command('helper_routing_stale (project scope, fresh values for that project)', { type: 'helperRouting.update', scope: 'project', projectId: 'proj_app', revision: heldProject, auto: null });
    expect(staleProject).toMatchObject({ status: 409, body: { error: { code: 'helper_routing_stale' }, settings: { auto: { source: 'project', reason: 'project_off', scopes: { project: { value: 'off' } } } } } });
    expect(W.projectDefaults.helperAuto).toBe('off');
    delete W.projectDefaults.helperAuto;

    // An agent's own setting: true or false sets it, null clears it, so it follows the app again.
    await command('accepted autoHelpers on', { type: 'agent.update', agentId: 'durable_chat', orchestration: { autoHelpers: true } });
    expect(W.durables[APP][0].orchestration.autoHelpers).toBe(true);
    await command('accepted autoHelpers off', { type: 'agent.update', agentId: 'durable_chat', orchestration: { autoHelpers: false } });
    expect(W.durables[APP][0].orchestration.autoHelpers).toBe(false);
    await command('accepted autoHelpers cleared (inherits)', { type: 'agent.update', agentId: 'durable_chat', orchestration: { autoHelpers: null } });
    expect(W.durables[APP][0].orchestration).not.toHaveProperty('autoHelpers');
    await command('invalid_orchestration (autoHelpers)', { type: 'agent.update', agentId: 'durable_chat', orchestration: { autoHelpers: 'yes' } });
    W.durables[APP][0].mcpOverride = false;
    await command('mcp_off (autoHelpers)', { type: 'agent.update', agentId: 'durable_chat', orchestration: { autoHelpers: true } });
    delete W.durables[APP][0].mcpOverride;

    const autoDecision = (fields: Record<string, unknown>) => decision({
      mode: 'auto', balanced: true, requested: field('auto', null, null, 'hard'), resolved: field('codex-cli', 'gpt-6.1-sol', 'high', 'hard'),
      source: { provider: 'auto', model: 'builtin_mapping', effort: 'builtin_mapping' }, reason: 'lower_load', quotaBasis: 'known',
      load: { 'claude-code': 2, 'codex-cli': 0 },
      quota: { 'claude-code': { state: 'known', asOf: new Date(NOW).toISOString(), limitingWindow: 'weekly' }, 'codex-cli': { state: 'known', asOf: new Date(NOW).toISOString(), limitingWindow: 'weekly' } },
      ...fields,
    });
    const autoDecisions: Record<string, unknown> = {
      lowerLoad: autoDecision({}),
      sticky: autoDecision({ reason: 'sticky', load: { 'claude-code': 1, 'codex-cli': 2 } }),
      unknownQuota: autoDecision({ reason: 'default_order', quotaBasis: 'unknown_scored_as_healthy', load: { 'claude-code': 0, 'codex-cli': 0 },
        quota: { 'codex-cli': { state: 'unknown', unknownReason: 'not_applicable', asOf: new Date(NOW).toISOString() } } }),
      skippedOne: autoDecision({ reason: 'only_candidate', fallback: 'candidate_skipped', skipped: { 'claude-code': 'quota_near_limit', 'copilot-cli': 'auto_not_supported' } }),
      betterTier: autoDecision({ reason: 'better_quota_tier', quota: {
        'claude-code': { state: 'low', asOf: new Date(NOW).toISOString(), limitingWindow: 'fiveHour' }, 'codex-cli': { state: 'known', asOf: new Date(NOW).toISOString(), limitingWindow: 'weekly' },
      } }),
      explicitWithWarning: decision({
        mode: 'explicit', requested: field('codex-cli', 'gpt-6.1-sol', 'high', null), resolved: field('codex-cli', 'gpt-6.1-sol', 'high', null),
        source: { provider: 'request', model: 'request', effort: 'request' }, reason: 'explicit_request',
        warning: { code: 'cooling_down', asOf: new Date(NOW).toISOString(), message: 'codex-cli failed to start or hit its limit recently. The helper is started on it anyway, as asked.' },
      }),
      personaPinned: decision({ mode: 'auto', requested: field('auto', null, null, 'hard'), resolved: field('claude-code', 'opus', null, 'hard'),
        source: { provider: 'persona', model: 'persona', effort: 'cli_default' }, reason: 'persona_pinned' }),
    };
    const autoSettings: Record<string, unknown> = {};
    for (const [name, routing] of Object.entries(autoDecisions)) {
      docs.routing = routing;
      autoSettings[name] = (await exchange('GET', '/api/v1/mobile/agents/durable_docs/settings')).response.body.routing;
    }
    docs.routing = autoDecisions.lowerLoad;
    const autoRow = frames(await connect()).find((f) => f.type === 'snapshot').payload.agents.proj_app.find((a: { id: string }) => a.id === 'durable_docs').routing;
    expect(autoRow).toEqual({ mode: 'auto', difficulty: 'hard', provider: 'codex-cli', model: 'gpt-6.1-sol', effort: 'high', reason: 'lower_load' });
    delete docs.routing;
    // A held start that names Auto, and what refusing it looks like: definite, like no_valid_mapping.
    W.helperStart = 'no_candidate';
    const heldAuto = helperStart({ cli: 'auto', difficulty: 'hard' });
    const heldRow = frames(await connect()).find((f) => f.type === 'snapshot').payload.helperRequests.find((r: { requestId: string }) => r.requestId === heldAuto);
    expect(heldRow.requestedRouting).toEqual({ provider: 'auto', model: null, effort: null, difficulty: 'hard' });
    const noProvider = await command('no_candidate', { type: 'helper.approve', requestId: heldAuto });
    expect(noProvider).toMatchObject({ status: 409, body: { status: 'rejected', error: { code: 'no_candidate' } } });
    // A start that names a provider looking unwell: it says so, as of when it was known, and never blocks.
    _resetStartRequestsForTesting({ keepListeners: true });
    const startWarning: HelperStartWarning = { code: 'quota_near_limit', asOf: new Date(NOW - 60_000).toISOString(), message: 'codex-cli is close to its plan limit. The helper is started on it anyway, as asked.' };
    const warnedHeld = helperStart({ cli: 'codex-cli', model: 'gpt-6.1-sol' }, startWarning);
    const warnedRow = frames(await connect()).find((f) => f.type === 'snapshot').payload.helperRequests.find((r: { requestId: string }) => r.requestId === warnedHeld);
    expect(warnedRow.startWarning).toEqual(startWarning);
    W.helperStart = 'warned';
    const warnedApproval = await command('accepted start, with a warning', { type: 'helper.approve', requestId: warnedHeld });
    expect(warnedApproval.body.result.warning).toMatchObject({ code: 'quota_near_limit', asOf: new Date(NOW).toISOString() });
    W.helperStart = 'auto_off';
    await command('auto_off', { type: 'helper.approve', requestId: helperStart({ cli: 'auto', difficulty: 'hard' }) });
    W.helperStart = 'approve';
    fixtures.set('helper-routing-auto.json', { direction: 'desktop-to-phone', field: 'auto', cases: autoCases, heldStart: heldRow, heldStartWithWarning: warnedRow, snapshotRow: autoRow, settingsRouting: autoSettings });

    W.providers = {};
    vi.mocked(Date.now).mockRestore();
  }, TEST_TIMEOUT_MS);

  it('session pairing revocation', async () => {
    fixtures.set('pairing-revoke.json', { persistent: await exchange('DELETE', '/api/v1/mobile/pairing') });
  });

  it('every command type has an accepted request and receipt', () => {
    for (const type of MOBILE_COMMAND_TYPES) {
      const list = commandFixtures.get(type) ?? [];
      expect(list.some((c) => c.response.body?.status === 'completed'), type).toBe(true);
      fixtures.set(`commands/${type}.json`, { type, cases: list });
    }
    fixtures.set('commands/_common.json', { type: null, cases: commandFixtures.get('_common') });
    // What parseMobileCommand accepts: anything else is invalid_command, so the phone checks its encoder against this.
    fixtures.set('commands/_fields.json', {
      base: ['version', 'commandId', 'epoch', 'type'],
      commands: Object.fromEntries(MOBILE_COMMAND_TYPES.map((type) => [type, {
        fields: [...MOBILE_COMMAND_FIELDS[type]],
        required: MOBILE_COMMAND_FIELDS[type].filter((k) => !isOptionalCommandField(type, k)),
        ...(type === 'agent.update' && { nullable: [...NULLABLE_ON_UPDATE], atLeastOne: MOBILE_COMMAND_FIELDS[type].filter((k) => k !== 'agentId') }),
      }])),
    });
  });

  it('context choices: each kind, current and pending, resets and the Dispatcher (#2660)', async () => {
    const shared = await import('../../shared/context-window');
    const settingsOf = async (id: string) => (await exchange('GET', `/api/v1/mobile/agents/${id}/settings`));
    const sleepy = W.durables[APP].find((d) => d.id === 'durable_sleepy')!;
    const live = W.durables[APP].find((d) => d.id === 'durable_chat')!;
    sleepy.orchestrator = 'claude-code';
    sleepy.model = 'opus';
    const astra = { slug: 'gpt-6-astra', contextWindow: 272000, maxContextWindow: 872000, effectivePercent: 95 };
    const tiered = { id: 'm', hasLongContext: true, standardTokens: 200000, longTokens: 900000, standardInputPrice: 1, longInputPrice: 2 };
    const cases: Record<string, unknown> = {};
    const kinds: Array<[string, unknown]> = [
      ['working_window', shared.claudeContextWindowOptions('opus')],
      ['context_window', shared.codexContextWindowOptions(astra)],
      ['tier', shared.copilotContextWindowOptions('m', [tiered])],
      ['unsupported', shared.codexContextWindowOptions({ ...astra, maxContextWindow: 272000 })],
      ['pick_model', shared.copilotContextWindowOptions('auto', [tiered])],
      ['unavailable', shared.copilotContextWindowOptions('m', null)],
    ];
    for (const [name, options] of kinds) {
      W.contextOptions = options as Record<string, unknown>;
      const res = await settingsOf('durable_sleepy');
      cases[name] = res.response.body.settings.contextWindow;
    }
    expect(cases.working_window).toMatchObject({ kind: 'working_window', configurable: true, editable: 'sleeping', value: null, applies: ['launch', 'resume'], state: null });
    expect(cases.unsupported).toMatchObject({ kind: null, configurable: false, editable: 'never', state: 'unsupported', choices: [] });

    // A saved choice the catalog can't confirm: still saved, not applied, not in choices.
    sleepy.contextWindow = 'long_context';
    cases.unavailableWithSavedChoice = (await settingsOf('durable_sleepy')).response.body.settings.contextWindow;
    delete sleepy.contextWindow;
    W.contextOptions = null;

    // Current and pending: the running session as reported, and the next start's choice.
    live.contextWindow = '500000';
    const running = (await settingsOf('durable_chat')).response.body;
    const chat = (await exchange('GET', '/api/v1/mobile/agents/durable_chat/chat')).response.body;
    expect(running.settings.contextWindow).toMatchObject({ value: '500000', editable: 'sleeping' });
    expect(running.sleeping).toBe(false);
    expect(chat.chatControls.context).toEqual({ effectiveTokens: 300000, compactAtTokens: 267000, reservedTokens: 33000, note: shared.CLAUDE_WORKING_WINDOW_NOTE });
    const currentAndPending = { pending: running.settings.contextWindow, current: chat.chatControls.context };
    delete live.contextWindow;

    await command('accepted contextWindow', { type: 'agent.update', agentId: 'durable_sleepy', contextWindow: '500000' });
    expect(sleepy.contextWindow).toBe('500000');
    await command('accepted contextWindow null reset', { type: 'agent.update', agentId: 'durable_sleepy', contextWindow: null });
    expect(sleepy).not.toHaveProperty('contextWindow');
    await command('invalid_context_window', { type: 'agent.update', agentId: 'durable_sleepy', contextWindow: '123' });
    await command('agent_running (contextWindow)', { type: 'agent.update', agentId: 'durable_chat', contextWindow: '500000' });

    sleepy.contextWindow = '500000';
    W.contextOptions = shared.claudeContextWindowOptions('claude-haiku-4-5') as unknown as Record<string, unknown>;
    const reset = await command('accepted model change resets contextWindow', { type: 'agent.update', agentId: 'durable_sleepy', model: 'sonnet' });
    expect(reset.body.result.contextWindowReset).toEqual({ previous: '500000', reason: '500000 isn\'t one this model offers.' });
    expect(reset.body.result.settings.contextWindow).toMatchObject({ value: null, notice: '500000 isn\'t one this model offers.' });
    delete sleepy.contextWindowNotice;
    W.contextOptions = null;

    // The Dispatcher: changes at any time, for the next start, and nothing else unlocks.
    const wasFlag = W.dispatcher.flagOn; const wasOn = W.dispatcher.enabled;
    W.dispatcher.flagOn = true; W.dispatcher.enabled = true;
    const dispatcherAgent = W.durables[DISPATCHER_PATH][0];
    const wasCli = dispatcherAgent.orchestrator; const wasModel = dispatcherAgent.model;
    dispatcherAgent.orchestrator = 'claude-code'; dispatcherAgent.model = 'opus';
    cases.dispatcher = (await settingsOf('durable_dispatcher')).response.body.settings.contextWindow;
    expect(cases.dispatcher).toMatchObject({ editable: 'always', applies: ['launch', 'resume'] });
    await command('accepted contextWindow (Dispatcher)', { type: 'agent.update', agentId: 'durable_dispatcher', contextWindow: '300000' });
    await command('accepted contextWindow null reset (Dispatcher)', { type: 'agent.update', agentId: 'durable_dispatcher', contextWindow: null });
    await command('invalid_context_window (Dispatcher)', { type: 'agent.update', agentId: 'durable_dispatcher', contextWindow: '123' });
    const locked = await command('dispatcher_locked (name, with contextWindow)', { type: 'agent.update', agentId: 'durable_dispatcher', contextWindow: '300000', name: 'Boss' });
    expect(locked.status).toBe(409);
    Object.assign(dispatcherAgent, { orchestrator: wasCli, model: wasModel });
    W.dispatcher.flagOn = wasFlag; W.dispatcher.enabled = wasOn;

    fixtures.set('agent-settings-context-window.json', {
      direction: 'desktop-to-phone',
      field: 'settings.contextWindow',
      cases,
      currentAndPending,
      // The existing chat `notice` event, sent when a start doesn't use the saved choice.
      notAppliedNotice: envelope(1, 'notice', { level: 'warn', code: 'context_window_not_applied', message: 'Started without the saved context choice, and cleared it. 500000 isn\'t one this model offers.' }),
    });
  });

  it('icon refs: the snapshot forms, changes, removals and the routes', async () => {
    const saved = W.durables[DISPATCHER_PATH][0];
    W.durables[DISPATCHER_PATH][0] = { ...saved, icon: 'durable_dispatcher.png' };
    W.dispatcher = { flagOn: true, enabled: true, newLayout: true };
    const refsSocket = () => connect('mtls', { iconRefs: true });
    const firstSnapshot = async () => frames(await refsSocket()).find((f) => f.type === 'snapshot').payload;
    const SHA = /^[0-9a-f]{64}$/;

    const legacy = await connect('mtls');
    const refs = await refsSocket();
    const snapshot = frames(refs).find((f) => f.type === 'snapshot').payload;
    expect(snapshot.agentIcons).toEqual({});
    expect(snapshot.projectIcons).toEqual({});
    expect(snapshot.iconRefs.agents.durable_chat.version).toMatch(SHA);
    expect(snapshot.iconRefs.projects.proj_app.type).toBe('image/png');
    // The Dispatcher has a ref, though it isn't in the snapshot's own `agents` map.
    expect(snapshot.iconRefs.agents.durable_dispatcher.version).toMatch(SHA);
    expect(Object.values(snapshot.agents).flat().some((a: any) => a.id === 'durable_dispatcher')).toBe(false);
    expect(JSON.stringify(snapshot.iconRefs)).not.toContain('base64');
    const legacySnapshot = frames(legacy).find((f) => f.type === 'snapshot').payload;
    expect(legacySnapshot).not.toHaveProperty('iconRefs');
    fixtures.set('snapshot-icon-refs.json', {
      direction: 'desktop-to-phone', connect: '/ws?iconRefs=1&client=mobile',
      note: 'Send both params on every connection, including reconnects. client is for metrics only. agentIcons and projectIcons are empty for an opted-in socket; ignore them. The Dispatcher is in iconRefs.agents, though not in the snapshot\'s agents map. A quick agent never has an entry.',
      value: { agentIcons: snapshot.agentIcons, projectIcons: snapshot.projectIcons, iconRefs: snapshot.iconRefs },
    });

    // A socket of each form, on one refresh.
    legacy.send.mockClear();
    refs.send.mockClear();
    annexServer.broadcastSnapshotRefresh();
    await eventually(() => {
      expect(frames(legacy).some((f) => f.type === 'snapshot')).toBe(true);
      expect(frames(refs).some((f) => f.type === 'snapshot')).toBe(true);
    });
    const mixed = { legacy: frames(legacy).find((f) => f.type === 'snapshot').payload, refs: frames(refs).find((f) => f.type === 'snapshot').payload };
    expect(mixed.legacy).not.toHaveProperty('iconRefs');
    expect(Object.keys(mixed.legacy.agentIcons).length).toBeGreaterThan(0);
    expect(mixed.refs.agentIcons).toEqual({});
    expect(mixed.refs.iconRefs.agents.durable_chat).toBeDefined();

    // The image changes, then goes.
    const chat = W.durables[APP].findIndex((d) => d.id === 'durable_chat');
    const original = W.durables[APP][chat];
    W.durables[APP][chat] = { ...original, icon: 'durable_chat.changed.png' };
    const changed = (await firstSnapshot()).iconRefs;
    expect(changed.agents.durable_chat.version).not.toBe(snapshot.iconRefs.agents.durable_chat.version);
    W.durables[APP][chat] = { ...original, icon: undefined };
    const removed = (await firstSnapshot()).iconRefs;
    expect(removed.agents.durable_chat).toBeUndefined();
    fixtures.set('snapshot-icon-refs-changed.json', {
      direction: 'desktop-to-phone',
      note: 'A present map is complete: replace it. A different version means fetch. No entry in a present map means removal, so drop the cached image.',
      before: snapshot.iconRefs.agents.durable_chat, changed: changed.agents.durable_chat, removed: removed.agents.durable_chat ?? null,
    });

    // The routes, for the same image the snapshot fixture describes.
    W.durables[APP][chat] = original;
    const { version, bytes } = (await firstSnapshot()).iconRefs.agents.durable_chat;
    expect(version).toBe(snapshot.iconRefs.agents.durable_chat.version);
    const served = await (await import('./icon-images')).readIconImage(`|${original.icon}`) as { dataUrl: string };
    const imageBase64 = served.dataUrl.slice(served.dataUrl.indexOf(',') + 1);
    expect(crypto.createHash('sha256').update(Buffer.from(imageBase64, 'base64')).digest('hex')).toBe(version);
    expect(Buffer.from(imageBase64, 'base64').length).toBe(bytes);
    const route = '/api/v1/icons/agent/durable_chat';
    const asFixture = async (path: string, headers?: Record<string, string>) => {
      const res = await send('GET', path, undefined, { headers });
      return { request: { path, ...(headers && { headers }) }, response: { status: res.status, headers: pickIconHeaders(res.headers ?? {}) } };
    };
    const current = await asFixture(`${route}?v=${version}`);
    const notModified = await asFixture(`${route}?v=${version}`, { 'If-None-Match': `"${version}"` });
    const stale = await asFixture(`${route}?v=${'0'.repeat(64)}`, { 'If-None-Match': `"${'0'.repeat(64)}"` });
    const noVersion = await asFixture(route);
    W.durables[APP][chat] = { ...original, icon: undefined };
    const missing = await send('GET', route);
    W.durables[APP][chat] = original;
    // Can't be read just now: not a removal, so no refs at all and a route that says to come back.
    W.iconsUnavailable = true;
    const unknown = await firstSnapshot();
    const unavailable = await send('GET', route);
    W.iconsUnavailable = false;
    expect(unknown).not.toHaveProperty('iconRefs');
    expect(unknown).not.toHaveProperty('snapshotTruncated');
    expect(unavailable.status).toBe(503);
    expect(current.response.status).toBe(200);
    expect(current.response.headers.etag).toBe(`"${version}"`);
    expect(current.response.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(Number(current.response.headers['content-length'])).toBe(bytes);
    expect(notModified.response.status).toBe(304);
    expect(notModified.response.headers.etag).toBe(`"${version}"`);
    expect(stale.response.status).toBe(200);
    expect(stale.response.headers['cache-control']).toBe('private, no-cache');
    expect(noVersion.response.headers['cache-control']).toBe('private, max-age=3600');
    expect(missing.status).toBe(404);
    fixtures.set('icon-route.json', {
      note: 'Check the body: its SHA-256 equals the ETag, its byte count, and its Content-Type and decoded type and size. If the ETag differs from the current snapshot\'s version it is stale: keep what you draw and do not refetch until a new snapshot changes the version.',
      imageBase64, version,
      current, notModified, stale, noVersion,
      missing: { request: { path: route }, response: { status: missing.status, body: missing.body } },
      unavailable: { request: { path: route }, response: { status: unavailable.status, body: unavailable.body } },
    });

    // Refs left out of a frame over its limit, from the real server.
    const projects = W.projects;
    W.projects = projects.map((p, i) => (i === 0 ? { ...p, displayName: 'n'.repeat(9 * 1024 * 1024) } : p));
    const truncated = await firstSnapshot();
    W.projects = projects;
    expect(truncated).not.toHaveProperty('iconRefs');
    expect(truncated.snapshotTruncated.omitted).toContain('iconRefs');
    expect(truncated.agentIcons).toEqual({});

    const entry = { version, type: 'image/png', bytes, width: 1, height: 1 };
    const stored = { agents: { a1: entry, a2: entry }, projects: { p1: entry } };
    fixtures.set('icon-refs-cases.json', {
      note: 'What a client does with each. Stored is what it held before. Unknown keeps what it has. All of these are hand written from the contract, apart from the omitted case, whose shape comes from the real server.',
      stored,
      snapshots: [
        { name: 'complete', iconRefs: stored, expect: 'replace both maps' },
        { name: 'one removed', iconRefs: { agents: { a1: entry }, projects: { p1: entry } }, expect: 'a2 removed: drop its image' },
        { name: 'all removed', iconRefs: { agents: {}, projects: {} }, expect: 'every image removed' },
        { name: 'unmarked absence', expect: 'unknown: keep all' },
        { name: 'marked absence', snapshotTruncated: { version: 1, reason: 'frame_limit', omitted: truncated.snapshotTruncated.omitted, bytes: 9437184 }, agentIcons: {}, projectIcons: {}, expect: 'unknown: keep all, and ignore the empty legacy maps' },
        { name: 'one sub-map missing', iconRefs: { agents: { a1: entry } }, expect: 'agents replaced, projects unknown: keep them' },
        { name: 'null', iconRefs: null, expect: 'unknown: keep all' },
        { name: 'null sub-map', iconRefs: { agents: null, projects: { p1: entry } }, expect: 'agents unknown, projects replaced' },
        { name: 'partial entry', iconRefs: { agents: { a1: { version } }, projects: {} }, expect: 'a1 has no valid ref: draw initials, and do not fetch' },
      ],
      responses: [
        { name: 'current', status: 200, etag: `"${version}"`, contentType: 'image/png', bodyBytes: bytes, expect: 'show' },
        { name: 'not modified', status: 304, etag: `"${version}"`, expect: 'show the cached image' },
        { name: 'stale', status: 200, etag: `"${'0'.repeat(64)}"`, contentType: 'image/png', expect: 'keep what is drawn, no refetch until the version changes' },
        { name: 'in flight, then removed', status: 200, etag: `"${version}"`, contentType: 'image/png', currentVersion: null, expect: 'discard: it has no entry now' },
        { name: 'in flight, then changed', status: 200, etag: `"${version}"`, contentType: 'image/png', currentVersion: '0'.repeat(64), expect: 'discard, and fetch the new version' },
        { name: 'missing', status: 404, expect: 'initials, no retry for this version' },
        { name: 'type mismatch', status: 200, etag: `"${version}"`, contentType: 'image/jpeg', expect: 'bad image: initials' },
        { name: 'byte mismatch', status: 200, etag: `"${version}"`, contentType: 'image/png', bodyBytes: bytes + 1, expect: 'bad image: initials' },
        { name: 'dimension mismatch', status: 200, etag: `"${version}"`, contentType: 'image/png', decodedWidth: 512, decodedHeight: 512, expect: 'bad image: initials' },
        { name: 'hash mismatch', status: 200, etag: `"${version}"`, contentType: 'image/png', bodySha256: '1'.repeat(64), expect: 'bad image: initials' },
      ],
    });

    // Real images through the real code, one of each type a phone can be sent.
    const { readIconImage } = await vi.importActual<typeof import('./icon-images')>('./icon-images');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annex-icon-samples-'));
    const samples = {
      'image/png': VALID_PNG_BASE64,
      'image/jpeg': '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
      'image/gif': 'R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=',
      'image/webp': 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
    };
    const images = [];
    for (const [type, base64] of Object.entries(samples)) {
      const file = path.join(dir, `sample-${images.length}`);
      fs.writeFileSync(file, Buffer.from(base64, 'base64'));
      const image = (await readIconImage(file))!;
      expect(image.type).toBe(type);
      expect(image.version).toMatch(SHA);
      expect(image.version).toBe(crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'));
      images.push({ base64, type: image.type, version: image.version, etag: `"${image.version}"`, bytes: image.bytes, width: image.width, height: image.height });
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fixtures.set('icon-images.json', { note: 'One real image of each type, as the real code describes it.', images });

    W.durables[DISPATCHER_PATH][0] = saved;
    W.dispatcher = { flagOn: false, enabled: false, newLayout: true };
  }, TEST_TIMEOUT_MS);

  afterAll(() => {
    if (W.iconDir) fs.rmSync(W.iconDir, { recursive: true, force: true });
  });

  it('frames over the limit: a canvas marker, and the last resort', async () => {
    const ws = await connect();
    ws.send.mockClear();
    annexServer.broadcastCanvasStateToClients('proj_app', { canvasId: 'canvas_1', views: 'v'.repeat(9 * 1024 * 1024) });
    annexServer.broadcastAppCanvasStateToClients({ canvasId: 'canvas_1', views: 'v'.repeat(9 * 1024 * 1024) });
    const [projectMarker, appMarker] = frames(ws).filter((f) => f.type === 'canvas:state');
    expect(projectMarker.payload).not.toHaveProperty('state');
    publishChatEvent({ v: 2, type: 'agent_message', agentId: 'durable_chat', sessionId: 'session_fixture', seq: 98, ts: NOW, data: { messageId: 'amsg_large', text: 't'.repeat(9 * 1024 * 1024) } } as never);
    const omitted = frames(ws).find((f) => f.type === 'frame:omitted');
    expect(omitted.seq).toEqual(expect.any(Number));
    fixtures.set('frames-over-limit.json', {
      direction: 'desktop-to-phone',
      note: 'canvas:state with no state: ignore it, or fetch through snapshotTruncation.canvasPaths. frame:omitted: advance your cursor. It only stands in for agent text, never an approval, question, queue change or status.',
      canvasMarker: projectMarker, appCanvasMarker: appMarker, omitted: { ...omitted, seq: '<the seq the event would have had>' },
    });
  }, TEST_TIMEOUT_MS);

  it('large tool output: a preview, live and on replay', async () => {
    const ws = await connect();
    ws.send.mockClear();
    publishChatEvent({ v: 1, type: 'tool_call_update', agentId: 'durable_chat', sessionId: 'session_fixture', seq: 99, ts: NOW, data: {
      toolCallId: 'call_large', status: 'completed', durationMs: 1200, contentMode: 'append',
      content: [{ type: 'terminal', command: 'cat big.log', output: `first line\n${'x'.repeat(40)}\n`.repeat(1).concat(`${'filler line\n'.repeat(200_000)}last line\n`), exitCode: 0 }],
      rawOutput: { stdout: 'y'.repeat(2 * 1024 * 1024) },
    } } as never);
    const frame = frames(ws).find((f) => f.type === 'chat:event');
    expect(frame.payload.event.data).toMatchObject({ toolCallId: 'call_large', status: 'completed', contentMode: 'replace' });
    expect(frame.payload.event.data).not.toHaveProperty('rawOutput');
    // The middle of a filler log, so the file stays readable. It's still the shape on the wire.
    const output = frame.payload.event.data.content[0].output as string;
    const note = output.match(/\[Clubhouse: .*\]/)![0];
    fixtures.set('chat-event-tool-output-preview.json', {
      direction: 'desktop-to-phone',
      note: 'Over 1 MiB. The filler in output and originalBytes are shortened here; the note between the start and end is what a phone draws.',
      frame: { ...frame, seq: 1000, payload: { ...frame.payload, event: { ...frame.payload.event, data: {
        ...frame.payload.event.data,
        truncated: { originalBytes: 4577777 },
        content: [{ ...frame.payload.event.data.content[0], output: `first line\n\n${note.replace(/\d+ bytes/, '4000000 bytes')}\nlast line\n` }],
      } } } },
    });
  }, TEST_TIMEOUT_MS);


  it('large permission requests: preview, refused approve, deny', async () => {
    const big = { ...LIVE_TRANSCRIPT.find((e) => e.type === 'permission_request')! };
    const large = { ...big, data: { ...(big as any).data, title: 'Write big.ts', description: 'big.ts', toolName: 'Write', rawInput: { file_path: '/work/app/big.ts', content: 'c'.repeat(300 * 1024) } } };
    registerChatRuntime(chatRuntime('durable_chat', 'sess_live', CHAT_CAPS, [...LIVE_TRANSCRIPT.filter((e) => e !== big), large as never], true) as never);
    const chat = { agentId: 'durable_chat', sessionId: 'sess_live' };

    const snapshot = await exchange('GET', '/api/v1/mobile/agents/durable_chat/chat');
    const [pending] = (snapshot.response.body as { pendingPermissions: any[] }).pendingPermissions;
    expect(pending.data.description.startsWith('Incomplete input:')).toBe(true);
    expect(pending.data.content[0].text.startsWith('Incomplete input:')).toBe(true);

    const approve = await send('POST', '/api/v1/mobile/commands', { version: 1, epoch, commandId: 'cmd_incomplete_allow', type: 'chat.permission', ...chat, requestId: 'perm_1', optionId: 'allow' });
    expect(approve.status).toBe(409);
    expect(approve.body).toMatchObject({ status: 'rejected', error: { code: 'incomplete_representation' } });
    const deny = await send('POST', '/api/v1/mobile/commands', { version: 1, epoch, commandId: 'cmd_incomplete_deny', type: 'chat.permission', ...chat, requestId: 'perm_1', optionId: PERMISSION_OPTIONS.find((o) => o.kind.startsWith('reject'))!.optionId });
    expect(deny.status).toBe(200);

    const preview = pending.data.content[0].text as string;
    const ws = await connect();
    ws.send.mockClear();
    publishChatEvent(envelope(101, 'tool_call', { toolCallId: 'call_write', kind: 'edit', title: 'Write big.ts', status: 'pending', toolName: 'Write',
      locations: [{ path: '/work/app/big.ts', line: 1 }],
      rawInput: { file_path: '/work/app/big.ts', content: 'c'.repeat(300 * 1024) } }) as never);
    const toolCall = frames(ws).find((f) => f.type === 'chat:event');
    expect(toolCall.payload.event.data.rawInput).toEqual({ file_path: '/work/app/big.ts' });
    expect(toolCall.payload.event.data.locations).toEqual([{ path: '/work/app/big.ts', line: 1 }]);
    expect(toolCall.payload.event.data.content[0].text).toMatch(/this is a preview/);
    fixtures.set('chat-event-tool-call-preview.json', {
      direction: 'desktop-to-phone',
      note: 'A tool_call over 256 KiB keeps its id, title, kind, status and locations. rawInput has only small plain fields. 147 ignores truncated, so content leads with a note, which it shows when the card is opened. originalBytes is pinned here.',
      frame: { ...toolCall, seq: 1000, payload: { ...toolCall.payload, event: { ...toolCall.payload.event, data: { ...toolCall.payload.event.data, truncated: { originalBytes: 307400 } } } } },
    });

    fixtures.set('chat-permission-incomplete.json', {
      note: 'Over 256 KiB. The middle of the preview is shortened here. The warning leads description and content; approve is refused and deny works.',
      pendingPermission: { ...pending, data: { ...pending.data, truncated: { originalBytes: 307543 }, content: [{ type: 'text', text: `${preview.slice(0, preview.indexOf('\n\n'))}\n\n{\n  "file_path": "/work/app/big.ts",\n  "content": "ccc…"\n}` }] } },
      approve: { request: { type: 'chat.permission', requestId: 'perm_1', optionId: 'allow' }, response: { status: approve.status, body: { ...approve.body, epoch: '<epoch>', commandId: '<commandId>' } } },
      deny: { status: deny.status, body: { ...deny.body, epoch: '<epoch>', commandId: '<commandId>' } },
    });
    registerChatRuntime(chatRuntime('durable_chat', 'sess_live', CHAT_CAPS, LIVE_TRANSCRIPT, true) as never);
  }, TEST_TIMEOUT_MS);


  it('refuses approve through a real command when the options have changed since the phone was sent them', async () => {
    const chat = { agentId: 'durable_chat', sessionId: 'sess_live' };
    const runtime = chatRuntime('durable_chat', 'sess_live', CHAT_CAPS, LIVE_TRANSCRIPT, true);
    const allow = PERMISSION_OPTIONS.find((o) => o.kind.startsWith('allow'))!;
    const deny = PERMISSION_OPTIONS.find((o) => o.kind.startsWith('reject'))!;
    registerChatRuntime({
      ...runtime,
      getPendingPermissionOptions: (id: string) => (id === 'perm_1' ? [...PERMISSION_OPTIONS, { optionId: 'added', kind: 'allow_always', label: 'Allow everything' }] : undefined),
    } as never);

    const approve = await send('POST', '/api/v1/mobile/commands', { version: 1, epoch, commandId: 'cmd_changed_allow', type: 'chat.permission', ...chat, requestId: 'perm_1', optionId: allow.optionId });
    expect(approve.status).toBe(409);
    expect(approve.body).toMatchObject({ status: 'rejected', error: { code: 'incomplete_representation' } });

    const denied = await send('POST', '/api/v1/mobile/commands', { version: 1, epoch, commandId: 'cmd_changed_deny', type: 'chat.permission', ...chat, requestId: 'perm_1', optionId: deny.optionId });
    expect(denied.status).toBe(200);
    registerChatRuntime(runtime as never);
  }, TEST_TIMEOUT_MS);


  it('does not offer a deny a request does not have', async () => {
    const chat = { agentId: 'durable_chat', sessionId: 'sess_live' };
    const big = LIVE_TRANSCRIPT.find((e) => e.type === 'permission_request')! as any;
    const allowOnly = PERMISSION_OPTIONS.filter((o) => o.kind.startsWith('allow'));
    const large = { ...big, data: { ...big.data, requestId: 'perm_1', options: allowOnly, rawInput: { content: 'c'.repeat(300 * 1024) } } };
    const runtime = chatRuntime('durable_chat', 'sess_live', CHAT_CAPS, [...LIVE_TRANSCRIPT.filter((e) => e !== big), large as never], true);
    registerChatRuntime({ ...runtime, getPendingPermissionOptions: () => allowOnly } as never);

    const snapshot = await exchange('GET', '/api/v1/mobile/agents/durable_chat/chat');
    const [pending] = (snapshot.response.body as { pendingPermissions: any[] }).pendingPermissions;
    expect(pending.data.description).not.toMatch(/deny/i);
    const approve = await send('POST', '/api/v1/mobile/commands', { version: 1, epoch, commandId: 'cmd_no_deny_allow', type: 'chat.permission', ...chat, requestId: 'perm_1', optionId: allowOnly[0].optionId });
    expect(approve.status).toBe(409);
    expect(approve.body.error.message).toBe('This request is too large to review here. Review it on the desktop.');
    registerChatRuntime(chatRuntime('durable_chat', 'sess_live', CHAT_CAPS, LIVE_TRANSCRIPT, true) as never);
  }, TEST_TIMEOUT_MS);


  it('chat pages: bounded on bytes, and pending all or nothing', async () => {
    const chat = (agentEvents: ChatEvent[]) => registerChatRuntime(chatRuntime('durable_chat', 'sess_live', CHAT_CAPS, agentEvents, true) as never);
    const route = '/api/v1/mobile/agents/durable_chat/chat';
    const options = [{ optionId: 'allow', kind: 'allow_once', label: 'Allow' }, { optionId: 'deny', kind: 'reject_once', label: 'Deny' }];
    const permission = (i: number, input = 300 * 1024) => envelope(100 + i, 'permission_request', { requestId: `perm_big_${i}`, title: `Write file ${i}`, toolName: 'Write', options, rawInput: { file_path: `/work/${i}`, content: 'c'.repeat(input) } });
    const shorten = (body: any) => ({ ...body, chatControls: '<omitted>', capabilities: '<omitted>', slashCommands: '<omitted>', events: `<${body.events.length} events>`, epoch: '<epoch>', pendingPermissions: body.pendingPermissions.slice(0, 2) });

    // The tail runs out of room before it runs out of events.
    const large = Array.from({ length: 30 }, (_, i) => envelope(200 + i, 'notice', { level: 'info', message: 'n'.repeat(512 * 1024) }));
    chat(large);
    const byBytes = await send('GET', route);
    expect(byBytes.status).toBe(200);
    expect(byBytes.body.truncated).toBe(true);
    expect(byBytes.body.events.length).toBeLessThan(30);
    expect(byBytes.body.nextBeforeSeq).toBe(byBytes.body.events[0].seq);
    expect(Buffer.byteLength(JSON.stringify(byBytes.body))).toBeLessThanOrEqual(8 * 1024 * 1024);

    // Too many to preview: every row minimal, none missing.
    chat(Array.from({ length: 300 }, (_, i) => permission(i, 8 * 1024)));
    const minimal = await send('GET', route);
    expect(minimal.status).toBe(200);
    expect(minimal.body.pendingPermissions).toHaveLength(300);
    const [row] = minimal.body.pendingPermissions;
    expect(row.data.description.startsWith('Incomplete input:')).toBe(true);
    expect(row.data.options.map((o: { kind: string }) => o.kind)).toEqual(['reject_once']);
    expect(row.data).not.toHaveProperty('rawInput');
    expect(row.data).not.toHaveProperty('content');
    // The tail's copy is the same row.
    expect(minimal.body.events.find((e: any) => e.data.requestId === row.data.requestId).data).toEqual(row.data);

    // A question that can't fit: never shortened, so no page.
    const hugeQuestion = envelope(300, 'question', { requestId: 'q_big', questions: [{ id: 'which', prompt: 'q'.repeat(9 * 1024 * 1024), header: 'Big', options: [] }] });
    chat([hugeQuestion]);
    const noPage = await send('GET', route);
    expect(noPage.status).toBe(503);
    expect(noPage.body.error).toBe('pending_overflow');

    // The same question, now answered: history, so the gap is marked, with no text and nothing to answer.
    chat([hugeQuestion, envelope(301, 'question_resolved', { requestId: 'q_big', answers: {} })]);
    const omitted = await send('GET', route);
    expect(omitted.status).toBe(200);
    expect(omitted.body.pendingQuestions).toEqual([]);
    expect(omitted.body.nextBeforeSeq).toBe(301);
    const older = await send('GET', `${route}?beforeSeq=301`);
    expect(older.status).toBe(200);
    const stub = older.body.events.find((e: any) => e.seq === 300);
    expect(stub).toMatchObject({ type: 'notice', data: { code: 'event_omitted', omitted: { type: 'question' } } });

    // An old queued row the tail would never reach, while its id is still in the queue.
    chat([envelope(4, 'user_message', { messageId: 'msg_q', delivery: 'queued', content: [{ type: 'text', text: 'Then run the tests.' }] }), ...large]);
    const withQueued = await send('GET', route);
    expect(withQueued.body.queuedMessageIds).toContain('msg_q');
    expect(withQueued.body.events[0].data.messageId).toBe('msg_q');
    expect(withQueued.body.events[0].seq).toBe(4);
    expect(withQueued.body.nextBeforeSeq).toBe(withQueued.body.events[1].seq);

    // A queued row with little room beside a question: shortened, and still itself. With none, no page.
    const criticalRow = envelope(4, 'user_message', { messageId: 'msg_q', source: 'user', delivery: 'queued', content: Array.from({ length: 10 }, () => ({ type: 'text', text: 't'.repeat(300 * 1024) })) });
    const beside = (bytes: number) => envelope(9, 'question', { requestId: 'q_beside', questions: [{ id: 'which', prompt: 'q'.repeat(bytes), header: 'Big', options: [] }] });
    chat([criticalRow, beside(Math.floor(7.5 * 1024 * 1024))]);
    const shortened = await send('GET', route);
    expect(shortened.status).toBe(200);
    expect(shortened.body.pendingQuestions[0].data.questions[0].prompt).toHaveLength(Math.floor(7.5 * 1024 * 1024));
    expect(shortened.body.queuedMessageIds).toContain('msg_q');
    const [rowShown] = shortened.body.events;
    expect(rowShown).toMatchObject({ seq: 4, type: 'user_message', data: { messageId: 'msg_q', source: 'user', delivery: 'queued', truncated: { originalBytes: expect.any(Number) } } });
    expect(rowShown.data.content).toHaveLength(10);
    expect(Buffer.byteLength(JSON.stringify(shortened.body))).toBeLessThanOrEqual(8 * 1024 * 1024);
    chat([criticalRow, beside(8 * 1024 * 1024 - 8 * 1024)]);
    expect((await send('GET', route)).status).toBe(503);

    // An answered question stays answered beside an active one taking most of the page: a phone folds the resolution.
    const sevenPointEight = Math.floor(7.8 * 1024 * 1024);
    const askedLongAgo = envelope(3, 'question', { requestId: 'q_old', questions: [{ id: 'which', prompt: 'Which branch?', header: 'Branch', options: [] }] });
    const answered = envelope(40, 'question_resolved', { requestId: 'q_old', answers: { which: 'a'.repeat(400 * 1024) } });
    const askedNow = envelope(41, 'question', { requestId: 'q_now', questions: [{ id: 'which', prompt: 'q'.repeat(sevenPointEight), header: 'Big', options: [] }] });
    chat([askedLongAgo, answered, askedNow]);
    const stillAnswered = await send('GET', route);
    expect(stillAnswered.status).toBe(200);
    expect(stillAnswered.body.pendingQuestions.map((e: any) => e.data.requestId)).toEqual(['q_now']);
    const resolution = stillAnswered.body.events.find((e: any) => e.seq === 40);
    expect(resolution).toMatchObject({ type: 'question_resolved', data: { requestId: 'q_old', answers: {} } });
    expect(stillAnswered.body.events.some((e: any) => e.type === 'notice')).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(stillAnswered.body))).toBeLessThanOrEqual(8 * 1024 * 1024);

    // Others that change state, the same way: a smaller form of the same type, or no page.
    chat([envelope(40, 'permission_resolved', { requestId: 'perm_old', decision: 'deny', by: 'user', optionId: 'o'.repeat(400 * 1024) }), askedNow]);
    const permissionDone = (await send('GET', route)).body.events.find((e: any) => e.seq === 40);
    expect(permissionDone).toMatchObject({ type: 'permission_resolved', data: { requestId: 'perm_old', decision: 'deny', by: 'user' } });
    chat([envelope(40, 'user_message', { messageId: 'msg_old', source: 'user', delivery: 'prompt', content: [{ type: 'text', text: 'm'.repeat(400 * 1024) }] }), askedNow]);
    const deliveredShort = (await send('GET', route)).body.events.find((e: any) => e.seq === 40);
    expect(deliveredShort).toMatchObject({ type: 'user_message', data: { messageId: 'msg_old', delivery: 'prompt' } });
    const manyIds = Array.from({ length: 30_000 }, (_, i) => `message_${i}`);
    chat([envelope(40, 'queue_state', { queuedMessageIds: manyIds, transition: { messageIds: manyIds, status: 'queued' } }), askedNow]);
    expect((await send('GET', route)).status).toBe(503);
    chat([envelope(40, 'plan', { entries: Array.from({ length: 30_000 }, (_, i) => ({ content: `entry ${i}`, status: 'pending' })) }), askedNow]);
    expect((await send('GET', route)).status).toBe(503);

    chat(LIVE_TRANSCRIPT);
    fixtures.set('chat-pages.json', {
      note: 'Bodies are shortened to what shows the rule. A 503 leaves a phone read-only until a refresh works.',
      byBytes: { status: byBytes.status, body: { ...shorten(byBytes.body), nextBeforeSeq: '<the oldest seq shown>' } },
      minimal: { status: minimal.status, body: { ...shorten(minimal.body), pendingPermissions: [{ ...row, data: { ...row.data, truncated: { originalBytes: 307400 } } }], pendingPermissionCount: minimal.body.pendingPermissions.length } },
      overflow: { status: noPage.status, body: noPage.body },
      queuedRowShortened: { note: 'Beside a question that leaves little room. Only its text is shortened: its ids, source, delivery, every block and part stay. Too little room for this, and the answer is a 503.', status: shortened.status, event: { ...rowShown, data: { ...rowShown.data, content: rowShown.data.content.slice(0, 1).map((b: any) => ({ type: b.type, text: `${b.text.slice(0, 40)}<shortened here>` })), contentBlocks: rowShown.data.content.length } } },
      smallestForms: { note: 'Fold these as usual. Empty answers with truncated still means answered. A queue_state or anything without a form here makes the page a 503.', questionResolved: resolution, permissionResolved: { ...permissionDone }, userMessage: deliveredShort },
      omittedQuestion: { note: 'A question in history too large for any page. Not pending, so nothing to answer.', event: stub },
      queuedRow: { note: 'A row named by queuedMessageIds, in front of a tail that does not reach it. nextBeforeSeq does not count it.', firstEvents: withQueued.body.events.slice(0, 2).map((e: any) => ({ seq: e.seq, type: e.type, ...(e.type === 'user_message' && { data: e.data }) })), nextBeforeSeq: '<the seq of the second event>', queuedMessageIds: withQueued.body.queuedMessageIds },
    });
  }, TEST_TIMEOUT_MS);

  it('fixtures on disk match (npm run fixtures:annex-mobile to update)', () => {
    const rendered = render();
    if (WRITE) {
      fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
      for (const [name, text] of rendered) {
        fs.mkdirSync(path.dirname(path.join(FIXTURE_DIR, name)), { recursive: true });
        fs.writeFileSync(path.join(FIXTURE_DIR, name), text);
      }
      fs.writeFileSync(path.join(FIXTURE_DIR, 'index.json'), `${JSON.stringify({ version: 1, files: [...rendered.keys()].sort() }, null, 2)}\n`);
      return;
    }
    const onDisk = fs.existsSync(FIXTURE_DIR) ? fs.readdirSync(FIXTURE_DIR, { recursive: true }).map(String).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => f.split(path.sep).join('/')).sort() : [];
    const stale = [...rendered].filter(([name, text]) => !fs.existsSync(path.join(FIXTURE_DIR, name)) || fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8') !== text).map(([name]) => name);
    const extra = onDisk.filter((name) => !rendered.has(name));
    // The first line that differs in each stale file, so a CI failure says what changed.
    const firstDifference = Object.fromEntries(stale.map((name) => {
      const file = path.join(FIXTURE_DIR, name);
      const was = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
      const now = rendered.get(name)!.split('\n');
      const line = now.findIndex((text, i) => text !== was[i]);
      return [name, { line: line + 1, onDisk: was[line] ?? null, generated: now[line] ?? null }];
    }));
    expect({ stale, extra, firstDifference }, 'Annex mobile fixtures are out of date: run `npm run fixtures:annex-mobile` and commit the result').toEqual({ stale: [], extra: [], firstDifference: {} });
  });
});
