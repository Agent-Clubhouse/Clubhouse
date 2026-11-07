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
import { notifyMcpEnablementChanged, isMcpEnabledForAny, saveSettings as saveMcp } from '../mcp-settings';
import { DISPATCHER_CLASSIC_MESSAGE } from '../../../shared/dispatcher-types';
import { MCP_REQUIRED_MESSAGE } from '../../../shared/orchestration-policy';

const dispatcherDir = () => path.join(h.baseDir, 'dispatcher');

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
  await saveMcp({ enabled: true });
  for (const agentId of agentRegistry.getAllRegistrations().keys()) agentRegistry.untrack(agentId);
  vi.mocked(agentConfig.createDurable).mockClear();
  vi.mocked(agentSystem.killAgent).mockClear();
  vi.mocked(agentSystem.spawnAgent).mockClear();
});

afterEach(() => {
  fs.rmSync(h.baseDir, { recursive: true, force: true });
});

/** MCP off at app level: its switch saved off. */
async function mcpOffAtApp(): Promise<void> {
  await saveMcp({ enabled: false });
  notifyMcpEnablementChanged();
  await settle();
}

async function mcpBackAtApp(): Promise<void> {
  await saveMcp({ enabled: true });
  notifyMcpEnablementChanged();
  await settle();
}

describe('gating', () => {
  it('is on by default in the new layout: creates and connects, and never starts it', async () => {
    await svc.initDispatcher();
    expect(svc.getDispatcherState()).toMatchObject({ enabled: true, savedOn: true, flagOn: true, offReason: null, running: false, agentId: 'durable_1', path: dispatcherDir() });
    expect(agentConfig.createDurable).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(dispatcherDir(), 'CLAUDE.md'), 'utf-8')).toBe(svc.DISPATCHER_INSTRUCTIONS);
    // What default-on must not do: start the agent, so no tokens are spent.
    expect(agentSystem.spawnAgent).not.toHaveBeenCalled();
    expect(agentRegistry.get('durable_1')).toBeUndefined();
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
    expect(fs.readFileSync(path.join(dispatcherDir(), 'AGENTS.md'), 'utf-8')).toBe(svc.DISPATCHER_INSTRUCTIONS);
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

describe('Clubhouse MCP at app level', () => {
  it('creates nothing and starts no bridge for a user with MCP saved off (#2589)', async () => {
    await saveMcp({ enabled: false });
    await svc.initDispatcher();
    expect(svc.getDispatcherState()).toMatchObject({ enabled: false, savedOn: true, offReason: 'mcp_off', mcpOff: true, agentId: null });
    expect(fs.existsSync(dispatcherDir())).toBe(false);
    expect(isMcpEnabledForAny()).toBe(false);
    expect(getSettings().enabled).toBeUndefined();
  });

  it('a project override keeps its own agents on MCP and does not keep the Dispatcher on', async () => {
    await saveMcp({ enabled: false, projectOverrides: { '/some/project': true } });
    await svc.initDispatcher();
    expect(svc.getDispatcherState()).toMatchObject({ enabled: false, offReason: 'mcp_off' });
    // The override is why the bridge starts, not the Dispatcher.
    expect(isMcpEnabledForAny()).toBe(true);
  });

  it('never stops a running Dispatcher: it stays running, derived off, with the saved value kept', async () => {
    await svc.setDispatcherEnabled(true);
    h.running.add('durable_1');
    agentRegistry.register('durable_1', { projectPath: dispatcherDir(), orchestrator: 'claude-code', runtime: 'chat' } as never);
    const changed = vi.fn();
    svc.onDispatcherChanged(changed);

    await mcpOffAtApp();

    expect(agentSystem.killAgent).not.toHaveBeenCalled();
    expect(svc.getDispatcherState()).toMatchObject({ enabled: false, savedOn: true, offReason: 'mcp_off', running: true, agentId: 'durable_1' });
    expect(getSettings().enabled).toBe(true);
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, running: true }));
  });

  it('the state follows it stopping, so its row and view go then', async () => {
    await svc.setDispatcherEnabled(true);
    const changed = vi.fn();
    svc.onDispatcherChanged(changed);
    agentRegistry.register('durable_1', { projectPath: dispatcherDir(), orchestrator: 'claude-code', runtime: 'chat' } as never);
    agentRegistry.setNonce('durable_1', 'n1');
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ running: true }));
    await mcpOffAtApp();
    agentRegistry.untrack('durable_1');
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false, running: false }));
  });

  it('refuses turning it on with MCP off, and saves nothing', async () => {
    await saveMcp({ enabled: false });
    await expect(svc.setDispatcherEnabled(true)).rejects.toThrow(MCP_REQUIRED_MESSAGE);
    expect(getSettings().enabled).toBeUndefined();
    expect(agentConfig.createDurable).not.toHaveBeenCalled();
  });

  it('the direct switch still stops a running one with MCP off', async () => {
    await svc.setDispatcherEnabled(true);
    h.running.add('durable_1');
    await mcpOffAtApp();
    expect(agentSystem.killAgent).not.toHaveBeenCalled();
    await svc.setDispatcherEnabled(false);
    expect(agentSystem.killAgent).toHaveBeenCalledTimes(1);
    expect(getSettings().enabled).toBe(false);
  });

  it('the stop in the turn-off dialog stops it and changes nothing saved', async () => {
    await svc.setDispatcherEnabled(true);
    h.running.add('durable_1');
    await mcpOffAtApp();
    await svc.stopDispatcherNow();
    expect(agentSystem.killAgent).toHaveBeenCalledWith('durable_1', dispatcherDir(), 'claude-code');
    expect(getSettings().enabled).toBe(true);
  });

  it('MCP back returns it to its saved state without starting it, and keeps its folder and notes', async () => {
    await svc.setDispatcherEnabled(true);
    fs.writeFileSync(path.join(dispatcherDir(), 'notes', 'plan.md'), 'keep me');
    await mcpOffAtApp();
    expect(svc.getDispatcherState().enabled).toBe(false);

    await mcpBackAtApp();

    expect(svc.getDispatcherState()).toMatchObject({ enabled: true, agentId: 'durable_1', running: false });
    expect(agentSystem.spawnAgent).not.toHaveBeenCalled();
    expect(agentConfig.createDurable).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(dispatcherDir(), 'notes', 'plan.md'), 'utf-8')).toBe('keep me');
  });

  it('MCP back leaves a saved false off, and a never-created one is created then, not before', async () => {
    await saveMcp({ enabled: false });
    await svc.initDispatcher();
    expect(agentConfig.createDurable).not.toHaveBeenCalled();
    await mcpBackAtApp();
    expect(agentConfig.createDurable).toHaveBeenCalledTimes(1);
    expect(svc.getDispatcherState().enabled).toBe(true);

    await svc.setDispatcherEnabled(false);
    await mcpOffAtApp();
    await mcpBackAtApp();
    expect(svc.getDispatcherState()).toMatchObject({ enabled: false, offReason: 'switch_off' });
  });
});

describe('turning it on', () => {
  it('creates the folder, notes/ and one agent with the defaults', async () => {
    const state = await svc.setDispatcherEnabled(true);
    expect(fs.statSync(path.join(dispatcherDir(), 'notes')).isDirectory()).toBe(true);
    expect(agentConfig.createDurable).toHaveBeenCalledTimes(1);
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
    expect(state.config).toMatchObject({ idleSleep: 'never', runtimeMode: 'chat', mcpOverride: true });
    expect(state.config?.persona).toBeUndefined();
  });

  it('is idempotent across toggles and restarts', async () => {
    await svc.setDispatcherEnabled(true);
    await svc.setDispatcherEnabled(true);
    svc._resetDispatcherForTesting();
    await svc.initDispatcher();
    expect(agentConfig.createDurable).toHaveBeenCalledTimes(1);
    expect(h.agents.get(dispatcherDir())).toHaveLength(1);
    expect(svc.getDispatcherAgentId()).toBe('durable_1');
  });

  it('follows the app default CLI, never assuming Claude', async () => {
    h.enabledProviders = ['codex-cli'];
    const state = await svc.setDispatcherEnabled(true);
    expect(state.config?.orchestrator).toBe('codex-cli');
    expect(fs.readFileSync(path.join(dispatcherDir(), 'AGENTS.md'), 'utf-8')).toBe(svc.DISPATCHER_INSTRUCTIONS);
    expect(fs.existsSync(path.join(dispatcherDir(), 'CLAUDE.md'))).toBe(false);
  });

  it('writes its own instructions at create and again on start-up', async () => {
    await svc.setDispatcherEnabled(true);
    const file = path.join(dispatcherDir(), 'CLAUDE.md');
    expect(fs.readFileSync(file, 'utf-8')).toBe(svc.DISPATCHER_INSTRUCTIONS);
    fs.writeFileSync(file, 'stale');
    svc._resetDispatcherForTesting();
    await svc.initDispatcher();
    expect(fs.readFileSync(file, 'utf-8')).toBe(svc.DISPATCHER_INSTRUCTIONS);
  });

  it('ships its instructions from dispatcher-instructions.md', () => {
    expect(svc.DISPATCHER_INSTRUCTIONS).toContain('Dispatcher');
    expect(svc.DISPATCHER_INSTRUCTIONS).not.toMatch(/^---/);
  });

  it('keeps working with a config from before #2901 that still has persona: dispatcher', async () => {
    fs.mkdirSync(path.join(dispatcherDir(), 'notes'), { recursive: true });
    h.agents.set(dispatcherDir(), [{ id: 'durable_old', name: 'Dispatcher', color: 'indigo', createdAt: 'then', orchestrator: 'claude-code', persona: 'dispatcher' }]);
    await svc.setDispatcherEnabled(true);
    expect(agentConfig.createDurable).not.toHaveBeenCalled();
    expect(svc.getDispatcherAgentId()).toBe('durable_old');
    expect(svc.isDispatcherAgentId('durable_old')).toBe(true);
    expect(fs.readFileSync(path.join(dispatcherDir(), 'CLAUDE.md'), 'utf-8')).toBe(svc.DISPATCHER_INSTRUCTIONS);
  });

  it('rewrites instructions for a new CLI', async () => {
    await svc.setDispatcherEnabled(true);
    const changed = vi.fn();
    svc.onDispatcherChanged(changed);
    await agentConfig.updateDurableConfig(dispatcherDir(), 'durable_1', { orchestrator: 'copilot-cli' });
    await settle();
    const file = path.join(dispatcherDir(), '.github', 'copilot-instructions.md');
    expect(fs.readFileSync(file, 'utf-8')).toBe(svc.DISPATCHER_INSTRUCTIONS);
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ orchestrator: 'copilot-cli' }) }));
  });
});

describe('turning it off', () => {
  it('stops the agent and keeps the folder, notes and config for turning back on', async () => {
    await svc.setDispatcherEnabled(true);
    fs.writeFileSync(path.join(dispatcherDir(), 'notes', 'plan.md'), 'keep me');
    h.running.add('durable_1');

    const off = await svc.setDispatcherEnabled(false);
    expect(agentSystem.killAgent).toHaveBeenCalledTimes(1);
    expect(off).toMatchObject({ enabled: false, agentId: 'durable_1', path: dispatcherDir() });
    expect(fs.readFileSync(path.join(dispatcherDir(), 'notes', 'plan.md'), 'utf-8')).toBe('keep me');

    const on = await svc.setDispatcherEnabled(true);
    expect(on.agentId).toBe('durable_1');
    expect(agentConfig.createDurable).toHaveBeenCalledTimes(1);
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
