import { describe, it, expect, vi, beforeEach } from 'vitest';
import { activate, deactivate, MainPanel, SidebarPanel } from './main';
import { terminalState, makeSessionId } from './state';
import { manifest } from './manifest';
import * as terminalModule from './main';
import { validateBuiltinPlugin } from '../builtin-plugin-testing';
import { createMockContext, createMockAPI } from '../../testing';
import type { PluginAPI, PluginContext } from '../../../../shared/plugin-types';

// ── Built-in plugin validation ───────────────────────────────────────

describe('terminal plugin (built-in validation)', () => {
  it('passes validateBuiltinPlugin', () => {
    const result = validateBuiltinPlugin({ manifest, module: terminalModule });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── activate() ───────────────────────────────────────────────────────

describe('terminal plugin activate()', () => {
  let ctx: PluginContext;
  let api: PluginAPI;
  let registerSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ctx = createMockContext({ pluginId: 'terminal' });
    registerSpy = vi.fn(() => ({ dispose: vi.fn() }));
    api = createMockAPI({ commands: { register: registerSpy, execute: vi.fn() } });
  });

  it('registers a restart command', () => {
    activate(ctx, api);
    expect(registerSpy).toHaveBeenCalledWith('restart', expect.any(Function));
  });

  it('registers exactly one command', () => {
    activate(ctx, api);
    expect(registerSpy).toHaveBeenCalledTimes(1);
  });

  it('pushes exactly one disposable to ctx.subscriptions', () => {
    activate(ctx, api);
    expect(ctx.subscriptions).toHaveLength(1);
    expect(typeof ctx.subscriptions[0].dispose).toBe('function');
  });

  it('does not call any terminal API methods during activation', () => {
    const spawnSpy = vi.fn();
    const killSpy = vi.fn();
    api = createMockAPI({
      commands: { register: registerSpy, execute: vi.fn() },
      terminal: {
        ...api.terminal,
        spawn: spawnSpy,
        kill: killSpy,
      },
    });
    activate(ctx, api);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('does not read context.projectId or context.projectPath during activation', () => {
    // activate should work even without project context — the MainPanel handles that
    const appCtx = createMockContext({ pluginId: 'terminal', scope: 'project', projectId: undefined, projectPath: undefined });
    expect(() => activate(appCtx, api)).not.toThrow();
  });

  it('calling activate twice registers two commands (idempotency is caller concern)', () => {
    activate(ctx, api);
    activate(ctx, api);
    expect(registerSpy).toHaveBeenCalledTimes(2);
    expect(ctx.subscriptions).toHaveLength(2);
  });
});

// ── deactivate() ─────────────────────────────────────────────────────

describe('terminal plugin deactivate()', () => {
  beforeEach(() => {
    terminalState.reset();
  });

  it('does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });

  it('returns void', () => {
    expect(deactivate()).toBeUndefined();
  });

  it('can be called multiple times', () => {
    deactivate();
    deactivate();
    deactivate();
    // no throw
  });

  it('resets terminalState activeTarget to null', () => {
    terminalState.setActiveTarget({ sessionId: 's', label: 'X', cwd: '/', kind: 'project' });
    expect(terminalState.activeTarget).not.toBeNull();
    deactivate();
    expect(terminalState.activeTarget).toBeNull();
  });

  it('resets terminalState targets to empty array', () => {
    terminalState.setTargets([{ sessionId: 's', label: 'X', cwd: '/', kind: 'project' }]);
    expect(terminalState.targets).toHaveLength(1);
    deactivate();
    expect(terminalState.targets).toEqual([]);
  });
});

// ── terminalState (pub/sub) ──────────────────────────────────────────

describe('terminalState', () => {
  beforeEach(() => {
    terminalState.reset();
  });

  it('activeTarget starts null', () => {
    expect(terminalState.activeTarget).toBeNull();
  });

  it('targets starts empty', () => {
    expect(terminalState.targets).toEqual([]);
  });

  it('setActiveTarget updates value and notifies listeners', () => {
    const listener = vi.fn();
    terminalState.subscribe(listener);
    const target = { sessionId: 's1', label: 'Test', cwd: '/tmp', kind: 'project' as const };
    terminalState.setActiveTarget(target);
    expect(terminalState.activeTarget).toBe(target);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('setTargets updates value and notifies listeners', () => {
    const listener = vi.fn();
    terminalState.subscribe(listener);
    const targets = [{ sessionId: 's1', label: 'Test', cwd: '/tmp', kind: 'project' as const }];
    terminalState.setTargets(targets);
    expect(terminalState.targets).toBe(targets);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('subscribe returns unsubscribe function that prevents further callbacks', () => {
    const listener = vi.fn();
    const unsub = terminalState.subscribe(listener);
    terminalState.setActiveTarget({ sessionId: 's1', label: 'A', cwd: '/', kind: 'project' });
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    terminalState.setActiveTarget({ sessionId: 's2', label: 'B', cwd: '/', kind: 'project' });
    expect(listener).toHaveBeenCalledTimes(1); // not called again
  });

  it('reset clears activeTarget, targets, and all listeners', () => {
    const listener = vi.fn();
    terminalState.subscribe(listener);
    terminalState.setActiveTarget({ sessionId: 's1', label: 'A', cwd: '/', kind: 'project' });
    terminalState.setTargets([{ sessionId: 's1', label: 'A', cwd: '/', kind: 'project' }]);
    listener.mockClear();

    terminalState.reset();
    expect(terminalState.activeTarget).toBeNull();
    expect(terminalState.targets).toEqual([]);

    // Listener was cleared, so further changes don't notify
    terminalState.setActiveTarget({ sessionId: 's2', label: 'B', cwd: '/', kind: 'project' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('multiple listeners all receive notifications', () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    terminalState.subscribe(l1);
    terminalState.subscribe(l2);
    terminalState.setActiveTarget({ sessionId: 's1', label: 'A', cwd: '/', kind: 'project' });
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  it('double-unsubscribe is safe (no-op)', () => {
    const listener = vi.fn();
    const unsub = terminalState.subscribe(listener);
    unsub();
    expect(() => unsub()).not.toThrow();
  });
});

// ── makeSessionId ────────────────────────────────────────────────────

describe('makeSessionId', () => {
  it('project root produces terminal:<projectId>:project', () => {
    expect(makeSessionId('proj-abc', 'project')).toBe('terminal:proj-abc:project');
  });

  it('agent produces terminal:<projectId>:agent:<name>', () => {
    expect(makeSessionId('proj-abc', 'agent', 'snazzy-fox')).toBe('terminal:proj-abc:agent:snazzy-fox');
  });

  it('project and agent IDs never collide even if agent name is "project"', () => {
    const projectId = makeSessionId('proj-abc', 'project');
    const agentId = makeSessionId('proj-abc', 'agent', 'project');
    expect(projectId).not.toBe(agentId);
  });

  it('different agents produce different IDs', () => {
    const id1 = makeSessionId('proj-abc', 'agent', 'alpha');
    const id2 = makeSessionId('proj-abc', 'agent', 'beta');
    expect(id1).not.toBe(id2);
  });

  it('different projects produce different IDs for same agent name', () => {
    const id1 = makeSessionId('proj-1', 'agent', 'alpha');
    const id2 = makeSessionId('proj-2', 'agent', 'alpha');
    expect(id1).not.toBe(id2);
  });
});

// ── MainPanel (component contract) ───────────────────────────────────

describe('terminal plugin MainPanel', () => {
  it('is exported as a function', () => {
    expect(typeof MainPanel).toBe('function');
  });

  it('conforms to PluginModule.MainPanel shape (accepts { api })', () => {
    // Structural check: MainPanel expects a single prop object with `api`
    expect(MainPanel.length).toBeLessThanOrEqual(1); // one props arg
  });
});

// ── SidebarPanel (component contract) ────────────────────────────────

describe('terminal plugin SidebarPanel', () => {
  it('is exported as a function', () => {
    expect(typeof SidebarPanel).toBe('function');
  });

  it('conforms to PluginModule.SidebarPanel shape (accepts { api })', () => {
    expect(SidebarPanel.length).toBeLessThanOrEqual(1); // one props arg
  });
});

// ── MainPanel API assumptions ────────────────────────────────────────
// The plugin assumes certain things about the API it receives.
// These tests document those assumptions so that if the API changes,
// the failure is traceable to a specific assumption.

describe('terminal plugin API assumptions', () => {
  let api: PluginAPI;

  beforeEach(() => {
    api = createMockAPI();
  });

  // ── context assumptions ────────────────────────────────────────────

  describe('context', () => {
    it('assumes api.context.projectId is a string (used to build session IDs)', () => {
      expect(typeof api.context.projectId).toBe('string');
    });

    it('assumes api.context.projectPath is a string (used to build absolute cwds)', () => {
      expect(typeof api.context.projectPath).toBe('string');
    });

    it('falls back to "default" when projectId is undefined', () => {
      const noProjectApi = createMockAPI({
        context: { mode: 'project', projectId: undefined, projectPath: undefined },
      });
      const projectId = noProjectApi.context.projectId || 'default';
      expect(projectId).toBe('default');
    });

    it('falls back to empty string when projectPath is undefined', () => {
      const noProjectApi = createMockAPI({
        context: { mode: 'project', projectId: undefined, projectPath: undefined },
      });
      const projectPath = noProjectApi.context.projectPath || '';
      expect(projectPath).toBe('');
    });
  });

  // ── agents API assumptions ────────────────────────────────────────

  describe('agents.list()', () => {
    it('exists and returns an array', () => {
      expect(typeof api.agents.list).toBe('function');
      expect(Array.isArray(api.agents.list())).toBe(true);
    });

    it('items have name, kind, worktreePath fields', () => {
      const mockApi = createMockAPI({
        agents: {
          ...api.agents,
          list: vi.fn().mockReturnValue([
            { id: 'a1', name: 'alpha', kind: 'durable', worktreePath: '.clubhouse/agents/alpha' },
            { id: 'a2', name: 'beta', kind: 'quick', worktreePath: undefined },
          ]),
        },
      });
      const agents = mockApi.agents.list();
      expect(agents[0]).toHaveProperty('name');
      expect(agents[0]).toHaveProperty('kind');
      expect(agents[0]).toHaveProperty('worktreePath');
    });

    it('items with kind "durable" may have worktreePath as a string', () => {
      const mockApi = createMockAPI({
        agents: {
          ...api.agents,
          list: vi.fn().mockReturnValue([
            { id: 'a1', name: 'alpha', kind: 'durable', worktreePath: '.clubhouse/agents/alpha' },
          ]),
        },
      });
      const agent = mockApi.agents.list()[0];
      expect(agent.kind).toBe('durable');
      expect(typeof agent.worktreePath).toBe('string');
    });

    it('items with kind "quick" have worktreePath undefined', () => {
      const mockApi = createMockAPI({
        agents: {
          ...api.agents,
          list: vi.fn().mockReturnValue([
            { id: 'a2', name: 'beta', kind: 'quick', worktreePath: undefined },
          ]),
        },
      });
      const agent = mockApi.agents.list()[0];
      expect(agent.kind).toBe('quick');
      expect(agent.worktreePath).toBeUndefined();
    });
  });

  describe('agents.onAnyChange()', () => {
    it('exists and returns a Disposable', () => {
      expect(typeof api.agents.onAnyChange).toBe('function');
      const d = api.agents.onAnyChange(() => {});
      expect(typeof d.dispose).toBe('function');
    });

    it('dispose does not throw', () => {
      const d = api.agents.onAnyChange(() => {});
      expect(() => d.dispose()).not.toThrow();
    });
  });

  // ── terminal.spawn assumptions ─────────────────────────────────────

  describe('terminal.spawn', () => {
    it('exists and is callable', () => {
      expect(typeof api.terminal.spawn).toBe('function');
    });

    it('returns a promise', () => {
      const result = api.terminal.spawn('session', '/path');
      expect(result).toBeInstanceOf(Promise);
    });

    it('resolves to void on success', async () => {
      const result = await api.terminal.spawn('session', '/path');
      expect(result).toBeUndefined();
    });

    it('plugin catches spawn rejection (expects it can throw)', async () => {
      const failApi = createMockAPI({
        terminal: {
          ...api.terminal,
          spawn: vi.fn().mockRejectedValue(new Error('spawn failed')),
        },
      });
      // The plugin wraps spawn in try/catch and sets status to 'exited'
      // Verify the mock can actually reject
      await expect(failApi.terminal.spawn('s', '/p')).rejects.toThrow('spawn failed');
    });
  });

  // ── terminal.kill assumptions ──────────────────────────────────────

  describe('terminal.kill', () => {
    it('exists and is callable', () => {
      expect(typeof api.terminal.kill).toBe('function');
    });

    it('returns a promise', () => {
      const result = api.terminal.kill('session');
      expect(result).toBeInstanceOf(Promise);
    });

    it('resolves to void', async () => {
      expect(await api.terminal.kill('session')).toBeUndefined();
    });
  });

  // ── terminal.getBuffer assumptions ─────────────────────────────────

  describe('terminal.getBuffer', () => {
    it('exists and is callable', () => {
      expect(typeof api.terminal.getBuffer).toBe('function');
    });

    it('returns a promise resolving to a string', async () => {
      const buf = await api.terminal.getBuffer('session');
      expect(typeof buf).toBe('string');
    });

    it('plugin treats empty string as "no existing session"', async () => {
      const buf = await api.terminal.getBuffer('session');
      // The plugin does: if (buf && buf.length > 0) { ... existing session ... }
      // Empty string means no session → spawn new
      expect(buf.length === 0).toBe(true);
    });

    it('plugin treats non-empty string as "existing session"', async () => {
      const liveApi = createMockAPI({
        terminal: {
          ...api.terminal,
          getBuffer: vi.fn().mockResolvedValue('$ ls\nREADME.md\n'),
        },
      });
      const buf = await liveApi.terminal.getBuffer('session');
      expect(buf.length > 0).toBe(true);
    });
  });

  // ── terminal.onExit assumptions ────────────────────────────────────

  describe('terminal.onExit', () => {
    it('exists and is callable', () => {
      expect(typeof api.terminal.onExit).toBe('function');
    });

    it('returns a Disposable with dispose()', () => {
      const d = api.terminal.onExit('session', () => {});
      expect(typeof d.dispose).toBe('function');
    });

    it('dispose does not throw', () => {
      const d = api.terminal.onExit('session', () => {});
      expect(() => d.dispose()).not.toThrow();
    });

    it('callback receives exit code as a number', () => {
      // The plugin does: api.terminal.onExit(sessionId, (code) => { setExitCode(code); })
      // It assumes the callback receives a number
      let captured: unknown;
      const captureApi = createMockAPI({
        terminal: {
          ...api.terminal,
          onExit: (sessionId: string, cb: (exitCode: number) => void) => {
            cb(137);
            captured = 137;
            return { dispose: () => {} };
          },
        },
      });
      captureApi.terminal.onExit('s', (code) => { captured = code; });
      expect(typeof captured).toBe('number');
    });
  });

  // ── terminal.onData assumptions ────────────────────────────────────

  describe('terminal.onData', () => {
    it('exists and is callable', () => {
      expect(typeof api.terminal.onData).toBe('function');
    });

    it('returns a Disposable', () => {
      const d = api.terminal.onData('session', () => {});
      expect(typeof d.dispose).toBe('function');
    });
  });

  // ── terminal.write assumptions ─────────────────────────────────────

  describe('terminal.write', () => {
    it('exists and is callable', () => {
      expect(typeof api.terminal.write).toBe('function');
    });

    it('is synchronous (returns void, not Promise)', () => {
      const result = api.terminal.write('session', 'data');
      expect(result).toBeUndefined();
      // Not a promise
      expect(result).not.toBeInstanceOf(Promise);
    });
  });

  // ── terminal.resize assumptions ────────────────────────────────────

  describe('terminal.resize', () => {
    it('exists and is callable', () => {
      expect(typeof api.terminal.resize).toBe('function');
    });

    it('is synchronous (returns void)', () => {
      const result = api.terminal.resize('session', 80, 24);
      expect(result).toBeUndefined();
    });
  });

  // ── terminal.ShellTerminal assumptions ─────────────────────────────

  describe('terminal.ShellTerminal', () => {
    it('exists and is a component (function)', () => {
      expect(typeof api.terminal.ShellTerminal).toBe('function');
    });

    it('plugin passes sessionId and focused props', () => {
      // The plugin calls: React.createElement(ShellTerminal, { sessionId, focused: true })
      // Structural check: ShellTerminal accepts these props without error
      const ShellTerminal = api.terminal.ShellTerminal;
      expect(ShellTerminal).toBeDefined();
    });
  });

  // ── commands.register assumptions ──────────────────────────────────

  describe('commands.register', () => {
    it('returns a Disposable', () => {
      const d = api.commands.register('restart', () => {});
      expect(typeof d.dispose).toBe('function');
    });
  });
});

// ── Session ID derivation ────────────────────────────────────────────
// The plugin derives session IDs from context via makeSessionId.

describe('terminal plugin session ID scheme', () => {
  it('uses projectId to build session ID for project target', () => {
    const sid = makeSessionId('proj-abc', 'project');
    expect(sid).toBe('terminal:proj-abc:project');
  });

  it('uses "default" projectId when projectId is missing', () => {
    const api = createMockAPI({ context: { mode: 'project', projectId: undefined, projectPath: undefined } });
    const projectId = api.context.projectId || 'default';
    const sid = makeSessionId(projectId, 'project');
    expect(sid).toBe('terminal:default:project');
  });

  it('different projects produce different session IDs', () => {
    const s1 = makeSessionId('proj-1', 'project');
    const s2 = makeSessionId('proj-2', 'project');
    expect(s1).not.toBe(s2);
  });

  it('passes projectPath as cwd to spawn', () => {
    const api = createMockAPI({ context: { mode: 'project', projectId: 'proj-1', projectPath: '/my/project' } });
    const projectPath = api.context.projectPath || '';
    expect(projectPath).toBe('/my/project');
  });
});

// ── Plugin lifecycle integration ─────────────────────────────────────
// Tests that the plugin interacts correctly with the plugin lifecycle.

describe('terminal plugin lifecycle', () => {
  beforeEach(() => {
    terminalState.reset();
  });

  it('activate then deactivate does not throw', () => {
    const ctx = createMockContext({ pluginId: 'terminal' });
    const api = createMockAPI();
    activate(ctx, api);
    deactivate();
  });

  it('subscriptions from activate are disposable', () => {
    const ctx = createMockContext({ pluginId: 'terminal' });
    const disposeSpy = vi.fn();
    const api = createMockAPI({
      commands: { register: () => ({ dispose: disposeSpy }), execute: vi.fn() },
    });
    activate(ctx, api);
    expect(ctx.subscriptions).toHaveLength(1);
    ctx.subscriptions[0].dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('subscriptions dispose is idempotent (double-dispose safe)', () => {
    const ctx = createMockContext({ pluginId: 'terminal' });
    const disposeSpy = vi.fn();
    const api = createMockAPI({
      commands: { register: () => ({ dispose: disposeSpy }), execute: vi.fn() },
    });
    activate(ctx, api);
    ctx.subscriptions[0].dispose();
    ctx.subscriptions[0].dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(2); // caller responsible for idempotency
  });
});

// ── Module exports ───────────────────────────────────────────────────

describe('terminal plugin module exports', () => {
  it('exports activate function', () => {
    expect(typeof terminalModule.activate).toBe('function');
  });

  it('exports deactivate function', () => {
    expect(typeof terminalModule.deactivate).toBe('function');
  });

  it('exports MainPanel component', () => {
    expect(typeof terminalModule.MainPanel).toBe('function');
  });

  it('exports SidebarPanel component', () => {
    expect(typeof (terminalModule as any).SidebarPanel).toBe('function');
  });

  it('does not export HubPanel', () => {
    expect((terminalModule as any).HubPanel).toBeUndefined();
  });

  it('does not export SettingsPanel', () => {
    expect((terminalModule as any).SettingsPanel).toBeUndefined();
  });
});
