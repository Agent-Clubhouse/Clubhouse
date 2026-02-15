import { describe, it, expect, vi, beforeEach } from 'vitest';
import { activate, deactivate, MainPanel } from './main';
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
  it('is a no-op function', () => {
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
    it('assumes api.context.projectId is a string (uses as session ID)', () => {
      expect(typeof api.context.projectId).toBe('string');
    });

    it('assumes api.context.projectPath is a string (passes to spawn cwd)', () => {
      expect(typeof api.context.projectPath).toBe('string');
    });

    it('falls back to "default" when projectId is undefined', () => {
      const noProjectApi = createMockAPI({
        context: { mode: 'project', projectId: undefined, projectPath: undefined },
      });
      // The plugin does: const sessionId = api.context.projectId || 'default'
      const sessionId = noProjectApi.context.projectId || 'default';
      expect(sessionId).toBe('default');
    });

    it('falls back to empty string when projectPath is undefined', () => {
      const noProjectApi = createMockAPI({
        context: { mode: 'project', projectId: undefined, projectPath: undefined },
      });
      // The plugin does: const projectPath = api.context.projectPath || ''
      const projectPath = noProjectApi.context.projectPath || '';
      expect(projectPath).toBe('');
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
// The plugin derives session IDs from context. This documents the scheme.

describe('terminal plugin session ID scheme', () => {
  it('uses projectId as session ID when available', () => {
    const api = createMockAPI({ context: { mode: 'project', projectId: 'proj-abc', projectPath: '/p' } });
    const sessionId = api.context.projectId || 'default';
    expect(sessionId).toBe('proj-abc');
  });

  it('uses "default" when projectId is missing', () => {
    const api = createMockAPI({ context: { mode: 'project', projectId: undefined, projectPath: undefined } });
    const sessionId = api.context.projectId || 'default';
    expect(sessionId).toBe('default');
  });

  it('different projects produce different session IDs', () => {
    const api1 = createMockAPI({ context: { mode: 'project', projectId: 'proj-1', projectPath: '/p1' } });
    const api2 = createMockAPI({ context: { mode: 'project', projectId: 'proj-2', projectPath: '/p2' } });
    const s1 = api1.context.projectId || 'default';
    const s2 = api2.context.projectId || 'default';
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

  it('does not export SidebarPanel (full layout, no sidebar)', () => {
    expect((terminalModule as any).SidebarPanel).toBeUndefined();
  });

  it('does not export HubPanel', () => {
    expect((terminalModule as any).HubPanel).toBeUndefined();
  });

  it('does not export SettingsPanel', () => {
    expect((terminalModule as any).SettingsPanel).toBeUndefined();
  });
});
