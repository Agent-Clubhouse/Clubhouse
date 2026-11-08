import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DurableAgentConfig, DurableConfigUpdates } from '../../../shared/types';

const h = vi.hoisted(() => ({
  baseDir: '',
  experimental: {} as Record<string, boolean>,
  newLayout: true,
  detection: Promise.resolve() as Promise<void>,
  enabledProviders: ['claude-code'] as string[],
  agents: new Map<string, DurableAgentConfig[]>(),
  configListeners: new Set<(projectPath: string) => void>(),
  running: new Set<string>(),
  nextId: 1,
}));

vi.mock('../base-dir', () => ({ getBaseDirPath: () => h.baseDir }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../experimental-settings', () => ({ getSettings: () => h.experimental }));
vi.mock('../../window-chrome', () => ({ newChromeEnabled: () => h.newLayout }));
vi.mock('../orchestrator-settings', () => ({ getSettings: () => ({ enabled: h.enabledProviders }), whenDefaultsDetected: () => h.detection }));

// In-memory settings, so nothing touches userData.
vi.mock('../settings-store', () => ({
  createSettingsStore: <T,>(_file: string, defaults: T) => {
    let value = { ...defaults };
    return {
      get: () => value,
      save: async (v: T) => { value = v; },
      update: async (fn: (c: T) => T) => { value = fn(value); return value; },
    };
  },
}));

// Each CLI writes its own instructions file, as the real providers do.
function fakeProvider(id: string, file: string) {
  return {
    id,
    writeInstructions: vi.fn(async (dir: string, content: string) => {
      await fs.promises.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await fs.promises.writeFile(path.join(dir, file), content);
    }),
  };
}
const providers = vi.hoisted(() => ({ list: [] as Array<ReturnType<typeof fakeProvider>> }));
vi.mock('../../orchestrators', () => ({
  getAllProviders: () => providers.list,
  getProvider: (id: string) => providers.list.find((p) => p.id === id),
}));

function notify(projectPath: string) {
  for (const l of h.configListeners) l(projectPath);
}
vi.mock('../agent-config', () => ({
  listDurable: vi.fn(async (dir: string) => (h.agents.get(dir) ?? []).map((a) => ({ ...a }))),
  getDurableConfig: vi.fn(async (dir: string, id: string) => h.agents.get(dir)?.find((a) => a.id === id) ?? null),
  createDurable: vi.fn(async (dir: string, name: string, color: string, model: string | undefined, _wt: boolean, orchestrator: string | undefined, freeAgentMode: boolean | undefined) => {
    const config: DurableAgentConfig = {
      id: `durable_${h.nextId++}`, name, color, createdAt: 'now',
      ...(model ? { model } : {}), ...(orchestrator ? { orchestrator } : {}),
      ...(freeAgentMode ? { freeAgentMode } : {}),
    };
    h.agents.set(dir, [...(h.agents.get(dir) ?? []), config]);
    notify(dir);
    return config;
  }),
  updateDurableConfig: vi.fn(async (dir: string, id: string, updates: DurableConfigUpdates) => {
    const agent = h.agents.get(dir)?.find((a) => a.id === id);
    if (!agent) return;
    Object.assign(agent, updates);
    notify(dir);
  }),
  updateDurable: vi.fn(async (dir: string, id: string, updates: { name?: string; color?: string; icon?: string | null; emoji?: string | null }) => {
    const agent = h.agents.get(dir)?.find((a) => a.id === id) as Record<string, unknown> | undefined;
    if (!agent) return;
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') delete agent[key];
      else agent[key] = value;
    }
    notify(dir);
  }),
  onAgentConfigChanged: (l: (p: string) => void) => { h.configListeners.add(l); return () => { h.configListeners.delete(l); }; },
}));

// Every way an agent starts goes through spawnAgent, so "never called" means no tokens.
vi.mock('../agent-system', () => ({
  isAgentRunning: (id: string) => h.running.has(id),
  killAgent: vi.fn(async (id: string) => { h.running.delete(id); }),
  spawnAgent: vi.fn(),
}));

import * as agentConfig from '../agent-config';
import * as agentSystem from '../agent-system';
import * as svc from './dispatcher-service';
import { getSettings, updateSettings } from './dispatcher-settings';
import { agentRegistry } from '../agent-registry';
import { DISPATCHER_CLASSIC_MESSAGE } from '../../../shared/dispatcher-types';

const dispatcherDir = () => path.join(h.baseDir, 'dispatcher');
const chatDir = () => path.join(h.baseDir, 'dispatcher-chat');

/** Let queued config refreshes run: they wait on real file reads. */
const settle = () => svc._whenIdleForTesting();

beforeEach(async () => {
  h.baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-test-'));
  h.experimental = {};
  h.newLayout = true;
  h.detection = Promise.resolve();
  h.enabledProviders = ['claude-code'];
  h.agents.clear();
  h.configListeners.clear();
  h.running.clear();
  h.nextId = 1;
  providers.list = [
    fakeProvider('claude-code', 'CLAUDE.md'),
    fakeProvider('copilot-cli', path.join('.github', 'copilot-instructions.md')),
    fakeProvider('codex-cli', 'AGENTS.md'),
  ];
  svc._resetDispatcherForTesting();
  await updateSettings(() => ({}));
  for (const agentId of agentRegistry.getAllRegistrations().keys()) agentRegistry.untrack(agentId);
  vi.mocked(agentConfig.createDurable).mockClear();
  vi.mocked(agentConfig.updateDurable).mockClear();
  vi.mocked(agentConfig.updateDurableConfig).mockClear();
  vi.mocked(agentSystem.killAgent).mockClear();
  vi.mocked(agentSystem.spawnAgent).mockClear();
});

afterEach(async () => {
  // A config refresh still queued would run in the next test against this deleted folder.
  await settle();
  h.configListeners.clear();
  fs.rmSync(h.baseDir, { recursive: true, force: true });
});

describe('gating', () => {
  it('is on by default in the new layout: creates and connects, and never starts it', async () => {
    await svc.initDispatcher();
    expect(svc.getDispatcherState()).toMatchObject({
      enabled: true, savedOn: true, flagOn: true, offReason: null, running: false, agentId: 'durable_1', path: dispatcherDir(),
      chatAgentId: 'durable_2', chatPath: chatDir(), chatRunning: false,
    });
    // The Dispatcher and its chat (#3036).
    expect(agentConfig.createDurable).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(dispatcherDir(), 'CLAUDE.md'), 'utf-8')).toContain(svc.DISPATCHER_INSTRUCTIONS);
    expect(fs.readFileSync(path.join(chatDir(), 'CLAUDE.md'), 'utf-8')).toContain(svc.DISPATCHER_CHAT_INSTRUCTIONS);
    // What default-on must not do: start the agent, so no tokens are spent.
    expect(agentSystem.spawnAgent).not.toHaveBeenCalled();
    expect(agentRegistry.get('durable_1')).toBeUndefined();
    expect(agentRegistry.get('durable_2')).toBeUndefined();
    // And it saves nothing: the switch stays missing, so the default can still move.
    expect(getSettings().enabled).toBeUndefined();
  });

  it('waits for first-run CLI detection before creating, so a Codex-only install isn\'t pinned to Claude', async () => {
    let finish!: () => void;
    h.detection = new Promise((resolve) => { finish = resolve; });
    const init = svc.initDispatcher();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(agentConfig.createDurable).not.toHaveBeenCalled();
    h.enabledProviders = ['codex-cli'];
    finish();
    await init;
    expect(svc.getDispatcherState().config?.orchestrator).toBe('codex-cli');
    expect(fs.readFileSync(path.join(dispatcherDir(), 'AGENTS.md'), 'utf-8')).toContain(svc.DISPATCHER_INSTRUCTIONS);
  });

  it('is off on the classic layout with nothing saved, and creates nothing at start-up', async () => {
    h.newLayout = false;
    await svc.initDispatcher();
    expect(svc.isDispatcherEnabled()).toBe(false);
    expect(svc.getDispatcherState()).toMatchObject({ enabled: false, savedOn: false, offReason: 'classic_layout', classic: true, agentId: null, path: null, config: null });
    expect(fs.existsSync(dispatcherDir())).toBe(false);
    expect(agentConfig.createDurable).not.toHaveBeenCalled();
  });

  it('keeps a saved true on, on the classic layout: it can be turned off, and not back on (#2565)', async () => {
    await updateSettings(() => ({ enabled: true }));
    h.newLayout = false;
    await svc.initDispatcher();
    expect(svc.getDispatcherState()).toMatchObject({ enabled: true, classic: true, agentId: 'durable_1' });
    await svc.setDispatcherEnabled(true); // Already on: nothing to refuse.
    await svc.setDispatcherEnabled(false);
    expect(svc.getDispatcherState()).toMatchObject({ enabled: false, offReason: 'switch_off' });
    await expect(svc.setDispatcherEnabled(true)).rejects.toThrow(DISPATCHER_CLASSIC_MESSAGE);
    expect(getSettings().enabled).toBe(false);
  });

  it('refuses turning it on from missing on the classic layout, and saves nothing', async () => {
    h.newLayout = false;
    await expect(svc.setDispatcherEnabled(true)).rejects.toThrow(DISPATCHER_CLASSIC_MESSAGE);
    expect(getSettings().enabled).toBeUndefined();
  });

  it('keeps a saved false off, in the new layout, and creates nothing', async () => {
    await updateSettings(() => ({ enabled: false }));
    await svc.initDispatcher();
    expect(svc.getDispatcherState()).toMatchObject({ enabled: false, savedOn: false, offReason: 'switch_off', agentId: null });
    expect(agentConfig.createDurable).not.toHaveBeenCalled();
  });

  it('reads a saved experimental false as off until the switch says otherwise', async () => {
    h.experimental = { dispatcher: false };
    await svc.initDispatcher();
    expect(svc.getDispatcherState()).toMatchObject({ enabled: false, offReason: 'experimental_off', agentId: null });
    expect(agentConfig.createDurable).not.toHaveBeenCalled();
    await svc.setDispatcherEnabled(true);
    expect(svc.getDispatcherState()).toMatchObject({ enabled: true, agentId: 'durable_1' });
  });

  it('a saved experimental true changes nothing', async () => {
    h.experimental = { dispatcher: true };
    await svc.initDispatcher();
    expect(svc.getDispatcherState()).toMatchObject({ enabled: true });
    await svc.setDispatcherEnabled(false);
    expect(svc.getDispatcherState()).toMatchObject({ enabled: false, offReason: 'switch_off' });
  });

  it('a saved experimental flag going off stops the agent, as its switch would', async () => {
    await svc.initDispatcher();
    h.running.add('durable_1');
    h.experimental = { dispatcher: false };
    await svc.onExperimentalSettingsChanged();
    expect(agentSystem.killAgent).toHaveBeenCalledWith('durable_1', dispatcherDir(), 'claude-code');
    expect(svc.getDispatcherState().enabled).toBe(false);
    expect(fs.existsSync(dispatcherDir())).toBe(true);
  });
});

describe('Clubhouse MCP', () => {
  it('never turns it off: an old saved MCP switch means nothing, and phones always read flagOn', async () => {
    await svc.initDispatcher();
    expect(svc.getDispatcherState()).toMatchObject({ enabled: true, flagOn: true, offReason: null });
    expect(svc.getDispatcherState()).not.toHaveProperty('mcpOff');
  });
});

describe('turning it on', () => {
  it('creates the folder, its memory and its agent with the defaults, then its chat on top', async () => {
    const state = await svc.setDispatcherEnabled(true);
    expect(fs.existsSync(path.join(dispatcherDir(), 'notes'))).toBe(false);
    for (const dir of ['agents', 'timeline', 'topics']) {
      expect(fs.statSync(path.join(dispatcherDir(), 'memory', dir)).isDirectory()).toBe(true);
    }
    expect(agentConfig.createDurable).toHaveBeenCalledTimes(2);
    const call = vi.mocked(agentConfig.createDurable).mock.calls[0];
    const [dir, name, , model, useWorktree, orchestrator, freeAgentMode] = call;
    expect(dir).toBe(dispatcherDir());
    expect(name).toBe('Dispatcher');
    expect(model).toBeUndefined();
    expect(useWorktree).toBe(false);
    expect(orchestrator).toBe('claude-code');
    expect(freeAgentMode).toBe(true);
    // No persona (#2901): the Dispatcher is known by its folder and id.
    expect(call).toHaveLength(7);
    expect(state.config).toMatchObject({ idleSleep: 'never', runtimeMode: 'chat' });
    expect(state.config).not.toHaveProperty('mcpOverride');
    expect(state.config?.persona).toBeUndefined();
    // The chat: its own folder, the same name, look and CLI, and the same defaults.
    const [chatFolder, chatName, chatColor, , chatWorktree, chatOrchestrator] = vi.mocked(agentConfig.createDurable).mock.calls[1];
    expect(chatFolder).toBe(chatDir());
    expect(chatName).toBe(name);
    expect(chatColor).toBe(call[2]);
    expect(chatWorktree).toBe(false);
    expect(chatOrchestrator).toBe('claude-code');
    expect(h.agents.get(chatDir())?.[0]).toMatchObject({ id: state.chatAgentId, idleSleep: 'never', runtimeMode: 'chat' });
  });

  it('is idempotent across toggles and restarts', async () => {
    await svc.setDispatcherEnabled(true);
    await svc.setDispatcherEnabled(true);
    svc._resetDispatcherForTesting();
    await svc.initDispatcher();
    expect(agentConfig.createDurable).toHaveBeenCalledTimes(2);
    expect(h.agents.get(dispatcherDir())).toHaveLength(1);
    expect(h.agents.get(chatDir())).toHaveLength(1);
    expect(svc.getDispatcherAgentId()).toBe('durable_1');
    expect(svc.getDispatcherChatAgentId()).toBe('durable_2');
  });

  it('follows the app default CLI, never assuming Claude', async () => {
    h.enabledProviders = ['codex-cli'];
    const state = await svc.setDispatcherEnabled(true);
    expect(state.config?.orchestrator).toBe('codex-cli');
    expect(fs.readFileSync(path.join(dispatcherDir(), 'AGENTS.md'), 'utf-8')).toContain(svc.DISPATCHER_INSTRUCTIONS);
    expect(fs.existsSync(path.join(dispatcherDir(), 'CLAUDE.md'))).toBe(false);
  });

  it('writes its own instructions at create and again on start-up', async () => {
    await svc.setDispatcherEnabled(true);
    const file = path.join(dispatcherDir(), 'CLAUDE.md');
    expect(fs.readFileSync(file, 'utf-8')).toContain(svc.DISPATCHER_INSTRUCTIONS);
    fs.writeFileSync(file, 'stale');
    svc._resetDispatcherForTesting();
    await svc.initDispatcher();
    expect(fs.readFileSync(file, 'utf-8')).toContain(svc.DISPATCHER_INSTRUCTIONS);
  });

  it('loads its memory index into the instructions file, on any CLI', async () => {
    h.enabledProviders = ['codex-cli'];
    await svc.setDispatcherEnabled(true);
    fs.writeFileSync(path.join(dispatcherDir(), 'memory', 'index.md'), 'Release 1.0 is waiting on checkout.\n');
    svc._resetDispatcherForTesting();
    await svc.initDispatcher();
    const written = fs.readFileSync(path.join(dispatcherDir(), 'AGENTS.md'), 'utf-8');
    expect(written.startsWith(svc.DISPATCHER_INSTRUCTIONS.trimEnd())).toBe(true);
    expect(written).toContain('Release 1.0 is waiting on checkout.');
  });

  it('sorts an existing notes/ folder into memory before writing its instructions', async () => {
    fs.mkdirSync(path.join(dispatcherDir(), 'notes'), { recursive: true });
    fs.writeFileSync(path.join(dispatcherDir(), 'notes', 'checkout.md'), '# Checkout\n\nwebapp-lead owns it.\n');
    await svc.setDispatcherEnabled(true);
    const written = fs.readFileSync(path.join(dispatcherDir(), 'CLAUDE.md'), 'utf-8');
    expect(written).toContain('topics/checkout.md');
    expect(fs.existsSync(path.join(dispatcherDir(), 'notes'))).toBe(false);
    expect(fs.readFileSync(path.join(dispatcherDir(), 'notes-archive', 'checkout.md'), 'utf-8')).toBe('# Checkout\n\nwebapp-lead owns it.\n');
  });

  it('ships its instructions from dispatcher-instructions.md', () => {
    expect(svc.DISPATCHER_INSTRUCTIONS).toContain('Dispatcher');
    expect(svc.DISPATCHER_INSTRUCTIONS).not.toMatch(/^---/);
  });

  it('keeps working with a config from before #2901 that still has persona: dispatcher', async () => {
    fs.mkdirSync(path.join(dispatcherDir(), 'notes'), { recursive: true });
    h.agents.set(dispatcherDir(), [{ id: 'durable_old', name: 'Dispatcher', color: 'indigo', createdAt: 'then', orchestrator: 'claude-code', persona: 'dispatcher' }]);
    await svc.setDispatcherEnabled(true);
    // Only the chat is new (#3036).
    expect(vi.mocked(agentConfig.createDurable).mock.calls.map((c) => c[0])).toEqual([chatDir()]);
    expect(svc.getDispatcherAgentId()).toBe('durable_old');
    expect(svc.isDispatcherAgentId('durable_old')).toBe(true);
    expect(fs.readFileSync(path.join(dispatcherDir(), 'CLAUDE.md'), 'utf-8')).toContain(svc.DISPATCHER_INSTRUCTIONS);
  });

  it('rewrites instructions for a new CLI', async () => {
    await svc.setDispatcherEnabled(true);
    const changed = vi.fn();
    svc.onDispatcherChanged(changed);
    await agentConfig.updateDurableConfig(dispatcherDir(), 'durable_1', { orchestrator: 'copilot-cli' });
    await settle();
    const file = path.join(dispatcherDir(), '.github', 'copilot-instructions.md');
    expect(fs.readFileSync(file, 'utf-8')).toContain(svc.DISPATCHER_INSTRUCTIONS);
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ orchestrator: 'copilot-cli' }) }));
  });
});

describe('turning it off', () => {
  it('stops the agent and keeps the folder, memory and config for turning back on', async () => {
    await svc.setDispatcherEnabled(true);
    const page = path.join(dispatcherDir(), 'memory', 'topics', 'plan.md');
    fs.writeFileSync(page, 'keep me');
    h.running.add('durable_1');
    h.running.add('durable_2');

    const off = await svc.setDispatcherEnabled(false);
    // Both of its agents stop.
    expect(agentSystem.killAgent).toHaveBeenCalledTimes(2);
    expect(agentSystem.killAgent).toHaveBeenCalledWith('durable_2', chatDir(), 'claude-code');
    expect(agentSystem.killAgent).toHaveBeenCalledWith('durable_1', dispatcherDir(), 'claude-code');
    expect(off).toMatchObject({ enabled: false, agentId: 'durable_1', path: dispatcherDir() });
    expect(fs.readFileSync(page, 'utf-8')).toBe('keep me');

    const on = await svc.setDispatcherEnabled(true);
    expect(on.agentId).toBe('durable_1');
    expect(on.chatAgentId).toBe('durable_2');
    expect(agentConfig.createDurable).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(page, 'utf-8')).toBe('keep me');
  });

  it('does not stop an agent that is not running', async () => {
    await svc.setDispatcherEnabled(true);
    await svc.setDispatcherEnabled(false);
    expect(agentSystem.killAgent).not.toHaveBeenCalled();
  });
});

describe('change events', () => {
  it('carry a new look, and a restart keeps it (#2645)', async () => {
    await svc.setDispatcherEnabled(true);
    await settle();
    const changed = vi.fn();
    svc.onDispatcherChanged(changed);

    await agentConfig.updateDurableConfig(dispatcherDir(), 'durable_1', { color: 'rose', emoji: '🦊' } as DurableConfigUpdates);
    await settle();
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({
      agentId: 'durable_1', config: expect.objectContaining({ color: 'rose', emoji: '🦊' }),
    }));

    svc._resetDispatcherForTesting();
    await svc.initDispatcher();
    expect(svc.getDispatcherState().config).toMatchObject({ color: 'rose', emoji: '🦊', name: 'Dispatcher' });
  });

  it('fire once per real change', async () => {
    const changed = vi.fn();
    svc.onDispatcherChanged(changed);
    await svc.setDispatcherEnabled(true);
    await settle();
    const calls = changed.mock.calls.length;
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, agentId: 'durable_1' }));
    await svc.setDispatcherEnabled(true);
    expect(changed).toHaveBeenCalledTimes(calls);
  });
});

describe('isDispatcherPath', () => {
  const realPlatform = process.platform;
  afterEach(() => { Object.defineProperty(process, 'platform', { value: realPlatform }); });

  it('matches the folder however it is written', () => {
    expect(svc.isDispatcherPath(dispatcherDir())).toBe(true);
    expect(svc.isDispatcherPath(path.join(dispatcherDir(), 'notes', '..'))).toBe(true);
    expect(svc.isDispatcherPath(path.join(h.baseDir, 'other'))).toBe(false);
    expect(svc.isDispatcherPath(undefined)).toBe(false);
  });

  it('ignores case on Windows only', () => {
    const upper = dispatcherDir().toUpperCase();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(svc.isDispatcherPath(upper)).toBe(true);
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(svc.isDispatcherPath(upper)).toBe(upper === dispatcherDir());
  });
});

describe('two agents, one identity (#3036)', () => {
  it('upgrades an existing Dispatcher: it keeps its id, and the chat is added with its name, look and settings', async () => {
    fs.mkdirSync(path.join(dispatcherDir(), 'notes'), { recursive: true });
    h.agents.set(dispatcherDir(), [{
      id: 'durable_existing', name: 'Rosie', color: 'rose', emoji: '🦊', createdAt: 'then', orchestrator: 'codex-cli',
      model: 'gpt-5', runtimeMode: 'chat', idleSleep: 'never', access: 'auto', freeAgentMode: true, lastSessionId: 'session-old',
    }]);
    const state = await svc.setDispatcherEnabled(true);
    expect(state).toMatchObject({ agentId: 'durable_existing', path: dispatcherDir(), chatPath: chatDir() });
    expect(state.chatAgentId).not.toBe('durable_existing');
    const chat = h.agents.get(chatDir())?.[0];
    expect(chat).toMatchObject({ name: 'Rosie', color: 'rose', emoji: '🦊', orchestrator: 'codex-cli', model: 'gpt-5', runtimeMode: 'chat', idleSleep: 'never', access: 'auto' });
    // Its own conversation: nothing per agent is copied.
    expect(chat?.lastSessionId).toBeUndefined();
    expect(h.agents.get(dispatcherDir())).toHaveLength(1);
    expect(fs.readFileSync(path.join(chatDir(), 'AGENTS.md'), 'utf-8')).toContain(svc.DISPATCHER_CHAT_INSTRUCTIONS);
    expect(fs.readFileSync(path.join(dispatcherDir(), 'AGENTS.md'), 'utf-8')).toContain(svc.DISPATCHER_INSTRUCTIONS);
  });

  it('copies a change from either record onto the other, once', async () => {
    await svc.setDispatcherEnabled(true);
    await settle();
    // Settings > Dispatcher edits the Dispatcher's own record.
    await agentConfig.updateDurableConfig(dispatcherDir(), 'durable_1', { model: 'opus' });
    await settle();
    expect(h.agents.get(chatDir())?.[0].model).toBe('opus');
    // The chat's details or a phone edit the chat's.
    await agentConfig.updateDurable(chatDir(), 'durable_2', { name: 'Rosie', color: 'teal' });
    await settle();
    expect(h.agents.get(dispatcherDir())?.[0]).toMatchObject({ name: 'Rosie', color: 'teal' });
    expect(svc.getDispatcherState().config).toMatchObject({ name: 'Rosie', color: 'teal', model: 'opus' });
    // Settled: nothing bounces back and forth.
    const writes = vi.mocked(agentConfig.updateDurable).mock.calls.length + vi.mocked(agentConfig.updateDurableConfig).mock.calls.length;
    notify(dispatcherDir());
    notify(chatDir());
    await settle();
    expect(vi.mocked(agentConfig.updateDurable).mock.calls.length + vi.mocked(agentConfig.updateDurableConfig).mock.calls.length).toBe(writes);
  });

  it('rewrites the chat\'s instructions for a new CLI too', async () => {
    await svc.setDispatcherEnabled(true);
    await agentConfig.updateDurableConfig(dispatcherDir(), 'durable_1', { orchestrator: 'copilot-cli' });
    await settle();
    expect(fs.readFileSync(path.join(chatDir(), '.github', 'copilot-instructions.md'), 'utf-8')).toContain(svc.DISPATCHER_CHAT_INSTRUCTIONS);
  });

  it('tells the two ids apart, and sends the chat\'s settings to the Dispatcher\'s record', async () => {
    await svc.setDispatcherEnabled(true);
    expect(svc.isDispatcherAgentId('durable_1')).toBe(true);
    expect(svc.isDispatcherAgentId('durable_2')).toBe(false);
    expect(svc.isDispatcherChatAgentId('durable_2')).toBe(true);
    expect(svc.isDispatcherIdentityAgentId('durable_1')).toBe(true);
    expect(svc.isDispatcherIdentityAgentId('durable_2')).toBe(true);
    expect(svc.isDispatcherIdentityAgentId('durable_9')).toBe(false);
    expect(svc.resolveDispatcherIdentity(chatDir(), 'durable_2')).toEqual({ projectPath: dispatcherDir(), agentId: 'durable_1' });
    expect(svc.resolveDispatcherIdentity('/p', 'other')).toEqual({ projectPath: '/p', agentId: 'other' });
    expect(svc.getDispatcherChatConfig()).toMatchObject({ id: 'durable_2', name: 'Dispatcher' });
  });

  it('rewrites each agent\'s instructions before its session starts, and nothing else\'s', async () => {
    await svc.setDispatcherEnabled(true);
    const chatFile = path.join(chatDir(), 'CLAUDE.md');
    const ownFile = path.join(dispatcherDir(), 'CLAUDE.md');
    fs.writeFileSync(chatFile, 'stale');
    fs.writeFileSync(ownFile, 'stale');
    await svc.prepareDispatcherSessionStart(chatDir(), 'durable_2');
    expect(fs.readFileSync(chatFile, 'utf-8')).toContain(svc.DISPATCHER_CHAT_INSTRUCTIONS);
    expect(fs.readFileSync(ownFile, 'utf-8')).toBe('stale');
    await svc.prepareDispatcherSessionStart(dispatcherDir(), 'durable_1');
    expect(fs.readFileSync(ownFile, 'utf-8')).toContain(svc.DISPATCHER_INSTRUCTIONS);
    // Another agent, or an id in the wrong folder, is left alone.
    fs.writeFileSync(chatFile, 'stale');
    await svc.prepareDispatcherSessionStart(chatDir(), 'durable_1');
    await svc.prepareDispatcherSessionStart('/elsewhere', 'durable_2');
    expect(fs.readFileSync(chatFile, 'utf-8')).toBe('stale');
  });

  it('starts each session with memory as it is now, in both agents (#3038)', async () => {
    await svc.setDispatcherEnabled(true);
    const index = path.join(dispatcherDir(), 'memory', 'index.md');
    fs.writeFileSync(index, '- webapp-lead owns checkout\n');
    await svc.prepareDispatcherSessionStart(chatDir(), 'durable_2');
    await svc.prepareDispatcherSessionStart(dispatcherDir(), 'durable_1');
    for (const file of [path.join(chatDir(), 'CLAUDE.md'), path.join(dispatcherDir(), 'CLAUDE.md')]) {
      const text = fs.readFileSync(file, 'utf-8');
      expect(text).toContain('## Your memory index');
      expect(text).toContain('- webapp-lead owns checkout');
    }
    // Reading never changes memory.
    expect(fs.readFileSync(index, 'utf-8')).toBe('- webapp-lead owns checkout\n');
  });

  it('takes agents\' messages at the Dispatcher\'s own agent, never the chat (#3037)', async () => {
    const { dispatcherInboxId, isDispatcherTarget } = await import('../clubhouse-mcp/tools/dispatcher-delivery');
    await svc.setDispatcherEnabled(true);
    expect(dispatcherInboxId('durable_1')).toBe('durable_1');
    expect(dispatcherInboxId('durable_2')).toBe('durable_1');
    expect(isDispatcherTarget('durable_1')).toBe(true);
    expect(isDispatcherTarget('durable_2')).toBe(false);
  });

  it('conceals the calls that join its two agents, in both of their chats', async () => {
    const { isConcealedTool } = await import('../agent-runtime/concealed-tools');
    await svc.setDispatcherEnabled(true);
    for (const id of ['durable_1', 'durable_2']) {
      expect(isConcealedTool(id, 'mcp__clubhouse__start_work')).toBe(true);
      expect(isConcealedTool(id, 'clubhouse-tell_user')).toBe(true);
      expect(isConcealedTool(id, 'mcp__clubhouse__list_agents')).toBe(false);
    }
    expect(isConcealedTool('someone_else', 'mcp__clubhouse__start_work')).toBe(false);
  });

  it('keeps the chat\'s folder beside the Dispatcher\'s, never inside it', () => {
    expect(path.dirname(svc.getDispatcherChatPath())).toBe(path.dirname(svc.getDispatcherPath()));
    expect(svc.isDispatcherPath(chatDir())).toBe(true);
    expect(svc.isDispatcherChatPath(chatDir())).toBe(true);
    expect(svc.isDispatcherCoordinatorPath(chatDir())).toBe(false);
    expect(svc.isDispatcherChatPath(dispatcherDir())).toBe(false);
  });
});
