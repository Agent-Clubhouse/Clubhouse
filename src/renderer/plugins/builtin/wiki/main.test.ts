import { describe, it, expect, vi, beforeEach } from 'vitest';
import { activate, deactivate, MainPanel, SidebarPanel } from './main';
import { manifest } from './manifest';
import * as wikiModule from './main';
import { wikiState } from './state';
import { validateBuiltinPlugin } from '../builtin-plugin-testing';
import { createMockContext, createMockAPI } from '../../testing';
import type { PluginAPI, PluginContext } from '../../../../shared/plugin-types';

// ── Built-in plugin validation ──────────────────────────────────────

describe('wiki plugin (built-in validation)', () => {
  it('passes validateBuiltinPlugin', () => {
    const result = validateBuiltinPlugin({ manifest, module: wikiModule });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── activate() ──────────────────────────────────────────────────────

describe('wiki plugin activate()', () => {
  let ctx: PluginContext;
  let api: PluginAPI;
  let registerSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    wikiState.reset();
    ctx = createMockContext({ pluginId: 'wiki' });
    registerSpy = vi.fn(() => ({ dispose: vi.fn() }));
    api = createMockAPI({
      commands: { register: registerSpy, execute: vi.fn() },
    });
  });

  it('registers a refresh command', () => {
    activate(ctx, api);
    expect(registerSpy).toHaveBeenCalledWith('refresh', expect.any(Function));
  });

  it('pushes exactly 1 disposable to ctx.subscriptions', () => {
    activate(ctx, api);
    expect(ctx.subscriptions).toHaveLength(1);
    expect(typeof ctx.subscriptions[0].dispose).toBe('function');
  });

  it('refresh command triggers wikiState.triggerRefresh', () => {
    activate(ctx, api);
    const refreshHandler = registerSpy.mock.calls[0][1];
    const before = wikiState.refreshCount;
    refreshHandler();
    expect(wikiState.refreshCount).toBe(before + 1);
  });
});

// ── deactivate() ────────────────────────────────────────────────────

describe('wiki plugin deactivate()', () => {
  beforeEach(() => {
    wikiState.reset();
  });

  it('resets wikiState', () => {
    wikiState.setSelectedPath('/some/file.md');
    wikiState.setViewMode('edit');
    wikiState.setDirty(true);
    wikiState.triggerRefresh();

    deactivate();

    expect(wikiState.selectedPath).toBeNull();
    expect(wikiState.viewMode).toBe('view');
    expect(wikiState.isDirty).toBe(false);
    expect(wikiState.listeners.size).toBe(0);
  });

  it('does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });

  it('is idempotent (multiple calls are safe)', () => {
    deactivate();
    deactivate();
    deactivate();
  });
});

// ── wikiState ───────────────────────────────────────────────────────

describe('wikiState', () => {
  beforeEach(() => {
    wikiState.reset();
  });

  it('setSelectedPath updates and notifies', () => {
    const listener = vi.fn();
    wikiState.subscribe(listener);
    wikiState.setSelectedPath('/test.md');
    expect(wikiState.selectedPath).toBe('/test.md');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('setDirty updates and notifies', () => {
    const listener = vi.fn();
    wikiState.subscribe(listener);
    wikiState.setDirty(true);
    expect(wikiState.isDirty).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('setViewMode updates and notifies', () => {
    const listener = vi.fn();
    wikiState.subscribe(listener);
    wikiState.setViewMode('edit');
    expect(wikiState.viewMode).toBe('edit');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('triggerRefresh increments count and notifies', () => {
    const listener = vi.fn();
    wikiState.subscribe(listener);
    const before = wikiState.refreshCount;
    wikiState.triggerRefresh();
    expect(wikiState.refreshCount).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('subscribe returns unsubscribe function', () => {
    const listener = vi.fn();
    const unsub = wikiState.subscribe(listener);
    wikiState.notify();
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    wikiState.notify();
    expect(listener).toHaveBeenCalledTimes(1); // not called again
  });

  it('reset clears all state including viewMode back to view', () => {
    wikiState.setSelectedPath('/file.md');
    wikiState.setDirty(true);
    wikiState.setViewMode('edit');
    wikiState.triggerRefresh();
    const listener = vi.fn();
    wikiState.subscribe(listener);

    wikiState.reset();

    expect(wikiState.selectedPath).toBeNull();
    expect(wikiState.isDirty).toBe(false);
    expect(wikiState.viewMode).toBe('view');
    expect(wikiState.refreshCount).toBe(0);
    expect(wikiState.listeners.size).toBe(0);
  });
});

// ── API assumptions ─────────────────────────────────────────────────

describe('wiki plugin API assumptions', () => {
  let api: PluginAPI;

  beforeEach(() => {
    api = createMockAPI();
  });

  describe('files.forRoot', () => {
    it('exists and is a function', () => {
      expect(typeof api.files.forRoot).toBe('function');
    });

    it('throws in test stub (documents plugin guard pattern)', () => {
      expect(() => api.files.forRoot('wiki')).toThrow();
    });

    it('scoped API has readTree, readFile, writeFile, stat, rename, copy, mkdir, delete methods', () => {
      const scopedApi = createMockAPI({
        files: {
          ...createMockAPI().files,
          forRoot: () => ({
            readTree: async () => [],
            readFile: async () => '',
            readBinary: async () => '',
            writeFile: async () => {},
            stat: async () => ({ size: 0, isDirectory: false, isFile: true, modifiedAt: 0 }),
            rename: async () => {},
            copy: async () => {},
            mkdir: async () => {},
            delete: async () => {},
            showInFolder: async () => {},
            forRoot: () => { throw new Error('nested'); },
          }),
        },
      });
      const scoped = scopedApi.files.forRoot('wiki');
      expect(typeof scoped.readTree).toBe('function');
      expect(typeof scoped.readFile).toBe('function');
      expect(typeof scoped.writeFile).toBe('function');
      expect(typeof scoped.stat).toBe('function');
      expect(typeof scoped.rename).toBe('function');
      expect(typeof scoped.copy).toBe('function');
      expect(typeof scoped.mkdir).toBe('function');
      expect(typeof scoped.delete).toBe('function');
    });
  });

  describe('agents.runQuick', () => {
    it('exists and returns a promise resolving to string', async () => {
      expect(typeof api.agents.runQuick).toBe('function');
      const result = await api.agents.runQuick('mission');
      expect(typeof result).toBe('string');
    });

    it('accepts systemPrompt option', async () => {
      await expect(
        api.agents.runQuick('mission', { systemPrompt: 'You are a wiki helper.' }),
      ).resolves.toBeDefined();
    });
  });

  describe('agents.list', () => {
    it('exists and returns an array', () => {
      expect(typeof api.agents.list).toBe('function');
      expect(Array.isArray(api.agents.list())).toBe(true);
    });

    it('plugin filters by kind === durable', () => {
      const testApi = createMockAPI({
        agents: {
          ...api.agents,
          list: vi.fn(() => [
            { id: 'a1', name: 'Agent 1', kind: 'durable', status: 'sleeping', color: '#ff0000' } as any,
            { id: 'a2', name: 'Agent 2', kind: 'quick', status: 'running', color: '#00ff00' } as any,
          ]),
        },
      });
      const durables = testApi.agents.list().filter((a) => a.kind === 'durable');
      expect(durables).toHaveLength(1);
      expect(durables[0].name).toBe('Agent 1');
    });
  });

  describe('agents.kill', () => {
    it('exists and returns a promise', () => {
      expect(typeof api.agents.kill).toBe('function');
      expect(api.agents.kill('agent-1')).toBeInstanceOf(Promise);
    });
  });

  describe('agents.resume', () => {
    it('exists and returns a promise', () => {
      expect(typeof api.agents.resume).toBe('function');
      expect(api.agents.resume('agent-1')).toBeInstanceOf(Promise);
    });
  });

  describe('ui.showInput', () => {
    it('exists and returns a promise', () => {
      expect(typeof api.ui.showInput).toBe('function');
      expect(api.ui.showInput('prompt')).toBeInstanceOf(Promise);
    });

    it('resolves to null when cancelled', async () => {
      const result = await api.ui.showInput('Mission');
      expect(result).toBeNull();
    });
  });

  describe('ui.showConfirm', () => {
    it('exists and returns a promise resolving to boolean', async () => {
      expect(typeof api.ui.showConfirm).toBe('function');
      const result = await api.ui.showConfirm('Continue?');
      expect(typeof result).toBe('boolean');
    });
  });

  describe('settings', () => {
    it('get returns undefined for missing keys', () => {
      expect(api.settings.get('wikiPath')).toBeUndefined();
    });

    it('onChange returns disposable', () => {
      const d = api.settings.onChange(() => {});
      expect(typeof d.dispose).toBe('function');
    });
  });

  describe('commands.register', () => {
    it('returns a Disposable', () => {
      const d = api.commands.register('refresh', () => {});
      expect(typeof d.dispose).toBe('function');
    });
  });
});

// ── Module exports ──────────────────────────────────────────────────

describe('wiki plugin module exports', () => {
  it('exports activate function', () => {
    expect(typeof wikiModule.activate).toBe('function');
  });

  it('exports deactivate function', () => {
    expect(typeof wikiModule.deactivate).toBe('function');
  });

  it('exports SidebarPanel component', () => {
    expect(typeof wikiModule.SidebarPanel).toBe('function');
  });

  it('exports MainPanel component', () => {
    expect(typeof wikiModule.MainPanel).toBe('function');
  });

  it('does not export HubPanel', () => {
    expect((wikiModule as any).HubPanel).toBeUndefined();
  });

  it('does not export SettingsPanel', () => {
    expect((wikiModule as any).SettingsPanel).toBeUndefined();
  });
});

// ── Plugin lifecycle ────────────────────────────────────────────────

describe('wiki plugin lifecycle', () => {
  it('activate then deactivate does not throw', () => {
    const ctx = createMockContext({ pluginId: 'wiki' });
    const api = createMockAPI();
    activate(ctx, api);
    deactivate();
  });

  it('subscriptions from activate are disposable', () => {
    const ctx = createMockContext({ pluginId: 'wiki' });
    const disposeSpy = vi.fn();
    const api = createMockAPI({
      commands: { register: () => ({ dispose: disposeSpy }), execute: vi.fn() },
    });
    activate(ctx, api);
    for (const sub of ctx.subscriptions) {
      sub.dispose();
    }
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
