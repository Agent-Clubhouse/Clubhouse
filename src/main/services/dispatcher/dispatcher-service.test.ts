import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DurableAgentConfig, DurableConfigUpdates } from '../../../shared/types';

const h = vi.hoisted(() => ({
  baseDir: '',
  experimental: {} as Record<string, boolean>,
  enabledProviders: ['claude-code'] as string[],
  agents: new Map<string, DurableAgentConfig[]>(),
  configListeners: new Set<(projectPath: string) => void>(),
  running: new Set<string>(),
  nextId: 1,
}));

vi.mock('../base-dir', () => ({ getBaseDirPath: () => h.baseDir }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../experimental-settings', () => ({ getSettings: () => h.experimental }));
vi.mock('../orchestrator-settings', () => ({ getSettings: () => ({ enabled: h.enabledProviders }) }));
vi.mock('../materialization-service', () => ({
  resolvePersonaContent: vi.fn(async (_dir: string, id: string) => (id === 'dispatcher' ? 'You are the Dispatcher.' : undefined)),
}));

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
// Creation and updates run the real persona rule, so the Dispatcher's own create is checked against it (#2551).
vi.mock('../agent-config', async () => {
  const { assertPersonaAllowed } = await vi.importActual<typeof import('../agent-config')>('../agent-config');
  return {
  assertPersonaAllowed,
  listDurable: vi.fn(async (dir: string) => (h.agents.get(dir) ?? []).map((a) => ({ ...a }))),
  getDurableConfig: vi.fn(async (dir: string, id: string) => h.agents.get(dir)?.find((a) => a.id === id) ?? null),
  createDurable: vi.fn(async (dir: string, name: string, color: string, model: string | undefined, _wt: boolean, orchestrator: string | undefined, freeAgentMode: boolean | undefined, _m: unknown, _c: unknown, persona: string | undefined) => {
    assertPersonaAllowed(dir, persona);
    const config: DurableAgentConfig = {
      id: `durable_${h.nextId++}`, name, color, createdAt: 'now',
      ...(model ? { model } : {}), ...(orchestrator ? { orchestrator } : {}),
      ...(freeAgentMode ? { freeAgentMode } : {}), ...(persona ? { persona } : {}),
    };
    h.agents.set(dir, [...(h.agents.get(dir) ?? []), config]);
    notify(dir);
    return config;
  }),
  updateDurableConfig: vi.fn(async (dir: string, id: string, updates: DurableConfigUpdates) => {
    if (updates.persona !== undefined) assertPersonaAllowed(dir, updates.persona);
    const agent = h.agents.get(dir)?.find((a) => a.id === id);
    if (!agent) return;
    Object.assign(agent, updates);
    notify(dir);
  }),
  onAgentConfigChanged: (l: (p: string) => void) => { h.configListeners.add(l); return () => { h.configListeners.delete(l); }; },
  };
});

vi.mock('../agent-system', () => ({
  isAgentRunning: (id: string) => h.running.has(id),
  killAgent: vi.fn(async (id: string) => { h.running.delete(id); }),
}));

import * as agentConfig from '../agent-config';
import * as agentSystem from '../agent-system';
import * as svc from './dispatcher-service';
import { updateSettings } from './dispatcher-settings';

const dispatcherDir = () => path.join(h.baseDir, 'dispatcher');

/** Let queued config refreshes run: they wait on real file reads. */
const settle = () => svc._whenIdleForTesting();

beforeEach(async () => {
  h.baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-test-'));
  h.experimental = {};
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
  await updateSettings(() => ({ enabled: false }));
  vi.mocked(agentConfig.createDurable).mockClear();
  vi.mocked(agentSystem.killAgent).mockClear();
});

afterEach(() => {
  fs.rmSync(h.baseDir, { recursive: true, force: true });
});

describe('gating', () => {
  it('is off on a fresh profile and creates nothing at start-up', async () => {
    await svc.initDispatcher();
    expect(svc.isDispatcherEnabled()).toBe(false);
    expect(svc.getDispatcherState()).toEqual({ enabled: false, flagOn: false, agentId: null, path: null, config: null });
    expect(fs.existsSync(dispatcherDir())).toBe(false);
    expect(agentConfig.createDurable).not.toHaveBeenCalled();
  });

  it('needs both the flag and the setting', async () => {
    h.experimental = { dispatcher: true };
    await svc.onExperimentalSettingsChanged();
    expect(svc.isDispatcherEnabled()).toBe(false);
    expect(svc.getDispatcherState()).toMatchObject({ enabled: false, flagOn: true });
    expect(agentConfig.createDurable).not.toHaveBeenCalled();

    const state = await svc.setDispatcherEnabled(true);
    expect(state.enabled).toBe(true);
    expect(state.agentId).toBe('durable_1');
    expect(state.path).toBe(dispatcherDir());
  });

  it("won't save it on while the flag is off (#2555)", async () => {
    await expect(svc.setDispatcherEnabled(true)).rejects.toThrow('Turn on Dispatcher in Settings > Experimental first.');
    h.experimental = { dispatcher: true };
    await svc.onExperimentalSettingsChanged();
    expect(svc.isDispatcherEnabled()).toBe(false);
    expect(agentConfig.createDurable).not.toHaveBeenCalled();
    // Turning it off still works with the flag off.
    h.experimental = {};
    await expect(svc.setDispatcherEnabled(false)).resolves.toMatchObject({ enabled: false, flagOn: false });
  });

  it('broadcasts a flag change even while the setting is off, so the nav follows it', async () => {
    const seen: boolean[] = [];
    const off = svc.onDispatcherChanged((s) => seen.push(s.flagOn));
    h.experimental = { dispatcher: true };
    await svc.onExperimentalSettingsChanged();
    h.experimental = {};
    await svc.onExperimentalSettingsChanged();
    off();
    expect(seen).toEqual([true, false]);
  });

  it('turning the flag off stops the agent', async () => {
    h.experimental = { dispatcher: true };
    await svc.setDispatcherEnabled(true);
    h.running.add('durable_1');
    h.experimental = {};
    await svc.onExperimentalSettingsChanged();
    expect(agentSystem.killAgent).toHaveBeenCalledWith('durable_1', dispatcherDir(), 'claude-code');
    expect(svc.getDispatcherState().enabled).toBe(false);
  });
});

describe('turning it on', () => {
  beforeEach(() => { h.experimental = { dispatcher: true }; });

  it('creates the folder, notes/ and one agent with the defaults', async () => {
    const state = await svc.setDispatcherEnabled(true);
    expect(fs.statSync(path.join(dispatcherDir(), 'notes')).isDirectory()).toBe(true);
    expect(agentConfig.createDurable).toHaveBeenCalledTimes(1);
    const [dir, name, , model, useWorktree, orchestrator, freeAgentMode, , , persona] = vi.mocked(agentConfig.createDurable).mock.calls[0];
    expect(dir).toBe(dispatcherDir());
    expect(name).toBe('Dispatcher');
    expect(model).toBeUndefined();
    expect(useWorktree).toBe(false);
    expect(orchestrator).toBe('claude-code');
    expect(freeAgentMode).toBe(true);
    expect(persona).toBe('dispatcher');
    expect(state.config).toMatchObject({ idleSleep: 'never', runtimeMode: 'chat', mcpOverride: true, persona: 'dispatcher' });
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
    expect(fs.readFileSync(path.join(dispatcherDir(), 'AGENTS.md'), 'utf-8')).toBe('You are the Dispatcher.');
    expect(fs.existsSync(path.join(dispatcherDir(), 'CLAUDE.md'))).toBe(false);
  });

  it('writes the persona instructions at create and again on start-up', async () => {
    await svc.setDispatcherEnabled(true);
    const file = path.join(dispatcherDir(), 'CLAUDE.md');
    expect(fs.readFileSync(file, 'utf-8')).toBe('You are the Dispatcher.');
    fs.writeFileSync(file, 'stale');
    svc._resetDispatcherForTesting();
    await svc.initDispatcher();
    expect(fs.readFileSync(file, 'utf-8')).toBe('You are the Dispatcher.');
  });

  it('rewrites instructions for a new CLI', async () => {
    await svc.setDispatcherEnabled(true);
    const changed = vi.fn();
    svc.onDispatcherChanged(changed);
    await agentConfig.updateDurableConfig(dispatcherDir(), 'durable_1', { orchestrator: 'copilot-cli' });
    await settle();
    const file = path.join(dispatcherDir(), '.github', 'copilot-instructions.md');
    expect(fs.readFileSync(file, 'utf-8')).toBe('You are the Dispatcher.');
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ orchestrator: 'copilot-cli' }) }));
  });
});

describe('turning it off', () => {
  beforeEach(() => { h.experimental = { dispatcher: true }; });

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
  it('fire once per real change', async () => {
    const changed = vi.fn();
    svc.onDispatcherChanged(changed);
    h.experimental = { dispatcher: true };
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
