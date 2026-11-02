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
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import { EventEmitter } from 'events';

const W = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
  durables: {} as Record<string, Array<Record<string, any>>>,
  running: new Set<string>(),
  revert: new Set<string>(),
  transcripts: {} as Record<string, unknown[]>,
  sessions: {} as Record<string, unknown[]>,
  projectsThrow: false,
  spawnShellError: null as string | null,
  ptyData: [] as Array<(id: string, data: string, seq: number) => void>,
  ptyExit: [] as Array<(id: string, code: number) => void>,
  peers: new Map<string, any>(),
  tls: null as null | Record<string, unknown>,
  tlsFingerprint: '',
  helperStart: 'approve' as 'approve' | 'blocked' | 'refused',
  dispose: { ok: true } as Record<string, unknown>,
  projectStateReady: true,
  finishedReady: true,
  // The app-wide Dispatcher (#2533): off unless a test turns it on.
  dispatcher: { flagOn: false, enabled: false, newLayout: true },
  dispatcherListeners: new Set<(state: any) => void>(),
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
vi.mock('./project-store', () => ({
  list: async () => { if (W.projectsThrow) throw new Error('disk gone'); return W.projects; },
  readIconData: async (icon: string) => (icon ? 'data:image/png;base64,iVBORw0KGgo=' : null),
}));
vi.mock('./agent-config', () => {
  const find = (projectPath: string, id: string) => (W.durables[projectPath] ?? []).find((d) => d.id === id) ?? null;
  return {
    listDurable: async (projectPath: string) => W.durables[projectPath] ?? [],
    readAgentIconData: async (icon: string) => (icon ? 'data:image/png;base64,R0lGODlhAQABAAAAACw=' : null),
    getDurableConfig: async (projectPath: string, id: string) => find(projectPath, id),
    updateDurableConfig: async (projectPath: string, id: string, updates: Record<string, unknown>) => { Object.assign(find(projectPath, id) ?? {}, updates); },
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
vi.mock('./plugin-storage', () => ({ readKey: async () => null, writeKey: async () => {} }));
const ORCHESTRATORS = vi.hoisted(() => [
  { id: 'claude-code', displayName: 'Claude Code', shortName: 'CC', badge: 'Beta', capabilities: { permissions: true, headless: true, structuredOutput: true, hooks: true, sessionResume: true } },
  { id: 'codex-cli', displayName: 'Codex', shortName: 'CX', capabilities: { permissions: false, headless: true, structuredOutput: false, hooks: false, sessionResume: true } },
]);
vi.mock('./agent-system', () => ({
  getAvailableOrchestrators: () => ORCHESTRATORS,
  checkAvailability: async (_path: string, id: string) => (id === 'codex-cli' ? { available: false, error: 'Codex CLI not found' } : { available: true }),
  resolveOrchestrator: async (_path: string, id?: string) => ({
    id: id ?? 'claude-code',
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
  readProjectAgentDefaults: async () => ({}),
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
vi.mock('./orchestration-settings', () => ({ getSettings: () => ({ globalHelperCap: 20 }), getGlobalHelperCap: () => 20 }));
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
import { registerChatRuntime, clearChatRuntimes, publishChatEvent } from './agent-runtime';
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
    efforts: ['low', 'medium', 'high'], levelNames: { ask: 'default', plan: 'plan' }, mcpServers: [{ name: 'github', status: 'connected' }] }),
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
  _resetStartRequestsForTesting();
  _resetDisposeRequestsForTesting();
}

function helperStart(): string {
  const result = recordStartRequest(APP, 'durable_chat', 'planner', { name: 'impl-ipc', task: 'Wire the IPC', model: 'opus' }, NOW - 600_000);
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
const exchange = async (method: string, route: string, body?: object) => ({ request: { method, path: route, ...(body && { body }) }, response: await send(method, route, body).then(({ status, body }) => ({ status, body })) });

type FakeWs = EventEmitter & { readyState: number; send: ReturnType<typeof vi.fn>; ping: () => void; close: () => void };
async function connect(auth: 'mtls' | 'bearer' = 'mtls'): Promise<FakeWs> {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), ping: () => {}, close: () => {} }) as FakeWs;
  annexServer._testing.wsAuthTypes.set(ws as never, auth);
  if (auth === 'mtls') annexServer._testing.wsPeerFingerprints.set(ws as never, 'mobile-fixture-identity');
  annexServer._testing.wss!.clients.add(ws as never);
  annexServer._testing.wss!.emit('connection', ws);
  await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
  return ws;
}
const frames = (ws: FakeWs) => ws.send.mock.calls.map((c) => JSON.parse(c[0] as string));
/** Send a client frame and collect what this connection gets back. */
async function roundTrip(ws: FakeWs, frame: object, count = 1) {
  ws.send.mockClear();
  ws.emit('message', JSON.stringify(frame));
  if (count > 0) await vi.waitFor(() => expect(ws.send.mock.calls.length).toBeGreaterThanOrEqual(count));
  else await new Promise((r) => setTimeout(r, 20));
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

// ── Suite ────────────────────────────────────────────────────────────────────

describe('Annex mobile contract fixtures', () => {
  beforeAll(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const server = certificate('clubhouse-fixture-desktop');
    client = certificate('mobile-fixture-identity');
    W.tls = { ...server, requestCert: true, rejectUnauthorized: false };
    W.tlsFingerprint = new crypto.X509Certificate(server.cert).fingerprint256;
    resetWorld();
    annexServer.start();
    await vi.waitFor(() => expect(annexServer.getStatus().port).toBeGreaterThan(0));
    port = annexServer.getStatus().port;
    const publicKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const pair = await send('POST', '/pair', { pin: annexServer.getStatus().pin, publicKey, alias: 'Mason’s iPhone', icon: 'iphone', color: 'emerald', pairingMode: 'persistent' });
    expect(pair.status).toBe(200);
    bearerToken = pair.body.token;
    fixtures.set('pairing.json', { request: { method: 'POST', path: '/pair', body: { pin: '123456', publicKey: '<base64 Ed25519 SPKI DER>', alias: 'Mason’s iPhone', icon: 'iphone', color: 'emerald', pairingMode: 'persistent' } },
      // The client certificate is generated per run.
      response: { status: pair.status, body: { ...pair.body, tlsCertificateFingerprint: Array(32).fill('AB').join(':') } } });
  });
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
    _resetStartRequestsForTesting(); _resetDisposeRequestsForTesting();
    fixtures.set('rest-catalog.json', {
      projects: await exchange('GET', '/api/v1/projects'),
      agents: await exchange('GET', '/api/v1/projects/proj_app/agents'),
      unknownProject: await exchange('GET', '/api/v1/projects/missing/agents'),
    });
  });

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
    _resetStartRequestsForTesting();
    W.helperStart = 'refused';
    await command('helper_start_refused', { type: 'helper.approve', requestId: helperStart() });
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
    // Sequence numbers depend on what the suite published before; the shape is the contract.
    const offset = (n: number) => (typeof n === 'number' ? n - before + 1000 : n);
    const renumber = (list: any[]) => list.map((f) => ({ ...f, ...('seq' in f && { seq: offset(f.seq) }), ...('fromSeq' in f && { fromSeq: offset(f.fromSeq) }),
      ...('toSeq' in f && { toSeq: offset(f.toSeq) }), ...('lastSeq' in f && { lastSeq: offset(f.lastSeq) }), ...('oldestAvailable' in f && { oldestAvailable: 1 }) }));
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
    await vi.waitFor(() => expect(frames(ws).some((f) => f.type === 'snapshot')).toBe(true));
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
    await vi.waitFor(() => expect(frames(ws).some((f) => f.type === 'snapshot')).toBe(true));
    const changedOff = frames(ws).find((f) => f.type === 'dispatcher:changed');
    expect(frames(ws).find((f) => f.type === 'snapshot').payload.dispatcher).toBeNull();
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

  it('Clubhouse MCP off refuses turning orchestration on (#2589)', async () => {
    W.durables[APP][0].mcpOverride = false;
    await command('mcp_off', { type: 'agent.update', agentId: 'durable_chat', orchestration: { orchestrate: true } });
    delete W.durables[APP][0].mcpOverride;
  });

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
