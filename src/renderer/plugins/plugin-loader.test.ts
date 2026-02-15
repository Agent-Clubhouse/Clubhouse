import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { usePluginStore } from './plugin-store';
import type { PluginManifest, PluginModule } from '../../shared/plugin-types';

// We need to mock window.clubhouse before importing plugin-loader
const mockPlugin = {
  startupMarkerRead: vi.fn(),
  startupMarkerClear: vi.fn(),
  discoverCommunity: vi.fn(),
  storageRead: vi.fn(),
  storageWrite: vi.fn(),
  storageDelete: vi.fn(),
  storageList: vi.fn(),
};
const mockFile = { read: vi.fn(), write: vi.fn(), delete: vi.fn(), readTree: vi.fn() };
const mockGit = { info: vi.fn(), diff: vi.fn() };
const mockAgent = { listDurable: vi.fn(), killAgent: vi.fn() };
const mockPty = { kill: vi.fn() };

Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      plugin: mockPlugin,
      file: mockFile,
      git: mockGit,
      agent: mockAgent,
      pty: mockPty,
    },
    confirm: vi.fn(),
    prompt: vi.fn(),
  },
  writable: true,
});

// Mock the builtin module
vi.mock('./builtin', () => ({
  getBuiltinPlugins: vi.fn(() => []),
}));

// Mock plugin-styles to avoid DOM operations
vi.mock('./plugin-styles', () => ({
  injectStyles: vi.fn(),
  removeStyles: vi.fn(),
}));

import {
  initializePluginSystem,
  activatePlugin,
  deactivatePlugin,
  handleProjectSwitch,
  getActiveContext,
  _resetActiveContexts,
} from './plugin-loader';
import { getBuiltinPlugins } from './builtin';

function makeManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    engine: { api: 0.1 },
    scope: 'project',
    ...overrides,
  };
}

function resetPluginStore(): void {
  usePluginStore.setState({
    plugins: {},
    projectEnabled: {},
    appEnabled: [],
    modules: {},
    safeModeActive: false,
    pluginSettings: {},
  });
}

describe('plugin-loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPluginStore();
    _resetActiveContexts();
    mockPlugin.startupMarkerRead.mockResolvedValue(null);
    mockPlugin.startupMarkerClear.mockResolvedValue(undefined);
    mockPlugin.discoverCommunity.mockResolvedValue([]);
    mockPlugin.storageRead.mockResolvedValue(undefined);
    (getBuiltinPlugins as ReturnType<typeof vi.fn>).mockReturnValue([]);
  });

  // ── initializePluginSystem ──────────────────────────────────────────

  describe('initializePluginSystem()', () => {
    it('discovers community plugins and registers them', async () => {
      const manifest = makeManifest({ id: 'community-1' });
      mockPlugin.discoverCommunity.mockResolvedValue([
        { manifest, pluginPath: '/plugins/community-1' },
      ]);

      await initializePluginSystem();

      const store = usePluginStore.getState();
      expect(store.plugins['community-1']).toBeDefined();
      expect(store.plugins['community-1'].source).toBe('community');
      expect(store.plugins['community-1'].status).toBe('registered');
    });

    it('registers invalid community plugins as incompatible', async () => {
      mockPlugin.discoverCommunity.mockResolvedValue([
        { manifest: { id: 'bad-plugin' }, pluginPath: '/plugins/bad' },
      ]);

      await initializePluginSystem();

      const store = usePluginStore.getState();
      expect(store.plugins['bad-plugin']).toBeDefined();
      expect(store.plugins['bad-plugin'].status).toBe('incompatible');
    });

    it('activates safe mode when startup marker attempt >= 2', async () => {
      mockPlugin.startupMarkerRead.mockResolvedValue({ timestamp: Date.now(), attempt: 2, lastEnabledPlugins: [] });

      await initializePluginSystem();

      const store = usePluginStore.getState();
      expect(store.safeModeActive).toBe(true);
      // Should not discover community plugins
      expect(mockPlugin.discoverCommunity).not.toHaveBeenCalled();
    });

    it('does not activate safe mode when attempt < 2', async () => {
      mockPlugin.startupMarkerRead.mockResolvedValue({ timestamp: Date.now(), attempt: 1, lastEnabledPlugins: [] });

      await initializePluginSystem();

      expect(usePluginStore.getState().safeModeActive).toBe(false);
      expect(mockPlugin.discoverCommunity).toHaveBeenCalled();
    });

    it('loads app-enabled config from storage', async () => {
      mockPlugin.storageRead.mockImplementation(async (req: { key: string }) => {
        if (req.key === 'app-enabled') return ['plugin-a', 'plugin-b'];
        return undefined;
      });

      await initializePluginSystem();

      expect(usePluginStore.getState().appEnabled).toEqual(['plugin-a', 'plugin-b']);
    });

    it('handles missing app-enabled config gracefully', async () => {
      mockPlugin.storageRead.mockRejectedValue(new Error('no config'));

      await initializePluginSystem();

      // Should not crash, appEnabled remains default
      expect(usePluginStore.getState().appEnabled).toEqual([]);
    });

    it('clears startup marker after successful init', async () => {
      await initializePluginSystem();
      expect(mockPlugin.startupMarkerClear).toHaveBeenCalled();
    });

    it('does not clear startup marker in safe mode', async () => {
      mockPlugin.startupMarkerRead.mockResolvedValue({ timestamp: Date.now(), attempt: 3, lastEnabledPlugins: [] });

      await initializePluginSystem();

      expect(mockPlugin.startupMarkerClear).not.toHaveBeenCalled();
    });

    // ── Built-in plugin registration ────────────────────────────────

    it('registers built-in plugins', async () => {
      const manifest = makeManifest({ id: 'builtin-1', scope: 'app' });
      const module: PluginModule = { activate: vi.fn() };
      (getBuiltinPlugins as ReturnType<typeof vi.fn>).mockReturnValue([{ manifest, module }]);

      await initializePluginSystem();

      const store = usePluginStore.getState();
      expect(store.plugins['builtin-1']).toBeDefined();
      expect(store.plugins['builtin-1'].source).toBe('builtin');
      expect(store.plugins['builtin-1'].status).toBe('registered');
    });

    it('sets module directly for built-in plugins', async () => {
      const manifest = makeManifest({ id: 'builtin-1', scope: 'app' });
      const module: PluginModule = {};
      (getBuiltinPlugins as ReturnType<typeof vi.fn>).mockReturnValue([{ manifest, module }]);

      await initializePluginSystem();

      expect(usePluginStore.getState().modules['builtin-1']).toBe(module);
    });

    it('auto-enables app-scoped built-in plugins', async () => {
      const manifest = makeManifest({ id: 'builtin-app', scope: 'app' });
      (getBuiltinPlugins as ReturnType<typeof vi.fn>).mockReturnValue([{ manifest, module: {} }]);

      await initializePluginSystem();

      expect(usePluginStore.getState().appEnabled).toContain('builtin-app');
    });

    it('auto-enables dual-scoped built-in plugins', async () => {
      const manifest = makeManifest({ id: 'builtin-dual', scope: 'dual' });
      (getBuiltinPlugins as ReturnType<typeof vi.fn>).mockReturnValue([{ manifest, module: {} }]);

      await initializePluginSystem();

      expect(usePluginStore.getState().appEnabled).toContain('builtin-dual');
    });

    it('auto-enables project-scoped built-in plugins at app level (availability gate)', async () => {
      const manifest = makeManifest({ id: 'builtin-proj', scope: 'project' });
      (getBuiltinPlugins as ReturnType<typeof vi.fn>).mockReturnValue([{ manifest, module: {} }]);

      await initializePluginSystem();

      expect(usePluginStore.getState().appEnabled).toContain('builtin-proj');
    });

    it('registers multiple built-in plugins', async () => {
      (getBuiltinPlugins as ReturnType<typeof vi.fn>).mockReturnValue([
        { manifest: makeManifest({ id: 'b1', scope: 'app' }), module: {} },
        { manifest: makeManifest({ id: 'b2', scope: 'project' }), module: {} },
        { manifest: makeManifest({ id: 'b3', scope: 'dual' }), module: {} },
      ]);

      await initializePluginSystem();

      const store = usePluginStore.getState();
      expect(Object.keys(store.plugins)).toContain('b1');
      expect(Object.keys(store.plugins)).toContain('b2');
      expect(Object.keys(store.plugins)).toContain('b3');
    });
  });

  // ── activatePlugin ──────────────────────────────────────────────────

  describe('activatePlugin()', () => {
    it('does not activate unknown plugin', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await activatePlugin('nonexistent');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Cannot activate unknown plugin'));
      spy.mockRestore();
    });

    it('skips activation of incompatible plugin', async () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      usePluginStore.getState().registerPlugin(
        makeManifest({ id: 'bad' }), 'community', '/path', 'incompatible', 'bad engine'
      );

      await activatePlugin('bad');

      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Skipping activation'));
      expect(usePluginStore.getState().plugins['bad'].status).toBe('incompatible');
      spy.mockRestore();
    });

    it('skips activation of errored plugin', async () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      usePluginStore.getState().registerPlugin(
        makeManifest({ id: 'err' }), 'community', '/path', 'errored', 'load failed'
      );

      await activatePlugin('err');

      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Skipping activation'));
      spy.mockRestore();
    });

    it('does not activate same plugin twice (idempotent)', async () => {
      const mod: PluginModule = { activate: vi.fn() };
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'p1', scope: 'app' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('p1', mod);

      await activatePlugin('p1');
      await activatePlugin('p1');

      expect(mod.activate).toHaveBeenCalledTimes(1);
    });

    it('activates builtin plugin without dynamic import', async () => {
      const mod: PluginModule = { activate: vi.fn() };
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'builtin-p', scope: 'app' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('builtin-p', mod);

      await activatePlugin('builtin-p');

      expect(mod.activate).toHaveBeenCalledTimes(1);
      expect(usePluginStore.getState().plugins['builtin-p'].status).toBe('activated');
    });

    it('passes context and api to activate()', async () => {
      const mod: PluginModule = { activate: vi.fn() };
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'bp', scope: 'app' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('bp', mod);

      await activatePlugin('bp');

      expect(mod.activate).toHaveBeenCalledWith(
        expect.objectContaining({ pluginId: 'bp', scope: 'app' }),
        expect.objectContaining({ agents: expect.any(Object) }),
      );
    });

    it('sets status to activated on success', async () => {
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'p2', scope: 'app' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('p2', {});

      await activatePlugin('p2');

      expect(usePluginStore.getState().plugins['p2'].status).toBe('activated');
    });

    it('sets status to errored when activate() throws', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mod: PluginModule = {
        activate: vi.fn().mockRejectedValue(new Error('boom')),
      };
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'fail', scope: 'app' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('fail', mod);

      await activatePlugin('fail');

      expect(usePluginStore.getState().plugins['fail'].status).toBe('errored');
      spy.mockRestore();
    });

    it('loads saved settings into context', async () => {
      usePluginStore.setState({
        pluginSettings: { 'app:settings-p': { color: 'blue' } },
      });
      const mod: PluginModule = { activate: vi.fn() };
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'settings-p', scope: 'app' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('settings-p', mod);

      await activatePlugin('settings-p');

      const call = (mod.activate as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0].settings).toEqual({ color: 'blue' });
    });

    it('creates unique context per project for project-scoped plugins', async () => {
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'pp', scope: 'project' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('pp', {});

      await activatePlugin('pp', 'proj-1', '/p1');
      await activatePlugin('pp', 'proj-2', '/p2');

      expect(getActiveContext('pp', 'proj-1')).toBeDefined();
      expect(getActiveContext('pp', 'proj-2')).toBeDefined();
      expect(getActiveContext('pp', 'proj-1')!.projectPath).toBe('/p1');
      expect(getActiveContext('pp', 'proj-2')!.projectPath).toBe('/p2');
    });

    it('activates dual-scoped plugin with project context', async () => {
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'dp', scope: 'dual' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('dp', {});

      await activatePlugin('dp', 'proj-1', '/p1');

      const ctx = getActiveContext('dp', 'proj-1');
      expect(ctx).toBeDefined();
      expect(ctx!.scope).toBe('dual');
      expect(ctx!.projectId).toBe('proj-1');
    });
  });

  // ── deactivatePlugin ─────────────────────────────────────────────────

  describe('deactivatePlugin()', () => {
    it('does nothing for non-active plugin', async () => {
      await expect(deactivatePlugin('nonexistent')).resolves.toBeUndefined();
    });

    it('calls deactivate() on module', async () => {
      const mod: PluginModule = { deactivate: vi.fn() };
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'deact', scope: 'app' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('deact', mod);
      await activatePlugin('deact');

      await deactivatePlugin('deact');

      expect(mod.deactivate).toHaveBeenCalled();
      expect(usePluginStore.getState().plugins['deact'].status).toBe('deactivated');
    });

    it('disposes subscriptions in reverse order', async () => {
      const order: number[] = [];
      const mod: PluginModule = {
        activate: (ctx) => {
          ctx.subscriptions.push({ dispose: () => order.push(1) });
          ctx.subscriptions.push({ dispose: () => order.push(2) });
          ctx.subscriptions.push({ dispose: () => order.push(3) });
        },
      };
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'subs', scope: 'app' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('subs', mod);
      await activatePlugin('subs');

      await deactivatePlugin('subs');

      expect(order).toEqual([3, 2, 1]);
    });

    it('removes context after deactivation', async () => {
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'ctx-rm', scope: 'app' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('ctx-rm', {});
      await activatePlugin('ctx-rm');
      expect(getActiveContext('ctx-rm')).toBeDefined();

      await deactivatePlugin('ctx-rm');

      expect(getActiveContext('ctx-rm')).toBeUndefined();
    });

    it('handles deactivate() throwing without crashing', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mod: PluginModule = {
        deactivate: vi.fn().mockRejectedValue(new Error('oops')),
      };
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'err-d', scope: 'app' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('err-d', mod);
      await activatePlugin('err-d');

      await expect(deactivatePlugin('err-d')).resolves.toBeUndefined();
      spy.mockRestore();
    });
  });

  // ── handleProjectSwitch ──────────────────────────────────────────────

  describe('handleProjectSwitch()', () => {
    beforeEach(async () => {
      // Register plugins of different scopes
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'proj-plug', scope: 'project' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('proj-plug', {});
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'dual-plug', scope: 'dual' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('dual-plug', {});
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'app-plug', scope: 'app' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('app-plug', {});
      // App-first gate: plugins must be app-enabled to activate at project level
      usePluginStore.getState().enableApp('proj-plug');
      usePluginStore.getState().enableApp('dual-plug');
      usePluginStore.getState().enableApp('app-plug');
    });

    it('activates project-scoped plugins for new project', async () => {
      usePluginStore.setState({
        projectEnabled: { 'proj-2': ['proj-plug'] },
      });

      await handleProjectSwitch(null, 'proj-2', '/p2');

      expect(getActiveContext('proj-plug', 'proj-2')).toBeDefined();
    });

    it('activates dual-scoped plugins for new project', async () => {
      usePluginStore.setState({
        projectEnabled: { 'proj-2': ['dual-plug'] },
      });

      await handleProjectSwitch(null, 'proj-2', '/p2');

      expect(getActiveContext('dual-plug', 'proj-2')).toBeDefined();
    });

    it('deactivates project-scoped plugins on old project', async () => {
      usePluginStore.setState({
        projectEnabled: { 'proj-1': ['proj-plug'], 'proj-2': [] },
      });
      await activatePlugin('proj-plug', 'proj-1', '/p1');
      expect(getActiveContext('proj-plug', 'proj-1')).toBeDefined();

      await handleProjectSwitch('proj-1', 'proj-2', '/p2');

      expect(getActiveContext('proj-plug', 'proj-1')).toBeUndefined();
    });

    it('deactivates dual-scoped plugins on old project', async () => {
      usePluginStore.setState({
        projectEnabled: { 'proj-1': ['dual-plug'], 'proj-2': [] },
      });
      await activatePlugin('dual-plug', 'proj-1', '/p1');

      await handleProjectSwitch('proj-1', 'proj-2', '/p2');

      expect(getActiveContext('dual-plug', 'proj-1')).toBeUndefined();
    });

    it('does NOT deactivate app-scoped plugins on project switch', async () => {
      await activatePlugin('app-plug');
      expect(getActiveContext('app-plug')).toBeDefined();

      usePluginStore.setState({
        projectEnabled: { 'proj-1': [], 'proj-2': [] },
      });

      await handleProjectSwitch('proj-1', 'proj-2', '/p2');

      expect(getActiveContext('app-plug')).toBeDefined();
    });

    it('handles null oldProjectId (first load)', async () => {
      usePluginStore.setState({
        projectEnabled: { 'proj-1': ['proj-plug'] },
      });

      await handleProjectSwitch(null, 'proj-1', '/p1');

      expect(getActiveContext('proj-plug', 'proj-1')).toBeDefined();
    });

    it('handles empty enabled list for new project', async () => {
      usePluginStore.setState({
        projectEnabled: { 'proj-2': [] },
      });

      await handleProjectSwitch(null, 'proj-2', '/p2');

      expect(getActiveContext('proj-plug', 'proj-2')).toBeUndefined();
    });

    it('handles project switch with no enabled plugins at all', async () => {
      await expect(handleProjectSwitch('proj-1', 'proj-2', '/p2')).resolves.toBeUndefined();
    });
  });

  // ── getActiveContext ──────────────────────────────────────────────────

  describe('getActiveContext()', () => {
    it('returns undefined for non-active plugin', () => {
      expect(getActiveContext('nonexistent')).toBeUndefined();
    });

    it('returns context for active app-scoped plugin', async () => {
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'ap', scope: 'app' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('ap', {});
      await activatePlugin('ap');

      const ctx = getActiveContext('ap');
      expect(ctx).toBeDefined();
      expect(ctx!.pluginId).toBe('ap');
    });

    it('returns context keyed by projectId for project-scoped plugin', async () => {
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'pp', scope: 'project' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('pp', {});
      await activatePlugin('pp', 'proj-1', '/p1');

      expect(getActiveContext('pp', 'proj-1')).toBeDefined();
      expect(getActiveContext('pp', 'proj-2')).toBeUndefined();
      expect(getActiveContext('pp')).toBeUndefined(); // Without projectId, different key
    });
  });
});
