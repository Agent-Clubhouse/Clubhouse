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

const mockLog = { write: vi.fn() };

Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      plugin: mockPlugin,
      file: mockFile,
      git: mockGit,
      agent: mockAgent,
      pty: mockPty,
      log: mockLog,
    },
    confirm: vi.fn(),
    prompt: vi.fn(),
  },
  writable: true,
});

// Mock the builtin module
vi.mock('./builtin', () => ({
  getBuiltinPlugins: vi.fn(() => []),
  getDefaultEnabledIds: vi.fn(() => new Set<string>()),
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
import { getBuiltinPlugins, getDefaultEnabledIds } from './builtin';

function makeManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    engine: { api: 0.5 },
    scope: 'project',
    permissions: [],
    contributes: {
      help: { topics: [{ id: 'test', title: 'Test', content: 'Test help' }] },
    },
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

    it('auto-enables default built-in plugins at app level', async () => {
      const appManifest = makeManifest({ id: 'builtin-app', scope: 'app' });
      const dualManifest = makeManifest({ id: 'builtin-dual', scope: 'dual' });
      const projManifest = makeManifest({ id: 'builtin-proj', scope: 'project' });
      (getBuiltinPlugins as ReturnType<typeof vi.fn>).mockReturnValue([
        { manifest: appManifest, module: {} },
        { manifest: dualManifest, module: {} },
        { manifest: projManifest, module: {} },
      ]);
      (getDefaultEnabledIds as ReturnType<typeof vi.fn>).mockReturnValue(
        new Set(['builtin-app', 'builtin-dual', 'builtin-proj']),
      );

      await initializePluginSystem();

      const { appEnabled } = usePluginStore.getState();
      expect(appEnabled).toContain('builtin-app');
      expect(appEnabled).toContain('builtin-dual');
      expect(appEnabled).toContain('builtin-proj');
    });

    it('does not auto-enable non-default built-in plugins', async () => {
      const defaultManifest = makeManifest({ id: 'default-plug', scope: 'project' });
      const optionalManifest = makeManifest({ id: 'optional-plug', scope: 'project' });
      (getBuiltinPlugins as ReturnType<typeof vi.fn>).mockReturnValue([
        { manifest: defaultManifest, module: {} },
        { manifest: optionalManifest, module: {} },
      ]);
      (getDefaultEnabledIds as ReturnType<typeof vi.fn>).mockReturnValue(
        new Set(['default-plug']),
      );

      await initializePluginSystem();

      const { appEnabled, plugins } = usePluginStore.getState();
      expect(appEnabled).toContain('default-plug');
      expect(appEnabled).not.toContain('optional-plug');
      // Non-default plugin is still registered
      expect(plugins['optional-plug']).toBeDefined();
      expect(plugins['optional-plug'].source).toBe('builtin');
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
      mockLog.write.mockClear();
      await activatePlugin('nonexistent');
      expect(mockLog.write).toHaveBeenCalledWith(
        expect.objectContaining({ ns: 'core:plugins', level: 'error', msg: expect.stringContaining('Cannot activate unknown plugin') }),
      );
    });

    it('skips activation of incompatible plugin', async () => {
      mockLog.write.mockClear();
      usePluginStore.getState().registerPlugin(
        makeManifest({ id: 'bad' }), 'community', '/path', 'incompatible', 'bad engine'
      );

      await activatePlugin('bad');

      expect(mockLog.write).toHaveBeenCalledWith(
        expect.objectContaining({ ns: 'core:plugins', level: 'warn', msg: expect.stringContaining('Skipping activation') }),
      );
      expect(usePluginStore.getState().plugins['bad'].status).toBe('incompatible');
    });

    it('skips activation of errored plugin', async () => {
      mockLog.write.mockClear();
      usePluginStore.getState().registerPlugin(
        makeManifest({ id: 'err' }), 'community', '/path', 'errored', 'load failed'
      );

      await activatePlugin('err');

      expect(mockLog.write).toHaveBeenCalledWith(
        expect.objectContaining({ ns: 'core:plugins', level: 'warn', msg: expect.stringContaining('Skipping activation') }),
      );
    });

    it('skips activation of disabled plugin', async () => {
      mockLog.write.mockClear();
      usePluginStore.getState().registerPlugin(
        makeManifest({ id: 'dis' }), 'community', '/path', 'disabled', 'permission violation'
      );

      await activatePlugin('dis');

      expect(mockLog.write).toHaveBeenCalledWith(
        expect.objectContaining({ ns: 'core:plugins', level: 'warn', msg: expect.stringContaining('Skipping activation') }),
      );
      expect(usePluginStore.getState().plugins['dis'].status).toBe('disabled');
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

    it('loads settings from storage when not in memory store', async () => {
      // Settings are NOT in the Zustand store but ARE persisted on disk
      mockPlugin.storageRead.mockImplementation(async (req: { key: string }) => {
        if (req.key === 'settings-proj-1-storage-p') return { wikiPath: '/wiki', wikiStyle: 'ado' };
        return undefined;
      });

      const mod: PluginModule = { activate: vi.fn() };
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'storage-p', scope: 'project' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('storage-p', mod);

      await activatePlugin('storage-p', 'proj-1', '/p1');

      // Settings should have been loaded from storage and passed to context
      const call = (mod.activate as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0].settings).toEqual({ wikiPath: '/wiki', wikiStyle: 'ado' });
      // Settings should also be in the store now
      expect(usePluginStore.getState().pluginSettings['proj-1:storage-p']).toEqual({ wikiPath: '/wiki', wikiStyle: 'ado' });
    });

    it('falls back gracefully when storage read fails', async () => {
      mockPlugin.storageRead.mockRejectedValue(new Error('storage unavailable'));

      const mod: PluginModule = { activate: vi.fn() };
      usePluginStore.getState().registerPlugin(makeManifest({ id: 'no-storage', scope: 'app' }), 'builtin', '', 'registered');
      usePluginStore.getState().setPluginModule('no-storage', mod);

      await activatePlugin('no-storage');

      // Should still activate, just with empty settings
      const call = (mod.activate as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0].settings).toEqual({});
      expect(usePluginStore.getState().plugins['no-storage'].status).toBe('activated');
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
