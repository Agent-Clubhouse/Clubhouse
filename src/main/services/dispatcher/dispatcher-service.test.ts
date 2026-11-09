import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DurableAgentConfig, DurableConfigUpdates } from '../../../shared/types';

const chatStarting = vi.hoisted(() => new Set<string>());
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
  routingListeners: new Set<() => void>(),
  /** What the fake Auto mapping gives per provider and level; a provider missing here has none. */
  auto: {} as Record<string, Record<string, { model: string; effort: string | null } | null>>,
  runtimes: new Map<string, { kind: 'chat'; setModel: ReturnType<typeof vi.fn> }>(),
}));

vi.mock('../base-dir', () => ({ getBaseDirPath: () => h.baseDir }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../experimental-settings', () => ({ getSettings: () => h.experimental }));
vi.mock('../../window-chrome', () => ({ newChromeEnabled: () => h.newLayout }));
vi.mock('../orchestrator-settings', () => ({ getSettings: () => ({ enabled: h.enabledProviders }), whenDefaultsDetected: () => h.detection }));
// The Auto mapping (#3044), faked per provider so no CLI is asked for its models.
vi.mock('../helper-routing', () => ({
  resolveAutoLevel: vi.fn(async (provider: string, level: string) => {
    const levels = h.auto[provider];
    if (!levels) return { ok: false, code: 'auto_not_supported', message: `${provider} has no Auto mapping.` };
    const cell = levels[level];
    if (!cell) return { ok: false, code: 'no_valid_mapping', message: `No ${level} level for ${provider} is offered now` };
    return { ok: true, provider, level, ...cell, source: 'builtin_mapping', fallback: 'none' };
  }),
  onHelperRoutingChanged: (l: () => void) => { h.routingListeners.add(l); return () => { h.routingListeners.delete(l); }; },
}));
vi.mock('../agent-runtime', async (importOriginal) => ({ ...(await importOriginal<object>()), getAgentRuntime: (id: string) => h.runtimes.get(id) }));

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

const MODEL_LISTS: Record<string, string[]> = { 'claude-code': ['haiku', 'sonnet', 'opus'], 'codex-cli': ['luna', 'terra', 'sol'] };

// Each CLI writes its own instructions file, and reads skills from its own folder, as the real providers do.
function fakeProvider(id: string, file: string, conventions?: { configDir: string; skillsDir: string; skillsRoot?: string; previousSkillsRoots?: string[] }) {
  return {
    id,
    displayName: id,
    conventions,
    // What each CLI lists, for Choose models yourself (#3191).
    getModelOptions: vi.fn(async () => (MODEL_LISTS[id] ?? []).map((m) => ({ id: m, label: m }))),
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
  saveAgentIcon: vi.fn(async (dir: string, id: string) => {
    const agent = h.agents.get(dir)?.find((a) => a.id === id);
    if (agent) agent.icon = `${id}.png`;
    notify(dir);
    return `${id}.png`;
  }),
  removeAgentIcon: vi.fn(async (dir: string, id: string) => {
    const agent = h.agents.get(dir)?.find((a) => a.id === id);
    if (agent) delete agent.icon;
    notify(dir);
  }),
  onAgentConfigChanged: (l: (p: string) => void) => { h.configListeners.add(l); return () => { h.configListeners.delete(l); }; },
}));

// Every way an agent starts goes through spawnAgent, so "never called" means no tokens.
vi.mock('../agent-runtime/chat-spawn', () => ({ hasChatStartInFlight: (id: string) => chatStarting.has(id) }));
vi.mock('../agent-system', () => ({
  isAgentRunning: (id: string) => h.running.has(id),
  killAgent: vi.fn(async (id: string) => { h.running.delete(id); }),
  spawnAgent: vi.fn(),
}));

import * as agentConfig from '../agent-config';
import * as agentSystem from '../agent-system';
import * as svc from './dispatcher-service';
import { dispatcherSkills } from './dispatcher-skills';
import { getSettings, updateSettings } from './dispatcher-settings';
import { _resetDispatcherBehaviorForTesting, getDispatcherBehaviorPlan } from './dispatcher-behavior';
import { agentRegistry } from '../agent-registry';
import { DISPATCHER_CLASSIC_MESSAGE } from '../../../shared/dispatcher-types';
import { DEFAULT_DISPATCHER_PERSONALITY, PERSONALITY_PRESET_TEXT, personalityInstructions } from '../../../shared/dispatcher-personality';

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
  h.routingListeners.clear();
  h.runtimes.clear();
  h.auto = {
    'claude-code': {
      easy: { model: 'haiku', effort: 'low' },
      medium: { model: 'sonnet', effort: 'medium' },
      hard: { model: 'opus', effort: 'high' },
      maximum: { model: 'opus', effort: 'xhigh' },
    },
    'codex-cli': {
      easy: { model: 'luna', effort: 'low' },
      medium: { model: 'terra', effort: 'medium' },
      maximum: { model: 'sol', effort: 'high' },
    },
    'copilot-cli': {
      easy: { model: 'claude-haiku-5.5', effort: 'low' },
      medium: { model: 'claude-sonnet-5.5', effort: 'medium' },
      maximum: { model: 'claude-opus-5.5', effort: 'high' },
    },
  };
  providers.list = [
    fakeProvider('claude-code', 'CLAUDE.md', { configDir: '.claude', skillsDir: 'skills' }),
    fakeProvider('copilot-cli', path.join('.github', 'copilot-instructions.md'), { configDir: '.github', skillsDir: 'skills' }),
    fakeProvider('codex-cli', 'AGENTS.md', { configDir: '.codex', skillsDir: 'skills', skillsRoot: '.agents/skills', previousSkillsRoots: ['.codex/skills'] }),
    // A provider with no Auto presets, for the missing-mapping path, and no skills folder.
    fakeProvider('future-cli', 'FUTURE.md'),
  ];
  svc._resetDispatcherForTesting();
  _resetDispatcherBehaviorForTesting();
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

  it('1.0 default (#3053): a fresh install reaches a working Dispatcher at startup and saves no settings', async () => {
    await svc.initDispatcher();
    expect(svc.getDispatcherState()).toMatchObject({ enabled: true, offReason: null, agentId: 'durable_1', chatAgentId: 'durable_2' });
    expect(svc.getDispatcherState().setup).toEqual({ status: 'pending', upgrade: false });
    // Nothing in dispatcher-settings.json: first-run setup relies on a new install having written nothing.
    expect(getSettings()).toEqual({});
    expect(agentSystem.spawnAgent).not.toHaveBeenCalled();
  });

  it('1.0 default (#3053): an upgrade reaches a working Dispatcher at startup, keeps its agent and saves no settings', async () => {
    // A 0.42 user: other experimental flags saved, nothing for the Dispatcher, and its agent already there.
    h.experimental = { chat: true, richChatContent: true };
    fs.mkdirSync(dispatcherDir(), { recursive: true });
    h.agents.set(dispatcherDir(), [{ id: 'durable_old', name: 'Rosie', color: 'rose', createdAt: 'then', orchestrator: 'codex-cli' }]);
    await svc.initDispatcher();
    expect(svc.getDispatcherState()).toMatchObject({ enabled: true, offReason: null, agentId: 'durable_old' });
    expect(svc.getDispatcherState().config).toMatchObject({ name: 'Rosie' });
    expect(svc.getDispatcherState().setup).toEqual({ status: 'pending', upgrade: true });
    expect(getSettings()).toEqual({});
    expect(agentSystem.spawnAgent).not.toHaveBeenCalled();
  });

  it('1.0 default (#3053): an upgrade that turned it off, on its switch or its old flag, stays off and creates nothing', async () => {
    for (const saved of [{ switchOff: true, flag: {} }, { switchOff: false, flag: { dispatcher: false } }]) {
      svc._resetDispatcherForTesting();
      vi.mocked(agentConfig.createDurable).mockClear();
      await updateSettings(() => (saved.switchOff ? { enabled: false } : {}));
      h.experimental = saved.flag;
      await svc.initDispatcher();
      expect(svc.getDispatcherState()).toMatchObject({ enabled: false, offReason: saved.switchOff ? 'switch_off' : 'experimental_off' });
      expect(agentConfig.createDurable).not.toHaveBeenCalled();
      // The saved off is kept as it was.
      expect(getSettings()).toEqual(saved.switchOff ? { enabled: false } : {});
    }
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

  it('turning it off cancels a chat start still in progress (#3110)', async () => {
    await svc.initDispatcher();
    chatStarting.add('durable_1');
    try {
      await svc.setDispatcherEnabled(false);
      expect(agentSystem.killAgent).toHaveBeenCalledWith('durable_1', dispatcherDir(), 'claude-code');
    } finally {
      chatStarting.clear();
    }
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

describe('built-in skills (#3051)', () => {
  const skillText = (dir: string, rel: string, name: string) => fs.readFileSync(path.join(dir, rel, name, 'SKILL.md'), 'utf-8');

  it('writes each agent its own skills beside its instructions, and lists them there', async () => {
    await svc.setDispatcherEnabled(true);
    for (const skill of dispatcherSkills('work')) expect(skillText(dispatcherDir(), '.claude/skills', skill.name)).toBe(skill.text);
    for (const skill of dispatcherSkills('chat')) expect(skillText(chatDir(), '.claude/skills', skill.name)).toBe(skill.text);
    // Neither gets the other's.
    expect(fs.existsSync(path.join(chatDir(), '.claude/skills', 'delegating-work'))).toBe(false);
    expect(fs.existsSync(path.join(dispatcherDir(), '.claude/skills', 'what-else-can-you-do'))).toBe(false);
    const work = fs.readFileSync(path.join(dispatcherDir(), 'CLAUDE.md'), 'utf-8');
    expect(work.startsWith(svc.DISPATCHER_INSTRUCTIONS)).toBe(true);
    expect(work).toContain('`.claude/skills/delegating-work/SKILL.md`');
    expect(fs.readFileSync(path.join(chatDir(), 'CLAUDE.md'), 'utf-8')).toContain('`.claude/skills/what-else-can-you-do/SKILL.md`');
  });

  it('brings an existing Dispatcher up to this version\'s skills at start-up, removing retired ones', async () => {
    await svc.setDispatcherEnabled(true);
    const root = path.join(dispatcherDir(), '.claude/skills');
    // What an older version left: an older text, a skill this version no longer ships, and the manifest naming them.
    fs.writeFileSync(path.join(root, 'check-ins', 'SKILL.md'), 'old check-ins');
    fs.mkdirSync(path.join(root, 'old-skill'), { recursive: true });
    fs.writeFileSync(path.join(root, 'old-skill', 'SKILL.md'), 'retired');
    const manifest = path.join(root, '.clubhouse-managed-skills.json');
    fs.writeFileSync(manifest, JSON.stringify({ skills: [...dispatcherSkills('work').map((s) => s.name), 'old-skill'] }));
    // Something Clubhouse didn't write stays.
    fs.mkdirSync(path.join(root, 'not-ours'), { recursive: true });
    svc._resetDispatcherForTesting();
    await svc.initDispatcher();
    expect(skillText(dispatcherDir(), '.claude/skills', 'check-ins')).toBe(dispatcherSkills('work').find((s) => s.name === 'check-ins')!.text);
    expect(fs.existsSync(path.join(root, 'old-skill'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'not-ours'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(manifest, 'utf-8')).skills).toEqual(dispatcherSkills('work').map((s) => s.name));
  });

  it('refreshes the skills before each session starts, as it does the instructions', async () => {
    await svc.setDispatcherEnabled(true);
    fs.writeFileSync(path.join(chatDir(), '.claude/skills', 'catching-up', 'SKILL.md'), 'edited');
    await svc.prepareDispatcherSessionStart(chatDir(), svc.getDispatcherChatAgentId()!);
    expect(skillText(chatDir(), '.claude/skills', 'catching-up')).toBe(dispatcherSkills('chat').find((s) => s.name === 'catching-up')!.text);
  });

  it('moves the skills to a new CLI\'s folder and takes them out of the old one', async () => {
    h.enabledProviders = ['codex-cli'];
    await svc.setDispatcherEnabled(true);
    expect(fs.existsSync(path.join(dispatcherDir(), '.agents/skills', 'delegating-work', 'SKILL.md'))).toBe(true);
    await agentConfig.updateDurableConfig(dispatcherDir(), 'durable_1', { orchestrator: 'copilot-cli' });
    await settle();
    // Copilot reads Codex's folder too, so nothing is left there to load twice.
    expect(fs.existsSync(path.join(dispatcherDir(), '.agents/skills', 'delegating-work'))).toBe(false);
    expect(fs.existsSync(path.join(dispatcherDir(), '.github/skills', 'delegating-work', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(dispatcherDir(), '.github', 'copilot-instructions.md'), 'utf-8')).toContain('`.github/skills/delegating-work/SKILL.md`');
  });

  it('lists the chat\'s skills after its instructions and before its personality (#3047)', async () => {
    await svc.setDispatcherEnabled(true);
    const chat = fs.readFileSync(path.join(chatDir(), 'CLAUDE.md'), 'utf-8');
    expect(chat.startsWith(svc.DISPATCHER_CHAT_INSTRUCTIONS)).toBe(true);
    expect(chat.indexOf('## Skills')).toBeGreaterThan(-1);
    expect(chat.indexOf('## Skills')).toBeLessThan(chat.indexOf('## Your name and personality'));
  });

  it('writes plain instructions, with no skills list, for a CLI with no skills folder', async () => {
    h.enabledProviders = ['future-cli'];
    await svc.setDispatcherEnabled(true);
    const written = fs.readFileSync(path.join(dispatcherDir(), 'FUTURE.md'), 'utf-8');
    expect(written.startsWith(svc.DISPATCHER_INSTRUCTIONS)).toBe(true);
    expect(written).not.toContain('## Skills');
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

  it('is called by the name the user gave it, cleaned, or "Dispatcher" (#3053)', async () => {
    expect(svc.dispatcherDisplayName()).toBe('Dispatcher');
    await svc.setDispatcherEnabled(true);
    await settle();
    expect(svc.dispatcherDisplayName()).toBe('Dispatcher');
    await agentConfig.updateDurable(dispatcherDir(), 'durable_1', { name: '  Rosie\n the  Second ' });
    await settle();
    expect(svc.dispatcherDisplayName()).toBe('Rosie the Second');
    await agentConfig.updateDurable(dispatcherDir(), 'durable_1', { name: '   ' });
    await settle();
    expect(svc.dispatcherDisplayName()).toBe('Dispatcher');
  });

  it('copies a change from either record onto the other, once', async () => {
    await svc.setDispatcherEnabled(true);
    await settle();
    // Settings > Dispatcher edits the Dispatcher's own record.
    await agentConfig.updateDurableConfig(dispatcherDir(), 'durable_1', { contextWindow: '1m' });
    await settle();
    expect(h.agents.get(chatDir())?.[0].contextWindow).toBe('1m');
    // The chat's details or a phone edit the chat's.
    await agentConfig.updateDurable(chatDir(), 'durable_2', { name: 'Rosie', color: 'teal' });
    await settle();
    expect(h.agents.get(dispatcherDir())?.[0]).toMatchObject({ name: 'Rosie', color: 'teal' });
    expect(svc.getDispatcherState().config).toMatchObject({ name: 'Rosie', color: 'teal', contextWindow: '1m' });
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

  it('writes both instructions files again on request, with the index as it is now, and nothing while off (#3046)', async () => {
    await svc.setDispatcherEnabled(true);
    const index = path.join(dispatcherDir(), 'memory', 'index.md');
    const files = [path.join(chatDir(), 'CLAUDE.md'), path.join(dispatcherDir(), 'CLAUDE.md')];
    fs.writeFileSync(index, '- forgotten now\n');
    await svc.refreshDispatcherInstructions();
    for (const file of files) expect(fs.readFileSync(file, 'utf-8')).toContain('- forgotten now');

    await svc.setDispatcherEnabled(false);
    for (const file of files) fs.writeFileSync(file, 'stale');
    await svc.refreshDispatcherInstructions();
    for (const file of files) expect(fs.readFileSync(file, 'utf-8')).toBe('stale');
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

describe('Behavior (#3045)', () => {
  const coordinator = () => h.agents.get(dispatcherDir())?.[0];
  const chat = () => h.agents.get(chatDir())?.[0];

  it('is Standard by default, on the state and through the accessor', async () => {
    const state = await svc.setDispatcherEnabled(true);
    expect(state.behavior).toEqual({ level: 'standard', provider: 'claude-code', auto: { ready: true } });
    expect(svc.getDispatcherBehavior()).toBe('standard');
    expect(getDispatcherBehaviorPlan()).toMatchObject({ checkIns: 'occasionally' });
  });

  it('sets each agent\'s model from the Auto mapping before it starts, and hands it to the start', async () => {
    await svc.setDispatcherEnabled(true);
    expect(await svc.prepareDispatcherSessionStart(chatDir(), 'durable_2')).toEqual({ model: 'sonnet', effort: 'medium' });
    await svc.prepareDispatcherSessionStart(dispatcherDir(), 'durable_1');
    await settle();
    expect(chat()).toMatchObject({ model: 'sonnet', effort: 'medium' });
    expect(coordinator()).toMatchObject({ model: 'sonnet', effort: 'medium' });
  });

  it('gives Thorough the strongest model for the work and balanced for the chat, at once', async () => {
    await svc.setDispatcherEnabled(true);
    const state = await svc.setDispatcherBehavior('thorough');
    await settle();
    expect(state.behavior.level).toBe('thorough');
    expect(getSettings().behavior).toBe('thorough');
    expect(coordinator()).toMatchObject({ model: 'opus', effort: 'xhigh' });
    expect(chat()).toMatchObject({ model: 'sonnet', effort: 'medium' });
    expect(getDispatcherBehaviorPlan()).toMatchObject({ checkIns: 'frequently' });
  });

  it('maps the same level per provider', async () => {
    h.enabledProviders = ['codex-cli'];
    await svc.setDispatcherEnabled(true);
    await svc.setDispatcherBehavior('light');
    await settle();
    expect(coordinator()).toMatchObject({ orchestrator: 'codex-cli', model: 'luna', effort: 'low' });
    expect(chat()).toMatchObject({ model: 'luna', effort: 'low' });
    expect(svc.getDispatcherState().behavior).toEqual({ level: 'light', provider: 'codex-cli', auto: { ready: true } });
  });

  it('gives Copilot its models through its Auto mapping like any preset provider (#3114)', async () => {
    h.enabledProviders = ['copilot-cli'];
    await svc.setDispatcherEnabled(true);
    await svc.setDispatcherBehavior('thorough');
    await settle();
    expect(coordinator()).toMatchObject({ orchestrator: 'copilot-cli', model: 'claude-opus-5.5', effort: 'high' });
    expect(chat()).toMatchObject({ model: 'claude-sonnet-5.5', effort: 'medium' });
    expect(svc.getDispatcherState().behavior).toEqual({ level: 'thorough', provider: 'copilot-cli', auto: { ready: true } });
  });

  it('switches a running chat\'s model when the level changes', async () => {
    await svc.setDispatcherEnabled(true);
    await svc.prepareDispatcherSessionStart(chatDir(), 'durable_2');
    await settle();
    const setModel = vi.fn(async () => undefined);
    h.runtimes.set('durable_2', { kind: 'chat', setModel });
    agentRegistry.register('durable_2', { projectPath: chatDir(), cwd: chatDir(), orchestrator: 'claude-code', runtime: 'pty' });
    await svc.setDispatcherBehavior('light');
    await settle();
    expect(setModel).toHaveBeenCalledWith('haiku', 'low');
  });

  it('keeps the model it has where the provider has no Auto mapping, and says so', async () => {
    h.enabledProviders = ['future-cli'];
    await svc.setDispatcherEnabled(true);
    await svc.setDispatcherBehavior('thorough');
    expect(await svc.prepareDispatcherSessionStart(chatDir(), 'durable_2')).toBeNull();
    await settle();
    expect(chat()?.model).toBeUndefined();
    expect(coordinator()?.model).toBeUndefined();
    expect(svc.getDispatcherState().behavior).toEqual({ level: 'thorough', provider: 'future-cli', auto: { ready: false, code: 'auto_not_supported' } });
    // The level still holds, for how often it checks in.
    expect(getDispatcherBehaviorPlan().checkIns).toBe('frequently');
  });

  it('reports a mapping with nothing offered for the level, and recovers when Auto is set up', async () => {
    h.enabledProviders = ['codex-cli'];
    await svc.setDispatcherEnabled(true);
    delete h.auto['codex-cli'].maximum;
    await svc.setDispatcherBehavior('thorough');
    await settle();
    expect(svc.getDispatcherState().behavior.auto).toEqual({ ready: false, code: 'no_valid_mapping' });
    // Neither agent moves to a mismatched tier.
    expect(chat()?.model).toBeUndefined();
    h.auto['codex-cli'].maximum = { model: 'sol', effort: 'high' };
    for (const l of h.routingListeners) l();
    await settle();
    expect(svc.getDispatcherState().behavior.auto).toEqual({ ready: true });
    expect(coordinator()).toMatchObject({ model: 'sol', effort: 'high' });
  });

  it('answers once the level is saved, without waiting for a running chat to switch models', async () => {
    await svc.setDispatcherEnabled(true);
    await svc.prepareDispatcherSessionStart(chatDir(), 'durable_2');
    await settle();
    let release!: () => void;
    const setModel = vi.fn(() => new Promise<void>((r) => { release = r; }));
    h.runtimes.set('durable_2', { kind: 'chat', setModel });
    agentRegistry.register('durable_2', { projectPath: chatDir(), cwd: chatDir(), orchestrator: 'claude-code', runtime: 'pty' });
    const state = await svc.setDispatcherBehavior('light');
    expect(state.behavior.level).toBe('light');
    await vi.waitFor(() => expect(setModel).toHaveBeenCalledWith('haiku', 'low'));
    release();
    await settle();
  });

  it('refuses a level that isn\'t one, and saves nothing', async () => {
    await svc.setDispatcherEnabled(true);
    await expect(svc.setDispatcherBehavior('extreme' as never)).rejects.toThrow(/Unknown Behavior/);
    expect(getSettings().behavior).toBeUndefined();
  });
});

describe('personality and first-run setup (#3047)', () => {
  const chatFile = () => fs.readFileSync(path.join(chatDir(), 'CLAUDE.md'), 'utf-8');
  const workFile = () => fs.readFileSync(path.join(dispatcherDir(), 'CLAUDE.md'), 'utf-8');

  it('a new Dispatcher waits for setup, with the default name, Standard and Concise in its chat\'s instructions', async () => {
    const state = await svc.setDispatcherEnabled(true);
    expect(state.setup).toEqual({ status: 'pending', upgrade: false });
    expect(state.personality).toEqual(DEFAULT_DISPATCHER_PERSONALITY);
    expect(state.behavior.level).toBe('standard');
    expect(chatFile()).toContain(svc.DISPATCHER_CHAT_INSTRUCTIONS);
    expect(chatFile()).toContain(personalityInstructions('Dispatcher', DEFAULT_DISPATCHER_PERSONALITY));
    // The personality is the chat's: the agent that does the work isn't told it.
    expect(workFile()).not.toContain(PERSONALITY_PRESET_TEXT.concise);
  });

  it('keeps Clubhouse\'s chat instructions whole, whatever their line ends (a Windows checkout has CRLF)', () => {
    for (const text of ['# Dispatcher\r\n\r\nHello.\r\n', '# Dispatcher\n\nHello.\n', '# Dispatcher\n\nHello.']) {
      const joined = svc.appendSection(text, '## Section');
      expect(joined.startsWith(text)).toBe(true);
      expect(joined.endsWith('\n\n## Section\n')).toBe(true);
    }
  });

  it('a new install saves no settings for setup until the user acts', async () => {
    await svc.setDispatcherEnabled(true);
    expect(getSettings().setup).toBeUndefined();
    expect(getSettings().personality).toBeUndefined();
  });

  it('an existing Dispatcher is an upgrade, and stays one across restarts', async () => {
    fs.mkdirSync(dispatcherDir(), { recursive: true });
    h.agents.set(dispatcherDir(), [{ id: 'durable_old', name: 'Rosie', color: 'rose', createdAt: 'then', orchestrator: 'codex-cli' }]);
    expect((await svc.setDispatcherEnabled(true)).setup).toEqual({ status: 'pending', upgrade: true });
    svc._resetDispatcherForTesting();
    await svc.initDispatcher();
    expect(svc.getDispatcherState().setup).toEqual({ status: 'pending', upgrade: true });
    // Its own name reaches its chat's instructions.
    expect(fs.readFileSync(path.join(chatDir(), 'AGENTS.md'), 'utf-8')).toContain('Your name is Rosie.');
  });

  it('a Dispatcher turned on after a restart of a new install is still not an upgrade', async () => {
    await svc.setDispatcherEnabled(true);
    svc._resetDispatcherForTesting();
    await svc.initDispatcher();
    expect(svc.getDispatcherState().setup).toEqual({ status: 'pending', upgrade: false });
  });

  it('a personality change rewrites the chat\'s instructions as written, and nothing starts', async () => {
    await svc.setDispatcherEnabled(true);
    const text = 'Talk like a ship\'s captain.\nKeep it short.';
    const state = await svc.setDispatcherPersonality({ preset: 'custom', text });
    expect(state.personality).toEqual({ preset: 'custom', text });
    expect(chatFile()).toContain(text);
    expect(workFile()).not.toContain(text);
    expect(agentSystem.spawnAgent).not.toHaveBeenCalled();
  });

  it('a rename reaches the chat\'s instructions', async () => {
    await svc.setDispatcherEnabled(true);
    await agentConfig.updateDurable(dispatcherDir(), 'durable_1', { name: 'Rosie' });
    await settle();
    expect(chatFile()).toContain('Your name is Rosie.');
  });

  it('Set up later keeps the default name, Standard and Concise, and the chat offers setup again', async () => {
    await svc.setDispatcherEnabled(true);
    const state = await svc.setDispatcherSetupStatus('later');
    expect(state.setup).toEqual({ status: 'later', upgrade: false });
    expect(state.config?.name).toBe('Dispatcher');
    expect(state.behavior.level).toBe('standard');
    expect(state.personality).toEqual(DEFAULT_DISPATCHER_PERSONALITY);
    expect(getSettings().behavior).toBeUndefined();
    expect(agentSystem.spawnAgent).not.toHaveBeenCalled();
  });

  it('finishing setup saves name, look, provider, Behavior and personality on both agents, and starts nothing', async () => {
    await svc.setDispatcherEnabled(true);
    const state = await svc.completeDispatcherSetup({
      name: 'Rosie',
      color: 'rose',
      image: 'data:image/png;base64,AAAA',
      provider: 'codex-cli',
      behavior: 'thorough',
      personality: { preset: 'friendly', text: PERSONALITY_PRESET_TEXT.friendly },
    });
    await settle();
    expect(state.setup.status).toBe('done');
    expect(state.personality.preset).toBe('friendly');
    expect(svc.getDispatcherState().behavior).toMatchObject({ level: 'thorough', provider: 'codex-cli' });
    for (const dir of [dispatcherDir(), chatDir()]) {
      expect(h.agents.get(dir)?.[0]).toMatchObject({ name: 'Rosie', color: 'rose', icon: 'durable_1.png', orchestrator: 'codex-cli' });
    }
    // Behavior gives each agent its model on the new provider.
    expect(h.agents.get(dispatcherDir())?.[0]).toMatchObject({ model: 'sol', effort: 'high' });
    expect(h.agents.get(chatDir())?.[0]).toMatchObject({ model: 'terra', effort: 'medium' });
    const chatAgents = fs.readFileSync(path.join(chatDir(), 'AGENTS.md'), 'utf-8');
    expect(chatAgents).toContain('Your name is Rosie.');
    expect(chatAgents).toContain(PERSONALITY_PRESET_TEXT.friendly);
    expect(agentSystem.spawnAgent).not.toHaveBeenCalled();
  });

  it('finishing setup can remove an image, and refuses a provider Clubhouse doesn\'t know', async () => {
    await svc.setDispatcherEnabled(true);
    const base = { name: 'Dispatcher', color: 'indigo', provider: 'claude-code', behavior: 'standard' as const, personality: DEFAULT_DISPATCHER_PERSONALITY };
    await svc.completeDispatcherSetup({ ...base, image: 'data:image/png;base64,AAAA' });
    await svc.completeDispatcherSetup({ ...base, image: null });
    await settle();
    expect(h.agents.get(dispatcherDir())?.[0].icon).toBeUndefined();
    expect(h.agents.get(chatDir())?.[0].icon).toBeUndefined();
    await expect(svc.completeDispatcherSetup({ ...base, provider: 'nope-cli' })).rejects.toThrow('nope-cli');
  });

  it('refuses to finish setup while it is off', async () => {
    await svc.setDispatcherEnabled(false);
    await expect(svc.completeDispatcherSetup({
      name: 'Rosie', color: 'rose', provider: 'claude-code', behavior: 'standard', personality: DEFAULT_DISPATCHER_PERSONALITY,
    })).rejects.toThrow('Turn on the Dispatcher first');
  });
});

describe('Choose models yourself (#3191)', () => {
  const coordinator = () => h.agents.get(dispatcherDir())?.[0];
  const chat = () => h.agents.get(chatDir())?.[0];
  const runningChat = (orchestrator = 'claude-code') => {
    const setModel = vi.fn(async () => undefined);
    h.runtimes.set('durable_2', { kind: 'chat', setModel });
    agentRegistry.register('durable_2', { projectPath: chatDir(), cwd: chatDir(), orchestrator: orchestrator as never, runtime: 'pty' });
    return setModel;
  };

  it('is off by default, and Behavior gives the models as before', async () => {
    const state = await svc.setDispatcherEnabled(true);
    expect(state.models).toEqual({ byHand: false, chat: null, work: null });
    expect(getSettings().models).toBeUndefined();
    await svc.setDispatcherBehavior('thorough');
    await settle();
    expect(coordinator()).toMatchObject({ model: 'opus', effort: 'xhigh' });
    expect(chat()).toMatchObject({ model: 'sonnet', effort: 'medium' });
  });

  it('turning it on keeps what each agent runs now as its pick, saved in dispatcher-settings.json', async () => {
    await svc.setDispatcherEnabled(true);
    await svc.setDispatcherBehavior('thorough');
    await settle();
    vi.mocked(agentConfig.updateDurableConfig).mockClear();
    const state = await svc.setDispatcherModels({ byHand: true });
    await settle();
    const expected = {
      byHand: true,
      chat: { provider: 'claude-code', model: 'sonnet', effort: 'medium', contextWindow: null },
      work: { provider: 'claude-code', model: 'opus', effort: 'xhigh', contextWindow: null },
    };
    expect(state.models).toEqual(expected);
    expect(getSettings().models).toEqual(expected);
    // Nothing on either record changes by turning it on.
    expect(agentConfig.updateDurableConfig).not.toHaveBeenCalled();
    // It survives a restart.
    svc._resetDispatcherForTesting();
    await svc.initDispatcher();
    expect(svc.getDispatcherState().models).toEqual(expected);
  });

  it('Behavior never overwrites a pick: not on a level change, an Auto change or a start, and still sets the frequencies', async () => {
    await svc.setDispatcherEnabled(true);
    await svc.setDispatcherModels({ byHand: true });
    await svc.setDispatcherModels({ role: 'work', model: 'haiku', effort: 'low' });
    await svc.setDispatcherModels({ role: 'chat', model: 'opus' });
    await svc.setDispatcherBehavior('thorough');
    for (const l of h.routingListeners) l();
    await settle();
    expect(coordinator()).toMatchObject({ model: 'haiku', effort: 'low' });
    expect(chat()).toMatchObject({ model: 'opus', effort: null });
    expect(await svc.prepareDispatcherSessionStart(dispatcherDir(), 'durable_1')).toEqual({ model: 'haiku', effort: 'low', orchestrator: 'claude-code' });
    expect(await svc.prepareDispatcherSessionStart(chatDir(), 'durable_2')).toEqual({ model: 'opus', effort: null, orchestrator: 'claude-code' });
    expect(coordinator()).toMatchObject({ model: 'haiku', effort: 'low' });
    expect(getDispatcherBehaviorPlan()).toMatchObject({ checkIns: 'frequently', upkeep: 'nightly_and_each_idle' });
  });

  it('puts a record edited elsewhere back to its pick at the next start', async () => {
    await svc.setDispatcherEnabled(true);
    await svc.setDispatcherModels({ byHand: true });
    await svc.setDispatcherModels({ role: 'chat', model: 'haiku' });
    await agentConfig.updateDurableConfig(chatDir(), 'durable_2', { model: 'sonnet' });
    await settle();
    await svc.prepareDispatcherSessionStart(chatDir(), 'durable_2');
    expect(chat()?.model).toBe('haiku');
  });

  it('runs the two jobs on different providers, each with its own instructions file, and keeps them apart', async () => {
    h.enabledProviders = ['claude-code', 'codex-cli'];
    await svc.setDispatcherEnabled(true);
    await svc.setDispatcherModels({ byHand: true });
    const state = await svc.setDispatcherModels({ role: 'chat', provider: 'codex-cli' });
    await svc.setDispatcherModels({ role: 'chat', model: 'terra', effort: 'medium' });
    await settle();
    expect(state.models.chat).toEqual({ provider: 'codex-cli', model: 'default', effort: null, contextWindow: null });
    expect(chat()).toMatchObject({ orchestrator: 'codex-cli', model: 'terra', effort: 'medium' });
    expect(coordinator()).toMatchObject({ orchestrator: 'claude-code' });
    // Each folder has its own CLI's instructions file.
    expect(fs.existsSync(path.join(chatDir(), 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(dispatcherDir(), 'CLAUDE.md'))).toBe(true);
    // A change to the record Settings edits doesn't drag the chat back to its CLI.
    await agentConfig.updateDurable(dispatcherDir(), 'durable_1', { name: 'Rosie' });
    await agentConfig.updateDurableConfig(dispatcherDir(), 'durable_1', { idleSleep: 30 });
    await settle();
    expect(chat()).toMatchObject({ name: 'Rosie', idleSleep: 30, orchestrator: 'codex-cli', model: 'terra' });
    expect(coordinator()).toMatchObject({ orchestrator: 'claude-code' });
    // Each start names its own provider.
    expect(await svc.prepareDispatcherSessionStart(chatDir(), 'durable_2')).toMatchObject({ orchestrator: 'codex-cli', model: 'terra' });
    expect(await svc.prepareDispatcherSessionStart(dispatcherDir(), 'durable_1')).toMatchObject({ orchestrator: 'claude-code' });
    expect(agentSystem.spawnAgent).not.toHaveBeenCalled();
  });

  it('turning it off brings the chat back to the provider Settings shows, and Behavior gives the models again', async () => {
    h.enabledProviders = ['claude-code', 'codex-cli'];
    await svc.setDispatcherEnabled(true);
    await svc.setDispatcherModels({ byHand: true });
    await svc.setDispatcherModels({ role: 'chat', provider: 'codex-cli' });
    await svc.setDispatcherModels({ role: 'work', model: 'haiku' });
    const state = await svc.setDispatcherModels({ byHand: false });
    await settle();
    expect(state.models.byHand).toBe(false);
    expect(chat()).toMatchObject({ orchestrator: 'claude-code', model: 'sonnet', effort: 'medium' });
    expect(coordinator()).toMatchObject({ orchestrator: 'claude-code', model: 'sonnet', effort: 'medium' });
    // The picks are kept for next time.
    expect(getSettings().models).toMatchObject({ byHand: false, chat: { provider: 'codex-cli' }, work: { model: 'haiku' } });
    await svc.setDispatcherModels({ byHand: true });
    await settle();
    expect(chat()).toMatchObject({ orchestrator: 'codex-cli' });
    expect(coordinator()).toMatchObject({ model: 'haiku' });
  });

  it('switches a running session\'s model at once on the same provider, and waits for the next start on another', async () => {
    h.enabledProviders = ['claude-code', 'codex-cli'];
    await svc.setDispatcherEnabled(true);
    await svc.setDispatcherModels({ byHand: true });
    const setModel = runningChat();
    await svc.setDispatcherModels({ role: 'chat', model: 'opus', effort: 'high' });
    await settle();
    expect(setModel).toHaveBeenCalledWith('opus', 'high');
    setModel.mockClear();
    await svc.setDispatcherModels({ role: 'chat', contextWindow: null });
    await svc.setDispatcherModels({ role: 'chat', provider: 'codex-cli' });
    await settle();
    expect(setModel).not.toHaveBeenCalled();
    expect(chat()).toMatchObject({ orchestrator: 'codex-cli' });
  });

  it('refuses a provider Clubhouse doesn\'t know, a model its CLI doesn\'t list, and a pick while it\'s off, saving nothing', async () => {
    await svc.setDispatcherEnabled(true);
    await expect(svc.setDispatcherModels({ role: 'chat', model: 'opus' })).rejects.toThrow('Turn on Choose models yourself first');
    await svc.setDispatcherModels({ byHand: true });
    const before = getSettings().models;
    await expect(svc.setDispatcherModels({ role: 'chat', provider: 'nope-cli' })).rejects.toThrow('nope-cli');
    await expect(svc.setDispatcherModels({ role: 'chat', model: 'gpt-9' })).rejects.toThrow('gpt-9 isn’t a model claude-code lists');
    await expect(svc.setDispatcherModels({ role: 'chat', effort: 'high; rm' })).rejects.toThrow();
    expect(getSettings().models).toEqual(before);
    await svc.setDispatcherEnabled(false);
    await expect(svc.setDispatcherModels({ byHand: false })).rejects.toThrow('Turn on the Dispatcher first');
  });

  it('keeps the old pick when its record refuses the new one', async () => {
    await svc.setDispatcherEnabled(true);
    await svc.setDispatcherModels({ byHand: true });
    const before = getSettings().models;
    vi.mocked(agentConfig.updateDurableConfig).mockRejectedValueOnce(new Error('300K isn’t offered for this model.'));
    await expect(svc.setDispatcherModels({ role: 'work', contextWindow: '300000' })).rejects.toThrow('300K');
    expect(getSettings().models).toEqual(before);
  });

  it('finishing setup turns it off, since setup picks one provider and a Behavior', async () => {
    h.enabledProviders = ['claude-code', 'codex-cli'];
    await svc.setDispatcherEnabled(true);
    await svc.setDispatcherModels({ byHand: true });
    await svc.setDispatcherModels({ role: 'chat', provider: 'codex-cli' });
    await svc.completeDispatcherSetup({ name: 'Rosie', color: 'rose', provider: 'claude-code', behavior: 'light', personality: DEFAULT_DISPATCHER_PERSONALITY });
    await settle();
    expect(svc.getDispatcherState().models.byHand).toBe(false);
    expect(chat()).toMatchObject({ orchestrator: 'claude-code', model: 'haiku', effort: 'low' });
    expect(coordinator()).toMatchObject({ orchestrator: 'claude-code', model: 'haiku', effort: 'low' });
  });
});

describe('chosenModelUpdates (#3191)', () => {
  const record: DurableAgentConfig = { id: 'a', name: 'D', color: 'indigo', createdAt: 'now', orchestrator: 'claude-code', model: 'opus', effort: 'high' };

  it('writes nothing when the record already runs the pick, a missing model reading as the default', () => {
    expect(svc.chosenModelUpdates(record, { provider: 'claude-code', model: 'opus', effort: 'high', contextWindow: null }, 'claude-code')).toEqual({});
    expect(svc.chosenModelUpdates({ ...record, model: undefined, effort: undefined, orchestrator: undefined }, { provider: 'claude-code', model: 'default', effort: null, contextWindow: null }, 'claude-code')).toEqual({});
  });

  it('sends the effort and context again with a new model or provider, which clear them', () => {
    expect(svc.chosenModelUpdates(record, { provider: 'claude-code', model: 'sonnet', effort: 'high', contextWindow: null }, undefined))
      .toEqual({ model: 'sonnet', effort: 'high', contextWindow: null });
    expect(svc.chosenModelUpdates(record, { provider: 'codex-cli', model: 'default', effort: null, contextWindow: null }, undefined))
      .toEqual({ orchestrator: 'codex-cli', model: 'default', effort: null, contextWindow: null });
    expect(svc.chosenModelUpdates(record, { provider: 'claude-code', model: 'opus', effort: 'low', contextWindow: null }, undefined)).toEqual({ effort: 'low' });
  });
});
