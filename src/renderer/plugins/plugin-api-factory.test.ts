import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPluginAPI } from './plugin-api-factory';
import { pluginEventBus } from './plugin-events';
import { pluginCommandRegistry } from './plugin-commands';
import { usePluginStore } from './plugin-store';
import { useAgentStore } from '../stores/agentStore';
import { useUIStore } from '../stores/uiStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import type { PluginContext, PluginAPI } from '../../shared/plugin-types';

// Mock window.clubhouse for IPC calls
const mockLog = {
  write: vi.fn(),
};

const mockPlugin = {
  storageRead: vi.fn(),
  storageWrite: vi.fn(),
  storageDelete: vi.fn(),
  storageList: vi.fn(),
};
const mockFile = {
  read: vi.fn(),
  write: vi.fn(),
  delete: vi.fn(),
  readTree: vi.fn(),
};
const mockGit = {
  info: vi.fn(),
  diff: vi.fn(),
};

const mockAgent = {
  listDurable: vi.fn(),
  killAgent: vi.fn(),
  getModelOptions: vi.fn(),
};

const mockPty = {
  spawnShell: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  getBuffer: vi.fn(),
  onData: vi.fn(),
  onExit: vi.fn(),
};

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

function makeCtx(overrides?: Partial<PluginContext>): PluginContext {
  return {
    pluginId: 'test-plugin',
    pluginPath: '/plugins/test-plugin',
    scope: 'project',
    projectId: 'proj-1',
    projectPath: '/projects/my-project',
    subscriptions: [],
    settings: {},
    ...overrides,
  };
}

describe('plugin-api-factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pluginCommandRegistry.clear();
    pluginEventBus.clear();
    usePluginStore.setState({
      plugins: {},
      projectEnabled: {},
      appEnabled: [],
      modules: {},
      safeModeActive: false,
      pluginSettings: {},
    });
  });

  describe('createPluginAPI', () => {
    it('returns an object with all required API namespaces', () => {
      const api = createPluginAPI(makeCtx());
      expect(api.project).toBeDefined();
      expect(api.projects).toBeDefined();
      expect(api.git).toBeDefined();
      expect(api.storage).toBeDefined();
      expect(api.ui).toBeDefined();
      expect(api.commands).toBeDefined();
      expect(api.events).toBeDefined();
      expect(api.settings).toBeDefined();
      expect(api.agents).toBeDefined();
      expect(api.hub).toBeDefined();
      expect(api.navigation).toBeDefined();
      expect(api.widgets).toBeDefined();
      expect(api.terminal).toBeDefined();
      expect(api.logging).toBeDefined();
      expect(api.context).toBeDefined();
    });
  });

  // ── Scope restrictions ────────────────────────────────────────────────

  describe('scope restrictions (project-scoped plugin)', () => {
    let api: PluginAPI;

    beforeEach(() => {
      api = createPluginAPI(makeCtx({ scope: 'project' }));
    });

    it('provides a working project API', () => {
      expect(api.project.projectPath).toBe('/projects/my-project');
      expect(api.project.projectId).toBe('proj-1');
    });

    it('provides a working git API', () => {
      expect(api.git).toBeDefined();
      expect(typeof api.git.status).toBe('function');
    });

    it('throws when accessing api.projects on project-scoped plugin', () => {
      expect(() => api.projects.list()).toThrow('not available for project-scoped');
    });
  });

  describe('scope restrictions (app-scoped plugin)', () => {
    let api: PluginAPI;

    beforeEach(() => {
      api = createPluginAPI(makeCtx({ scope: 'app', projectId: undefined, projectPath: undefined }));
    });

    it('provides a working projects API', () => {
      expect(typeof api.projects.list).toBe('function');
      expect(typeof api.projects.getActive).toBe('function');
    });

    it('throws when accessing api.project on app-scoped plugin', () => {
      expect(() => api.project.projectPath).toThrow('not available for app-scoped');
    });

    it('throws when accessing api.git on app-scoped plugin', () => {
      expect(() => api.git.status()).toThrow('not available for app-scoped');
    });
  });

  // ── ProjectAPI ────────────────────────────────────────────────────────

  describe('project API', () => {
    let api: PluginAPI;

    beforeEach(() => {
      api = createPluginAPI(makeCtx());
    });

    it('readFile calls window.clubhouse.file.read with full path', async () => {
      mockFile.read.mockResolvedValue('file content');
      const result = await api.project.readFile('src/main.ts');
      expect(mockFile.read).toHaveBeenCalledWith('/projects/my-project/src/main.ts');
      expect(result).toBe('file content');
    });

    it('writeFile calls window.clubhouse.file.write with full path', async () => {
      await api.project.writeFile('out.txt', 'hello');
      expect(mockFile.write).toHaveBeenCalledWith('/projects/my-project/out.txt', 'hello');
    });

    it('deleteFile calls window.clubhouse.file.delete with full path', async () => {
      await api.project.deleteFile('tmp.txt');
      expect(mockFile.delete).toHaveBeenCalledWith('/projects/my-project/tmp.txt');
    });

    it('fileExists returns true when read succeeds', async () => {
      mockFile.read.mockResolvedValue('data');
      expect(await api.project.fileExists('exists.txt')).toBe(true);
    });

    it('fileExists returns false when read throws', async () => {
      mockFile.read.mockRejectedValue(new Error('not found'));
      expect(await api.project.fileExists('nope.txt')).toBe(false);
    });

    it('listDirectory maps tree nodes to DirectoryEntry', async () => {
      mockFile.readTree.mockResolvedValue([
        { name: 'src', path: '/projects/my-project/src', isDirectory: true },
        { name: 'index.ts', path: '/projects/my-project/index.ts', isDirectory: false },
      ]);
      const entries = await api.project.listDirectory('.');
      expect(entries).toEqual([
        { name: 'src', path: '/projects/my-project/src', isDirectory: true },
        { name: 'index.ts', path: '/projects/my-project/index.ts', isDirectory: false },
      ]);
    });
  });

  // ── StorageAPI ────────────────────────────────────────────────────────

  describe('storage API', () => {
    let api: PluginAPI;

    beforeEach(() => {
      api = createPluginAPI(makeCtx());
    });

    it('project storage passes correct scope and projectPath', async () => {
      await api.storage.project.read('my-key');
      expect(mockPlugin.storageRead).toHaveBeenCalledWith({
        pluginId: 'test-plugin',
        scope: 'project',
        key: 'my-key',
        projectPath: '/projects/my-project',
      });
    });

    it('global storage passes correct scope without projectPath', async () => {
      await api.storage.global.write('key', { data: true });
      expect(mockPlugin.storageWrite).toHaveBeenCalledWith({
        pluginId: 'test-plugin',
        scope: 'global',
        key: 'key',
        value: { data: true },
        projectPath: undefined,
      });
    });

    it('project storage delete calls storageDelete', async () => {
      await api.storage.project.delete('old-key');
      expect(mockPlugin.storageDelete).toHaveBeenCalledWith(
        expect.objectContaining({ pluginId: 'test-plugin', key: 'old-key', scope: 'project' }),
      );
    });

    it('global storage list calls storageList', async () => {
      mockPlugin.storageList.mockResolvedValue(['a', 'b']);
      const keys = await api.storage.global.list();
      expect(keys).toEqual(['a', 'b']);
    });
  });

  // ── Storage API — projectLocal ─────────────────────────────────────────

  describe('storage API — projectLocal', () => {
    it('read passes scope project-local with projectPath', async () => {
      const api = createPluginAPI(makeCtx());
      await api.storage.projectLocal.read('my-key');
      expect(mockPlugin.storageRead).toHaveBeenCalledWith({
        pluginId: 'test-plugin',
        scope: 'project-local',
        key: 'my-key',
        projectPath: '/projects/my-project',
      });
    });

    it('write passes scope project-local with projectPath', async () => {
      const api = createPluginAPI(makeCtx());
      await api.storage.projectLocal.write('key', { data: true });
      expect(mockPlugin.storageWrite).toHaveBeenCalledWith({
        pluginId: 'test-plugin',
        scope: 'project-local',
        key: 'key',
        value: { data: true },
        projectPath: '/projects/my-project',
      });
    });

    it('delete passes scope project-local', async () => {
      const api = createPluginAPI(makeCtx());
      await api.storage.projectLocal.delete('old-key');
      expect(mockPlugin.storageDelete).toHaveBeenCalledWith(
        expect.objectContaining({ pluginId: 'test-plugin', key: 'old-key', scope: 'project-local' }),
      );
    });

    it('list passes scope project-local', async () => {
      mockPlugin.storageList.mockResolvedValue(['a', 'b']);
      const api = createPluginAPI(makeCtx());
      const keys = await api.storage.projectLocal.list();
      expect(keys).toEqual(['a', 'b']);
      expect(mockPlugin.storageList).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'project-local' }),
      );
    });

    it('projectLocal is distinct from project scope (separate IPC calls)', async () => {
      const api = createPluginAPI(makeCtx());
      await api.storage.project.read('k');
      await api.storage.projectLocal.read('k');
      expect(mockPlugin.storageRead).toHaveBeenCalledTimes(2);
      expect(mockPlugin.storageRead).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'project' }),
      );
      expect(mockPlugin.storageRead).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'project-local' }),
      );
    });

    it('app-scoped plugin passes undefined projectPath for projectLocal', async () => {
      const api = createPluginAPI(makeCtx({ scope: 'app', projectId: undefined, projectPath: undefined }));
      await api.storage.projectLocal.read('k');
      expect(mockPlugin.storageRead).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'project-local', projectPath: undefined }),
      );
    });
  });

  // ── CommandsAPI ───────────────────────────────────────────────────────

  describe('commands API', () => {
    let api: PluginAPI;

    beforeEach(() => {
      api = createPluginAPI(makeCtx());
    });

    it('register prefixes command id with pluginId', () => {
      const handler = vi.fn();
      api.commands.register('do-thing', handler);
      expect(pluginCommandRegistry.has('test-plugin:do-thing')).toBe(true);
    });

    it('execute resolves prefixed command', async () => {
      const handler = vi.fn();
      api.commands.register('do-thing', handler);
      await api.commands.execute('do-thing', 'arg');
      expect(handler).toHaveBeenCalledWith('arg');
    });

    it('execute falls back to raw command id if prefixed not found', async () => {
      const handler = vi.fn();
      pluginCommandRegistry.register('global.cmd', handler);
      await api.commands.execute('global.cmd', 42);
      expect(handler).toHaveBeenCalledWith(42);
    });

    it('register returns a disposable', () => {
      const d = api.commands.register('temp', vi.fn());
      expect(typeof d.dispose).toBe('function');
      d.dispose();
      expect(pluginCommandRegistry.has('test-plugin:temp')).toBe(false);
    });
  });

  // ── EventsAPI ─────────────────────────────────────────────────────────

  describe('events API', () => {
    it('on subscribes to pluginEventBus', () => {
      const api = createPluginAPI(makeCtx());
      const handler = vi.fn();
      api.events.on('agent:completed', handler);
      pluginEventBus.emit('agent:completed', { id: 'a1' });
      expect(handler).toHaveBeenCalledWith({ id: 'a1' });
    });

    it('on returns a disposable that unsubscribes', () => {
      const api = createPluginAPI(makeCtx());
      const handler = vi.fn();
      const d = api.events.on('test', handler);
      d.dispose();
      pluginEventBus.emit('test');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ── SettingsAPI ───────────────────────────────────────────────────────

  describe('settings API', () => {
    it('get returns setting value for project-scoped plugin', () => {
      usePluginStore.setState({
        pluginSettings: { 'proj-1:test-plugin': { theme: 'dark', size: 14 } },
      });
      const api = createPluginAPI(makeCtx());
      expect(api.settings.get('theme')).toBe('dark');
      expect(api.settings.get('size')).toBe(14);
    });

    it('get returns undefined for missing key', () => {
      const api = createPluginAPI(makeCtx());
      expect(api.settings.get('nonexistent')).toBeUndefined();
    });

    it('getAll returns all settings', () => {
      usePluginStore.setState({
        pluginSettings: { 'proj-1:test-plugin': { a: 1, b: 2 } },
      });
      const api = createPluginAPI(makeCtx());
      expect(api.settings.getAll()).toEqual({ a: 1, b: 2 });
    });

    it('getAll returns empty object when no settings exist', () => {
      const api = createPluginAPI(makeCtx());
      expect(api.settings.getAll()).toEqual({});
    });

    it('uses app: prefix for app-scoped plugins', () => {
      usePluginStore.setState({
        pluginSettings: { 'app:test-plugin': { mode: 'zen' } },
      });
      const api = createPluginAPI(makeCtx({ scope: 'app', projectId: undefined }));
      expect(api.settings.get('mode')).toBe('zen');
    });

    it('onChange returns a disposable', () => {
      const api = createPluginAPI(makeCtx());
      const cb = vi.fn();
      const d = api.settings.onChange(cb);
      expect(typeof d.dispose).toBe('function');
      d.dispose(); // Should not throw
    });
  });

  // ── UIAPI ─────────────────────────────────────────────────────────────

  describe('ui API', () => {
    let api: PluginAPI;

    beforeEach(() => {
      api = createPluginAPI(makeCtx());
    });

    it('showNotice logs to console', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      api.ui.showNotice('Hello');
      expect(spy).toHaveBeenCalledWith('[Plugin Notice] Hello');
      spy.mockRestore();
    });

    it('showError logs to console.error', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      api.ui.showError('Oops');
      expect(spy).toHaveBeenCalledWith('[Plugin Error] Oops');
      spy.mockRestore();
    });

    it('showConfirm delegates to window.confirm', async () => {
      (window as any).confirm = vi.fn(() => true);
      const result = await api.ui.showConfirm('Are you sure?');
      expect(result).toBe(true);
      expect((window as any).confirm).toHaveBeenCalledWith('Are you sure?');
    });

    it('showInput delegates to window.prompt', async () => {
      (window as any).prompt = vi.fn(() => 'user input');
      const result = await api.ui.showInput('Enter name:', 'default');
      expect(result).toBe('user input');
      expect((window as any).prompt).toHaveBeenCalledWith('Enter name:', 'default');
    });
  });

  // ── HubAPI ────────────────────────────────────────────────────────────

  describe('hub API', () => {
    it('refresh is callable without error', () => {
      const api = createPluginAPI(makeCtx());
      expect(() => api.hub.refresh()).not.toThrow();
    });
  });

  // ── Context ──────────────────────────────────────────────────────────

  describe('context', () => {
    it('reflects project mode for project-scoped plugin', () => {
      const api = createPluginAPI(makeCtx({ scope: 'project' }));
      expect(api.context.mode).toBe('project');
      expect(api.context.projectId).toBe('proj-1');
      expect(api.context.projectPath).toBe('/projects/my-project');
    });

    it('reflects app mode for app-scoped plugin', () => {
      const api = createPluginAPI(makeCtx({ scope: 'app', projectId: undefined, projectPath: undefined }));
      expect(api.context.mode).toBe('app');
      expect(api.context.projectId).toBeUndefined();
      expect(api.context.projectPath).toBeUndefined();
    });

    it('reflects explicit mode parameter', () => {
      const api = createPluginAPI(makeCtx({ scope: 'dual' }), 'app');
      expect(api.context.mode).toBe('app');
    });

    it('defaults to project mode for dual-scoped without explicit mode', () => {
      const api = createPluginAPI(makeCtx({ scope: 'dual' }));
      expect(api.context.mode).toBe('project');
    });

    it('preserves projectId/projectPath in context even for dual app mode', () => {
      const api = createPluginAPI(makeCtx({ scope: 'dual', projectId: 'proj-1', projectPath: '/p' }), 'app');
      expect(api.context.mode).toBe('app');
      expect(api.context.projectId).toBe('proj-1');
    });

    it('project-scoped plugin always gets project mode regardless of mode arg', () => {
      // mode param is ignored for single-scope plugins — they use scope-derived mode
      const api = createPluginAPI(makeCtx({ scope: 'project' }));
      expect(api.context.mode).toBe('project');
    });

    it('app-scoped plugin always gets app mode regardless of mode arg', () => {
      const api = createPluginAPI(makeCtx({ scope: 'app', projectId: undefined, projectPath: undefined }));
      expect(api.context.mode).toBe('app');
    });
  });

  // ── Dual scope ─────────────────────────────────────────────────────

  describe('dual-scoped plugin', () => {
    it('provides project API in project mode', () => {
      const api = createPluginAPI(makeCtx({ scope: 'dual' }), 'project');
      expect(api.project.projectPath).toBe('/projects/my-project');
      expect(api.project.projectId).toBe('proj-1');
    });

    it('throws when accessing project API in app mode', () => {
      const api = createPluginAPI(makeCtx({ scope: 'dual' }), 'app');
      expect(() => api.project.projectPath).toThrow('not available');
    });

    it('throws when accessing project.readFile in app mode', () => {
      const api = createPluginAPI(makeCtx({ scope: 'dual' }), 'app');
      expect(() => api.project.readFile('x')).toThrow('not available');
    });

    it('provides projects API in project mode', () => {
      const api = createPluginAPI(makeCtx({ scope: 'dual' }), 'project');
      expect(typeof api.projects.list).toBe('function');
    });

    it('provides projects API in app mode', () => {
      const api = createPluginAPI(makeCtx({ scope: 'dual' }), 'app');
      expect(typeof api.projects.list).toBe('function');
      expect(typeof api.projects.getActive).toBe('function');
    });

    it('provides git API in project mode', () => {
      const api = createPluginAPI(makeCtx({ scope: 'dual' }), 'project');
      expect(typeof api.git.status).toBe('function');
      expect(typeof api.git.log).toBe('function');
      expect(typeof api.git.currentBranch).toBe('function');
      expect(typeof api.git.diff).toBe('function');
    });

    it('throws when accessing git API in app mode', () => {
      const api = createPluginAPI(makeCtx({ scope: 'dual' }), 'app');
      expect(() => api.git.status()).toThrow('not available');
    });

    it('throws when accessing git.log in app mode', () => {
      const api = createPluginAPI(makeCtx({ scope: 'dual' }), 'app');
      expect(() => api.git.log()).toThrow('not available');
    });

    it('agents API works in both modes', () => {
      const projectApi = createPluginAPI(makeCtx({ scope: 'dual' }), 'project');
      const appApi = createPluginAPI(makeCtx({ scope: 'dual' }), 'app');
      expect(typeof projectApi.agents.list).toBe('function');
      expect(typeof appApi.agents.list).toBe('function');
    });

    it('navigation API works in both modes', () => {
      const projectApi = createPluginAPI(makeCtx({ scope: 'dual' }), 'project');
      const appApi = createPluginAPI(makeCtx({ scope: 'dual' }), 'app');
      expect(typeof projectApi.navigation.focusAgent).toBe('function');
      expect(typeof appApi.navigation.focusAgent).toBe('function');
    });

    it('storage API works in both modes', () => {
      const projectApi = createPluginAPI(makeCtx({ scope: 'dual' }), 'project');
      const appApi = createPluginAPI(makeCtx({ scope: 'dual' }), 'app');
      expect(typeof projectApi.storage.project.read).toBe('function');
      expect(typeof appApi.storage.global.read).toBe('function');
    });
  });

  // ── Dual-scope settings key resolution ─────────────────────────────

  describe('settings API (dual scope)', () => {
    it('uses projectId:pluginId key for dual scope with projectId', () => {
      usePluginStore.setState({
        pluginSettings: { 'proj-1:test-plugin': { key1: 'val1' } },
      });
      const api = createPluginAPI(makeCtx({ scope: 'dual' }), 'project');
      expect(api.settings.get('key1')).toBe('val1');
    });

    it('uses app:pluginId key for dual scope without projectId', () => {
      usePluginStore.setState({
        pluginSettings: { 'app:test-plugin': { key2: 'val2' } },
      });
      const api = createPluginAPI(makeCtx({ scope: 'dual', projectId: undefined }), 'app');
      expect(api.settings.get('key2')).toBe('val2');
    });

    it('settings getAll works for dual scope in project mode', () => {
      usePluginStore.setState({
        pluginSettings: { 'proj-1:test-plugin': { a: 1, b: 2 } },
      });
      const api = createPluginAPI(makeCtx({ scope: 'dual' }), 'project');
      expect(api.settings.getAll()).toEqual({ a: 1, b: 2 });
    });

    it('settings getAll returns empty for dual scope with no saved settings', () => {
      const api = createPluginAPI(makeCtx({ scope: 'dual' }), 'project');
      expect(api.settings.getAll()).toEqual({});
    });

    it('multiple onChange handlers can coexist and dispose independently', () => {
      const api = createPluginAPI(makeCtx());
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const d1 = api.settings.onChange(cb1);
      const d2 = api.settings.onChange(cb2);
      d1.dispose();
      // cb2's dispose should still work
      expect(() => d2.dispose()).not.toThrow();
    });
  });

  // ── NavigationAPI ───────────────────────────────────────────────────

  describe('navigation API', () => {
    it('focusAgent sets explorer tab to agents and active agent', () => {
      const api = createPluginAPI(makeCtx());
      api.navigation.focusAgent('agent-123');
      expect(useUIStore.getState().explorerTab).toBe('agents');
      expect(useAgentStore.getState().activeAgentId).toBe('agent-123');
    });

    it('focusAgent with non-existent agent still sets state', () => {
      const api = createPluginAPI(makeCtx());
      api.navigation.focusAgent('nonexistent-id');
      expect(useUIStore.getState().explorerTab).toBe('agents');
      expect(useAgentStore.getState().activeAgentId).toBe('nonexistent-id');
    });

    it('focusAgent overrides any previously set tab', () => {
      useUIStore.setState({ explorerTab: 'settings' });
      const api = createPluginAPI(makeCtx());
      api.navigation.focusAgent('a1');
      expect(useUIStore.getState().explorerTab).toBe('agents');
    });

    it('setExplorerTab sets the explorer tab', () => {
      const api = createPluginAPI(makeCtx());
      api.navigation.setExplorerTab('settings');
      expect(useUIStore.getState().explorerTab).toBe('settings');
    });

    it('setExplorerTab to plugin tab works', () => {
      const api = createPluginAPI(makeCtx());
      api.navigation.setExplorerTab('plugin:my-plugin');
      expect(useUIStore.getState().explorerTab).toBe('plugin:my-plugin');
    });

    it('calling focusAgent twice updates agent each time', () => {
      const api = createPluginAPI(makeCtx());
      api.navigation.focusAgent('a1');
      expect(useAgentStore.getState().activeAgentId).toBe('a1');
      api.navigation.focusAgent('a2');
      expect(useAgentStore.getState().activeAgentId).toBe('a2');
    });
  });

  // ── Widgets API ────────────────────────────────────────────────────

  describe('widgets API', () => {
    it('provides all four widget component types', () => {
      const api = createPluginAPI(makeCtx());
      expect(api.widgets.AgentTerminal).toBeDefined();
      expect(api.widgets.SleepingAgent).toBeDefined();
      expect(api.widgets.AgentAvatar).toBeDefined();
      expect(api.widgets.QuickAgentGhost).toBeDefined();
    });

    it('widget components are callable functions (stubs in test)', () => {
      const api = createPluginAPI(makeCtx());
      expect(typeof api.widgets.AgentTerminal).toBe('function');
      expect(typeof api.widgets.SleepingAgent).toBe('function');
      expect(typeof api.widgets.AgentAvatar).toBe('function');
      expect(typeof api.widgets.QuickAgentGhost).toBe('function');
    });

    it('widgets are cached across multiple createPluginAPI calls', () => {
      const api1 = createPluginAPI(makeCtx());
      const api2 = createPluginAPI(makeCtx());
      expect(api1.widgets.AgentTerminal).toBe(api2.widgets.AgentTerminal);
      expect(api1.widgets.SleepingAgent).toBe(api2.widgets.SleepingAgent);
    });

    it('widgets object is same reference across calls (cached)', () => {
      const api1 = createPluginAPI(makeCtx());
      const api2 = createPluginAPI(makeCtx());
      // Same cache object
      expect(api1.widgets).toBe(api2.widgets);
    });
  });

  // ── Enriched Agents API ──────────────────────────────────────────────

  describe('agents API (enriched)', () => {
    function seedAgents() {
      useAgentStore.setState({
        agents: {
          'agent-1': {
            id: 'agent-1',
            name: 'Alpha',
            kind: 'durable',
            status: 'running',
            color: 'emerald',
            emoji: '🦊',
            projectId: 'proj-1',
            branch: 'main',
            model: 'claude-3',
            parentAgentId: undefined,
          },
          'agent-2': {
            id: 'agent-2',
            name: 'Beta',
            kind: 'quick',
            status: 'sleeping',
            color: 'gray',
            projectId: 'proj-1',
            mission: 'fix bug',
            exitCode: 0,
            parentAgentId: 'agent-1',
          },
          'agent-3': {
            id: 'agent-3',
            name: 'Gamma',
            kind: 'quick',
            status: 'running',
            color: 'blue',
            projectId: 'proj-2',
            mission: 'other project',
          },
        } as any,
        agentDetailedStatus: {
          'agent-1': {
            state: 'working',
            message: 'Editing file',
            toolName: 'Edit',
            timestamp: Date.now(),
          },
        },
      });
    }

    beforeEach(seedAgents);

    // ── list() ─────────────────────────────────────────────────────────

    describe('list()', () => {
      it('returns enriched agent info with all fields', () => {
        const api = createPluginAPI(makeCtx());
        const agents = api.agents.list();
        const alpha = agents.find((a) => a.id === 'agent-1')!;
        expect(alpha).toEqual({
          id: 'agent-1',
          name: 'Alpha',
          kind: 'durable',
          status: 'running',
          color: 'emerald',
          emoji: '🦊',
          exitCode: undefined,
          mission: undefined,
          projectId: 'proj-1',
          branch: 'main',
          model: 'claude-3',
          parentAgentId: undefined,
        });
      });

      it('includes parentAgentId for child agents', () => {
        const api = createPluginAPI(makeCtx());
        const beta = api.agents.list().find((a) => a.id === 'agent-2')!;
        expect(beta.parentAgentId).toBe('agent-1');
      });

      it('filters agents by project context', () => {
        const api = createPluginAPI(makeCtx({ projectId: 'proj-1' }));
        const agents = api.agents.list();
        expect(agents.every((a) => a.projectId === 'proj-1')).toBe(true);
        expect(agents.find((a) => a.id === 'agent-3')).toBeUndefined();
      });

      it('lists all agents when no projectId in context', () => {
        const api = createPluginAPI(makeCtx({ scope: 'app', projectId: undefined, projectPath: undefined }));
        const agents = api.agents.list();
        expect(agents).toHaveLength(3);
      });

      it('returns empty array when no agents exist', () => {
        useAgentStore.setState({ agents: {} });
        const api = createPluginAPI(makeCtx());
        expect(api.agents.list()).toEqual([]);
      });
    });

    // ── kill() ──────────────────────────────────────────────────────────

    describe('kill()', () => {
      it('kills an agent by resolving its project path', async () => {
        const { useProjectStore } = await import('../stores/projectStore');
        useProjectStore.setState({
          projects: [{ id: 'proj-1', name: 'P1', path: '/projects/p1' }] as any,
        });
        const killSpy = vi.spyOn(useAgentStore.getState(), 'killAgent').mockResolvedValue();
        const api = createPluginAPI(makeCtx());
        await api.agents.kill('agent-1');
        expect(killSpy).toHaveBeenCalledWith('agent-1', '/projects/p1');
      });

      it('does nothing when agent does not exist', async () => {
        const killSpy = vi.spyOn(useAgentStore.getState(), 'killAgent');
        const api = createPluginAPI(makeCtx());
        await api.agents.kill('nonexistent');
        expect(killSpy).not.toHaveBeenCalled();
      });

      it('passes undefined projectPath when project not found', async () => {
        const { useProjectStore } = await import('../stores/projectStore');
        useProjectStore.setState({ projects: [] });
        const killSpy = vi.spyOn(useAgentStore.getState(), 'killAgent').mockResolvedValue();
        const api = createPluginAPI(makeCtx());
        await api.agents.kill('agent-1');
        expect(killSpy).toHaveBeenCalledWith('agent-1', undefined);
      });
    });

    // ── resume() ────────────────────────────────────────────────────────

    describe('resume()', () => {
      it('throws when agent does not exist', async () => {
        const api = createPluginAPI(makeCtx());
        await expect(api.agents.resume('nonexistent')).rejects.toThrow('Can only resume durable agents');
      });

      it('throws when agent is a quick agent', async () => {
        const api = createPluginAPI(makeCtx());
        await expect(api.agents.resume('agent-2')).rejects.toThrow('Can only resume durable agents');
      });

      it('throws when project not found for agent', async () => {
        const { useProjectStore } = await import('../stores/projectStore');
        useProjectStore.setState({ projects: [] });
        const api = createPluginAPI(makeCtx());
        await expect(api.agents.resume('agent-1')).rejects.toThrow('Project not found');
      });

      it('throws when durable config not found', async () => {
        const { useProjectStore } = await import('../stores/projectStore');
        useProjectStore.setState({
          projects: [{ id: 'proj-1', name: 'P1', path: '/projects/p1' }] as any,
        });
        mockAgent.listDurable.mockResolvedValue([]);
        const api = createPluginAPI(makeCtx());
        await expect(api.agents.resume('agent-1')).rejects.toThrow('Durable config not found');
      });

      it('calls spawnDurableAgent with correct config when found', async () => {
        const { useProjectStore } = await import('../stores/projectStore');
        useProjectStore.setState({
          projects: [{ id: 'proj-1', name: 'P1', path: '/projects/p1' }] as any,
        });
        const durableConfig = { id: 'agent-1', name: 'Alpha', color: 'emerald' };
        mockAgent.listDurable.mockResolvedValue([durableConfig]);
        const spawnSpy = vi.spyOn(useAgentStore.getState(), 'spawnDurableAgent').mockResolvedValue('agent-1');
        const api = createPluginAPI(makeCtx());
        await api.agents.resume('agent-1');
        expect(spawnSpy).toHaveBeenCalledWith('proj-1', '/projects/p1', durableConfig, true);
      });
    });

    // ── listCompleted() ─────────────────────────────────────────────────

    describe('listCompleted()', () => {
      it('returns completed agents for context project', () => {
        useQuickAgentStore.setState({
          completedAgents: {
            'proj-1': [
              {
                id: 'q-1', projectId: 'proj-1', name: 'Gamma',
                mission: 'task', summary: 'Done', filesModified: ['a.ts'],
                exitCode: 0, completedAt: 1000,
              },
            ],
          },
        });
        const api = createPluginAPI(makeCtx());
        const completed = api.agents.listCompleted();
        expect(completed).toHaveLength(1);
        expect(completed[0].name).toBe('Gamma');
        expect(completed[0].summary).toBe('Done');
        expect(completed[0].filesModified).toEqual(['a.ts']);
        expect(completed[0].completedAt).toBe(1000);
      });

      it('returns empty when no project context', () => {
        const api = createPluginAPI(makeCtx({ scope: 'app', projectId: undefined, projectPath: undefined }));
        expect(api.agents.listCompleted()).toEqual([]);
      });

      it('accepts explicit projectId to override context', () => {
        useQuickAgentStore.setState({
          completedAgents: {
            'proj-2': [
              {
                id: 'q-2', projectId: 'proj-2', name: 'Delta',
                mission: 'other', summary: null, filesModified: [],
                exitCode: 1, completedAt: 2000,
              },
            ],
          },
        });
        const api = createPluginAPI(makeCtx({ projectId: 'proj-1' }));
        const completed = api.agents.listCompleted('proj-2');
        expect(completed).toHaveLength(1);
        expect(completed[0].id).toBe('q-2');
      });

      it('returns empty for project with no completed agents', () => {
        useQuickAgentStore.setState({ completedAgents: {} });
        const api = createPluginAPI(makeCtx());
        expect(api.agents.listCompleted()).toEqual([]);
      });

      it('preserves parentAgentId in completed agents', () => {
        useQuickAgentStore.setState({
          completedAgents: {
            'proj-1': [
              {
                id: 'q-1', projectId: 'proj-1', name: 'Child',
                mission: 'task', summary: 'Done', filesModified: [],
                exitCode: 0, completedAt: 1000, parentAgentId: 'parent-1',
              },
            ],
          },
        });
        const api = createPluginAPI(makeCtx());
        expect(api.agents.listCompleted()[0].parentAgentId).toBe('parent-1');
      });

      it('returns multiple completed agents in order', () => {
        useQuickAgentStore.setState({
          completedAgents: {
            'proj-1': [
              { id: 'q-1', projectId: 'proj-1', name: 'A', mission: 'm', summary: null, filesModified: [], exitCode: 0, completedAt: 3000 },
              { id: 'q-2', projectId: 'proj-1', name: 'B', mission: 'm', summary: null, filesModified: [], exitCode: 0, completedAt: 2000 },
              { id: 'q-3', projectId: 'proj-1', name: 'C', mission: 'm', summary: null, filesModified: [], exitCode: 0, completedAt: 1000 },
            ],
          },
        });
        const api = createPluginAPI(makeCtx());
        const completed = api.agents.listCompleted();
        expect(completed).toHaveLength(3);
        expect(completed.map((c) => c.name)).toEqual(['A', 'B', 'C']);
      });
    });

    // ── dismissCompleted() ──────────────────────────────────────────────

    describe('dismissCompleted()', () => {
      it('delegates to quick agent store', () => {
        const spy = vi.spyOn(useQuickAgentStore.getState(), 'dismissCompleted');
        const api = createPluginAPI(makeCtx());
        api.agents.dismissCompleted('proj-1', 'q-1');
        expect(spy).toHaveBeenCalledWith('proj-1', 'q-1');
      });

      it('does not throw for non-existent agent', () => {
        const api = createPluginAPI(makeCtx());
        expect(() => api.agents.dismissCompleted('proj-1', 'nonexistent')).not.toThrow();
      });
    });

    // ── getDetailedStatus() ─────────────────────────────────────────────

    describe('getDetailedStatus()', () => {
      it('returns full status for agent with detailed status', () => {
        const api = createPluginAPI(makeCtx());
        const status = api.agents.getDetailedStatus('agent-1');
        expect(status).toEqual({
          state: 'working',
          message: 'Editing file',
          toolName: 'Edit',
        });
      });

      it('returns null for agent without detailed status', () => {
        const api = createPluginAPI(makeCtx());
        expect(api.agents.getDetailedStatus('agent-2')).toBeNull();
      });

      it('returns null for completely unknown agent', () => {
        const api = createPluginAPI(makeCtx());
        expect(api.agents.getDetailedStatus('nonexistent')).toBeNull();
      });

      it('omits timestamp from returned status (not in plugin type)', () => {
        const api = createPluginAPI(makeCtx());
        const status = api.agents.getDetailedStatus('agent-1');
        expect(status).not.toHaveProperty('timestamp');
      });

      it('returns status without toolName when none set', () => {
        useAgentStore.setState({
          agentDetailedStatus: {
            'agent-1': { state: 'idle', message: 'Thinking', timestamp: Date.now() },
          },
        });
        const api = createPluginAPI(makeCtx());
        const status = api.agents.getDetailedStatus('agent-1');
        expect(status!.toolName).toBeUndefined();
        expect(status!.state).toBe('idle');
      });

      it('returns needs_permission state', () => {
        useAgentStore.setState({
          agentDetailedStatus: {
            'agent-1': { state: 'needs_permission', message: 'Needs permission', toolName: 'Bash', timestamp: Date.now() },
          },
        });
        const api = createPluginAPI(makeCtx());
        const status = api.agents.getDetailedStatus('agent-1');
        expect(status!.state).toBe('needs_permission');
        expect(status!.toolName).toBe('Bash');
      });

      it('returns tool_error state', () => {
        useAgentStore.setState({
          agentDetailedStatus: {
            'agent-1': { state: 'tool_error', message: 'Edit failed', toolName: 'Edit', timestamp: Date.now() },
          },
        });
        const api = createPluginAPI(makeCtx());
        expect(api.agents.getDetailedStatus('agent-1')!.state).toBe('tool_error');
      });
    });

    // ── onStatusChange() ────────────────────────────────────────────────

    describe('onStatusChange()', () => {
      it('fires callback on agent status transition', () => {
        const api = createPluginAPI(makeCtx());
        const callback = vi.fn();
        api.agents.onStatusChange(callback);

        useAgentStore.setState({
          agents: {
            ...useAgentStore.getState().agents,
            'agent-1': { ...useAgentStore.getState().agents['agent-1'], status: 'sleeping' },
          },
        });

        expect(callback).toHaveBeenCalledWith('agent-1', 'sleeping', 'running');
      });

      it('fires for each agent that changes in a single update', () => {
        const api = createPluginAPI(makeCtx());
        const callback = vi.fn();
        api.agents.onStatusChange(callback);

        useAgentStore.setState({
          agents: {
            ...useAgentStore.getState().agents,
            'agent-1': { ...useAgentStore.getState().agents['agent-1'], status: 'sleeping' },
            'agent-3': { ...useAgentStore.getState().agents['agent-3'], status: 'error' },
          },
        });

        expect(callback).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenCalledWith('agent-1', 'sleeping', 'running');
        expect(callback).toHaveBeenCalledWith('agent-3', 'error', 'running');
      });

      it('does not fire for unchanged statuses', () => {
        const api = createPluginAPI(makeCtx());
        const callback = vi.fn();
        api.agents.onStatusChange(callback);

        useAgentStore.setState({ agents: useAgentStore.getState().agents });
        expect(callback).not.toHaveBeenCalled();
      });

      it('does not fire for new agents (no previous status)', () => {
        const api = createPluginAPI(makeCtx());
        const callback = vi.fn();
        api.agents.onStatusChange(callback);

        useAgentStore.setState({
          agents: {
            ...useAgentStore.getState().agents,
            'new-agent': {
              id: 'new-agent', name: 'New', kind: 'quick', status: 'running',
              color: 'blue', projectId: 'proj-1',
            } as any,
          },
        });

        expect(callback).not.toHaveBeenCalled();
      });

      it('fires for sequential status changes', () => {
        const api = createPluginAPI(makeCtx());
        const callback = vi.fn();
        api.agents.onStatusChange(callback);

        // running -> sleeping
        useAgentStore.setState({
          agents: {
            ...useAgentStore.getState().agents,
            'agent-1': { ...useAgentStore.getState().agents['agent-1'], status: 'sleeping' },
          },
        });
        expect(callback).toHaveBeenCalledWith('agent-1', 'sleeping', 'running');

        // sleeping -> error
        useAgentStore.setState({
          agents: {
            ...useAgentStore.getState().agents,
            'agent-1': { ...useAgentStore.getState().agents['agent-1'], status: 'error' },
          },
        });
        expect(callback).toHaveBeenCalledWith('agent-1', 'error', 'sleeping');
        expect(callback).toHaveBeenCalledTimes(2);
      });

      it('dispose prevents further callbacks', () => {
        const api = createPluginAPI(makeCtx());
        const callback = vi.fn();
        const disposable = api.agents.onStatusChange(callback);

        disposable.dispose();

        useAgentStore.setState({
          agents: {
            ...useAgentStore.getState().agents,
            'agent-1': { ...useAgentStore.getState().agents['agent-1'], status: 'sleeping' },
          },
        });

        expect(callback).not.toHaveBeenCalled();
      });

      it('returns a valid Disposable with dispose function', () => {
        const api = createPluginAPI(makeCtx());
        const disposable = api.agents.onStatusChange(() => {});
        expect(disposable).toHaveProperty('dispose');
        expect(typeof disposable.dispose).toBe('function');
      });

      it('double dispose does not throw', () => {
        const api = createPluginAPI(makeCtx());
        const disposable = api.agents.onStatusChange(() => {});
        disposable.dispose();
        expect(() => disposable.dispose()).not.toThrow();
      });

      it('multiple subscriptions fire independently', () => {
        const api = createPluginAPI(makeCtx());
        const cb1 = vi.fn();
        const cb2 = vi.fn();
        const d1 = api.agents.onStatusChange(cb1);
        api.agents.onStatusChange(cb2);

        useAgentStore.setState({
          agents: {
            ...useAgentStore.getState().agents,
            'agent-1': { ...useAgentStore.getState().agents['agent-1'], status: 'sleeping' },
          },
        });

        expect(cb1).toHaveBeenCalledTimes(1);
        expect(cb2).toHaveBeenCalledTimes(1);

        d1.dispose();

        useAgentStore.setState({
          agents: {
            ...useAgentStore.getState().agents,
            'agent-1': { ...useAgentStore.getState().agents['agent-1'], status: 'error' },
          },
        });

        expect(cb1).toHaveBeenCalledTimes(1); // Still 1, disposed
        expect(cb2).toHaveBeenCalledTimes(2); // Got the second change
      });
    });

    // ── getModelOptions() ────────────────────────────────────────────────

    describe('getModelOptions()', () => {
      it('returns 4 default options when no project context', async () => {
        const api = createPluginAPI(makeCtx({ scope: 'app', projectId: undefined, projectPath: undefined }));
        const options = await api.agents.getModelOptions();
        expect(options).toHaveLength(4);
        expect(options.map((o) => o.id)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
      });

      it('calls IPC with resolved project path', async () => {
        const { useProjectStore } = await import('../stores/projectStore');
        useProjectStore.setState({
          projects: [{ id: 'proj-1', name: 'P1', path: '/projects/p1' }] as any,
        });
        mockAgent.getModelOptions.mockResolvedValue([
          { id: 'custom', label: 'Custom' },
        ]);
        const api = createPluginAPI(makeCtx());
        const options = await api.agents.getModelOptions();
        expect(mockAgent.getModelOptions).toHaveBeenCalledWith('/projects/p1');
        expect(options).toEqual([{ id: 'custom', label: 'Custom' }]);
      });

      it('uses explicit projectId over context', async () => {
        const { useProjectStore } = await import('../stores/projectStore');
        useProjectStore.setState({
          projects: [
            { id: 'proj-1', name: 'P1', path: '/projects/p1' },
            { id: 'proj-2', name: 'P2', path: '/projects/p2' },
          ] as any,
        });
        mockAgent.getModelOptions.mockResolvedValue([{ id: 'x', label: 'X' }]);
        const api = createPluginAPI(makeCtx({ projectId: 'proj-1' }));
        await api.agents.getModelOptions('proj-2');
        expect(mockAgent.getModelOptions).toHaveBeenCalledWith('/projects/p2');
      });

      it('returns defaults on throw', async () => {
        const { useProjectStore } = await import('../stores/projectStore');
        useProjectStore.setState({
          projects: [{ id: 'proj-1', name: 'P1', path: '/projects/p1' }] as any,
        });
        mockAgent.getModelOptions.mockRejectedValue(new Error('fail'));
        const api = createPluginAPI(makeCtx());
        const options = await api.agents.getModelOptions();
        expect(options).toHaveLength(4);
        expect(options[0].id).toBe('default');
      });

      it('returns defaults on empty array', async () => {
        const { useProjectStore } = await import('../stores/projectStore');
        useProjectStore.setState({
          projects: [{ id: 'proj-1', name: 'P1', path: '/projects/p1' }] as any,
        });
        mockAgent.getModelOptions.mockResolvedValue([]);
        const api = createPluginAPI(makeCtx());
        const options = await api.agents.getModelOptions();
        expect(options).toHaveLength(4);
      });

      it('returns defaults on non-array', async () => {
        const { useProjectStore } = await import('../stores/projectStore');
        useProjectStore.setState({
          projects: [{ id: 'proj-1', name: 'P1', path: '/projects/p1' }] as any,
        });
        mockAgent.getModelOptions.mockResolvedValue('not an array');
        const api = createPluginAPI(makeCtx());
        const options = await api.agents.getModelOptions();
        expect(options).toHaveLength(4);
      });

      it('returns defaults when project not found', async () => {
        const { useProjectStore } = await import('../stores/projectStore');
        useProjectStore.setState({ projects: [] });
        const api = createPluginAPI(makeCtx());
        const options = await api.agents.getModelOptions();
        expect(options).toHaveLength(4);
      });
    });

    // ── onAnyChange() ─────────────────────────────────────────────────────

    describe('onAnyChange()', () => {
      it('fires on any store change (not just status)', () => {
        const api = createPluginAPI(makeCtx());
        const callback = vi.fn();
        api.agents.onAnyChange(callback);

        useAgentStore.setState({
          agents: {
            ...useAgentStore.getState().agents,
            'agent-1': { ...useAgentStore.getState().agents['agent-1'], name: 'Renamed' },
          },
        });

        expect(callback).toHaveBeenCalled();
      });

      it('fires on agent added', () => {
        const api = createPluginAPI(makeCtx());
        const callback = vi.fn();
        api.agents.onAnyChange(callback);

        useAgentStore.setState({
          agents: {
            ...useAgentStore.getState().agents,
            'new-agent': {
              id: 'new-agent', name: 'New', kind: 'quick', status: 'running',
              color: 'blue', projectId: 'proj-1',
            } as any,
          },
        });

        expect(callback).toHaveBeenCalled();
      });

      it('fires on agent removed', () => {
        const api = createPluginAPI(makeCtx());
        const callback = vi.fn();
        api.agents.onAnyChange(callback);

        const { 'agent-1': _, ...remaining } = useAgentStore.getState().agents;
        useAgentStore.setState({ agents: remaining });

        expect(callback).toHaveBeenCalled();
      });

      it('fires on detailedStatus change', () => {
        const api = createPluginAPI(makeCtx());
        const callback = vi.fn();
        api.agents.onAnyChange(callback);

        useAgentStore.setState({
          agentDetailedStatus: {
            'agent-1': { state: 'idle', message: 'Done', timestamp: Date.now() },
          },
        });

        expect(callback).toHaveBeenCalled();
      });

      it('dispose stops callbacks', () => {
        const api = createPluginAPI(makeCtx());
        const callback = vi.fn();
        const disposable = api.agents.onAnyChange(callback);
        disposable.dispose();

        useAgentStore.setState({
          agents: {
            ...useAgentStore.getState().agents,
            'agent-1': { ...useAgentStore.getState().agents['agent-1'], name: 'Changed' },
          },
        });

        expect(callback).not.toHaveBeenCalled();
      });

      it('double dispose is safe', () => {
        const api = createPluginAPI(makeCtx());
        const disposable = api.agents.onAnyChange(() => {});
        disposable.dispose();
        expect(() => disposable.dispose()).not.toThrow();
      });

      it('multiple independent subscriptions', () => {
        const api = createPluginAPI(makeCtx());
        const cb1 = vi.fn();
        const cb2 = vi.fn();
        const d1 = api.agents.onAnyChange(cb1);
        api.agents.onAnyChange(cb2);

        useAgentStore.setState({
          agents: {
            ...useAgentStore.getState().agents,
            'agent-1': { ...useAgentStore.getState().agents['agent-1'], name: 'X' },
          },
        });

        expect(cb1).toHaveBeenCalledTimes(1);
        expect(cb2).toHaveBeenCalledTimes(1);

        d1.dispose();

        useAgentStore.setState({
          agents: {
            ...useAgentStore.getState().agents,
            'agent-1': { ...useAgentStore.getState().agents['agent-1'], name: 'Y' },
          },
        });

        expect(cb1).toHaveBeenCalledTimes(1);
        expect(cb2).toHaveBeenCalledTimes(2);
      });
    });

    // ── Terminal API ─────────────────────────────────────────────────────

    describe('terminal API', () => {
      let api: PluginAPI;

      beforeEach(() => {
        mockPty.spawnShell.mockResolvedValue(undefined);
        mockPty.kill.mockResolvedValue(undefined);
        mockPty.getBuffer.mockResolvedValue('');
        mockPty.onData.mockReturnValue(() => {});
        mockPty.onExit.mockReturnValue(() => {});
        api = createPluginAPI(makeCtx());
      });

      // ── surface check ────────────────────────────────────────────────

      it('provides all terminal API methods', () => {
        expect(typeof api.terminal.spawn).toBe('function');
        expect(typeof api.terminal.write).toBe('function');
        expect(typeof api.terminal.resize).toBe('function');
        expect(typeof api.terminal.kill).toBe('function');
        expect(typeof api.terminal.getBuffer).toBe('function');
        expect(typeof api.terminal.onData).toBe('function');
        expect(typeof api.terminal.onExit).toBe('function');
        expect(typeof api.terminal.ShellTerminal).toBe('function');
      });

      it('terminal API is available for project-scoped plugins', () => {
        const projectApi = createPluginAPI(makeCtx({ scope: 'project' }));
        expect(typeof projectApi.terminal.spawn).toBe('function');
      });

      it('terminal API is available for app-scoped plugins', () => {
        const appApi = createPluginAPI(makeCtx({ scope: 'app', projectId: undefined, projectPath: undefined }));
        expect(typeof appApi.terminal.spawn).toBe('function');
      });

      it('terminal API is available for dual-scoped plugins in project mode', () => {
        const dualApi = createPluginAPI(makeCtx({ scope: 'dual' }), 'project');
        expect(typeof dualApi.terminal.spawn).toBe('function');
      });

      it('terminal API is available for dual-scoped plugins in app mode', () => {
        const dualApi = createPluginAPI(makeCtx({ scope: 'dual' }), 'app');
        expect(typeof dualApi.terminal.spawn).toBe('function');
      });

      // ── spawn() ──────────────────────────────────────────────────────

      describe('spawn()', () => {
        it('namespaces session ID with plugin prefix', async () => {
          await api.terminal.spawn('my-session');
          expect(mockPty.spawnShell).toHaveBeenCalledWith(
            'plugin:test-plugin:my-session',
            '/projects/my-project',
          );
        });

        it('uses explicit cwd when provided', async () => {
          await api.terminal.spawn('s1', '/custom/dir');
          expect(mockPty.spawnShell).toHaveBeenCalledWith(
            'plugin:test-plugin:s1',
            '/custom/dir',
          );
        });

        it('falls back to ctx.projectPath when cwd is omitted', async () => {
          await api.terminal.spawn('s1');
          expect(mockPty.spawnShell).toHaveBeenCalledWith(
            'plugin:test-plugin:s1',
            '/projects/my-project',
          );
        });

        it('explicit cwd overrides project context', async () => {
          await api.terminal.spawn('s1', '/override');
          expect(mockPty.spawnShell).toHaveBeenCalledWith(
            expect.any(String),
            '/override',
          );
        });

        it('throws without cwd and without project context', async () => {
          const appApi = createPluginAPI(makeCtx({ scope: 'app', projectPath: undefined, projectId: undefined }));
          await expect(appApi.terminal.spawn('s1')).rejects.toThrow('working directory');
        });

        it('app-scoped plugin can spawn with explicit cwd', async () => {
          const appApi = createPluginAPI(makeCtx({ scope: 'app', projectPath: undefined, projectId: undefined }));
          await appApi.terminal.spawn('s1', '/explicit/dir');
          expect(mockPty.spawnShell).toHaveBeenCalledWith(
            'plugin:test-plugin:s1',
            '/explicit/dir',
          );
        });

        it('returns a Promise<void>', async () => {
          const result = await api.terminal.spawn('s1');
          expect(result).toBeUndefined();
        });

        it('propagates PTY spawn errors', async () => {
          mockPty.spawnShell.mockRejectedValue(new Error('spawn failed'));
          await expect(api.terminal.spawn('s1')).rejects.toThrow('spawn failed');
        });

        it('can spawn multiple distinct sessions', async () => {
          await api.terminal.spawn('session-a');
          await api.terminal.spawn('session-b');
          expect(mockPty.spawnShell).toHaveBeenCalledTimes(2);
          expect(mockPty.spawnShell).toHaveBeenCalledWith('plugin:test-plugin:session-a', expect.any(String));
          expect(mockPty.spawnShell).toHaveBeenCalledWith('plugin:test-plugin:session-b', expect.any(String));
        });

        it('spawning same session ID twice calls PTY twice (API does not deduplicate)', async () => {
          await api.terminal.spawn('dup');
          await api.terminal.spawn('dup');
          expect(mockPty.spawnShell).toHaveBeenCalledTimes(2);
        });

        it('preserves special characters in session IDs', async () => {
          await api.terminal.spawn('session/with:special.chars');
          expect(mockPty.spawnShell).toHaveBeenCalledWith(
            'plugin:test-plugin:session/with:special.chars',
            expect.any(String),
          );
        });

        it('empty session ID is valid', async () => {
          await api.terminal.spawn('');
          expect(mockPty.spawnShell).toHaveBeenCalledWith('plugin:test-plugin:', expect.any(String));
        });
      });

      // ── write() ──────────────────────────────────────────────────────

      describe('write()', () => {
        it('namespaces session ID', () => {
          api.terminal.write('s1', 'hello');
          expect(mockPty.write).toHaveBeenCalledWith('plugin:test-plugin:s1', 'hello');
        });

        it('passes data through unmodified', () => {
          api.terminal.write('s1', '\x1b[31mred\x1b[0m');
          expect(mockPty.write).toHaveBeenCalledWith(expect.any(String), '\x1b[31mred\x1b[0m');
        });

        it('handles empty string data', () => {
          api.terminal.write('s1', '');
          expect(mockPty.write).toHaveBeenCalledWith('plugin:test-plugin:s1', '');
        });

        it('is synchronous (returns void)', () => {
          const result = api.terminal.write('s1', 'data');
          expect(result).toBeUndefined();
        });
      });

      // ── resize() ─────────────────────────────────────────────────────

      describe('resize()', () => {
        it('namespaces session ID', () => {
          api.terminal.resize('s1', 80, 24);
          expect(mockPty.resize).toHaveBeenCalledWith('plugin:test-plugin:s1', 80, 24);
        });

        it('passes cols and rows through', () => {
          api.terminal.resize('s1', 200, 50);
          expect(mockPty.resize).toHaveBeenCalledWith(expect.any(String), 200, 50);
        });

        it('is synchronous (returns void)', () => {
          const result = api.terminal.resize('s1', 80, 24);
          expect(result).toBeUndefined();
        });
      });

      // ── kill() ───────────────────────────────────────────────────────

      describe('kill()', () => {
        it('namespaces session ID', async () => {
          await api.terminal.kill('s1');
          expect(mockPty.kill).toHaveBeenCalledWith('plugin:test-plugin:s1');
        });

        it('returns a Promise<void>', async () => {
          const result = await api.terminal.kill('s1');
          expect(result).toBeUndefined();
        });

        it('propagates PTY kill errors', async () => {
          mockPty.kill.mockRejectedValue(new Error('kill failed'));
          await expect(api.terminal.kill('s1')).rejects.toThrow('kill failed');
        });

        it('killing unknown session does not throw (PTY manager handles gracefully)', async () => {
          // PTY manager's kill() is a no-op for unknown sessions
          await expect(api.terminal.kill('nonexistent')).resolves.toBeUndefined();
        });
      });

      // ── getBuffer() ──────────────────────────────────────────────────

      describe('getBuffer()', () => {
        it('namespaces session ID', async () => {
          await api.terminal.getBuffer('s1');
          expect(mockPty.getBuffer).toHaveBeenCalledWith('plugin:test-plugin:s1');
        });

        it('returns buffer content from PTY', async () => {
          mockPty.getBuffer.mockResolvedValue('$ ls\nREADME.md\n');
          const buf = await api.terminal.getBuffer('s1');
          expect(buf).toBe('$ ls\nREADME.md\n');
        });

        it('returns empty string for sessions with no output', async () => {
          mockPty.getBuffer.mockResolvedValue('');
          const buf = await api.terminal.getBuffer('s1');
          expect(buf).toBe('');
        });

        it('returns empty string for non-existent sessions', async () => {
          mockPty.getBuffer.mockResolvedValue('');
          const buf = await api.terminal.getBuffer('nonexistent');
          expect(buf).toBe('');
        });

        it('returns a Promise<string>', async () => {
          const result = api.terminal.getBuffer('s1');
          expect(result).toBeInstanceOf(Promise);
          expect(typeof (await result)).toBe('string');
        });
      });

      // ── onData() ─────────────────────────────────────────────────────

      describe('onData()', () => {
        it('returns a Disposable with dispose()', () => {
          const disposable = api.terminal.onData('s1', () => {});
          expect(typeof disposable.dispose).toBe('function');
        });

        it('registers a listener on the PTY bridge', () => {
          api.terminal.onData('s1', () => {});
          expect(mockPty.onData).toHaveBeenCalledTimes(1);
          expect(mockPty.onData).toHaveBeenCalledWith(expect.any(Function));
        });

        it('filters PTY data events by namespaced session ID', () => {
          let ptyCallback: (id: string, data: string) => void = () => {};
          mockPty.onData.mockImplementation((cb: (id: string, data: string) => void) => {
            ptyCallback = cb;
            return () => {};
          });

          const handler = vi.fn();
          api.terminal.onData('my-session', handler);

          // Data for our session — should fire
          ptyCallback('plugin:test-plugin:my-session', 'hello');
          expect(handler).toHaveBeenCalledWith('hello');

          // Data for a different session — should NOT fire
          ptyCallback('plugin:test-plugin:other-session', 'nope');
          expect(handler).toHaveBeenCalledTimes(1);

          // Data for a different plugin's session — should NOT fire
          ptyCallback('plugin:other-plugin:my-session', 'nope');
          expect(handler).toHaveBeenCalledTimes(1);

          // Data for a raw agent PTY — should NOT fire
          ptyCallback('agent-123', 'nope');
          expect(handler).toHaveBeenCalledTimes(1);
        });

        it('multiple onData calls register separate listeners', () => {
          api.terminal.onData('s1', () => {});
          api.terminal.onData('s2', () => {});
          expect(mockPty.onData).toHaveBeenCalledTimes(2);
        });

        it('dispose calls the PTY cleanup function', () => {
          const cleanup = vi.fn();
          mockPty.onData.mockReturnValue(cleanup);
          const disposable = api.terminal.onData('s1', () => {});
          disposable.dispose();
          expect(cleanup).toHaveBeenCalledTimes(1);
        });

        it('onData for same session with different callbacks both fire', () => {
          const callbacks: Array<(id: string, data: string) => void> = [];
          mockPty.onData.mockImplementation((cb: (id: string, data: string) => void) => {
            callbacks.push(cb);
            return () => {};
          });

          const handler1 = vi.fn();
          const handler2 = vi.fn();
          api.terminal.onData('s1', handler1);
          api.terminal.onData('s1', handler2);

          for (const cb of callbacks) {
            cb('plugin:test-plugin:s1', 'data');
          }
          expect(handler1).toHaveBeenCalledWith('data');
          expect(handler2).toHaveBeenCalledWith('data');
        });
      });

      // ── onExit() ─────────────────────────────────────────────────────

      describe('onExit()', () => {
        it('returns a Disposable with dispose()', () => {
          const disposable = api.terminal.onExit('s1', () => {});
          expect(typeof disposable.dispose).toBe('function');
        });

        it('registers a listener on the PTY bridge', () => {
          api.terminal.onExit('s1', () => {});
          expect(mockPty.onExit).toHaveBeenCalledTimes(1);
          expect(mockPty.onExit).toHaveBeenCalledWith(expect.any(Function));
        });

        it('filters PTY exit events by namespaced session ID', () => {
          let ptyCallback: (id: string, exitCode: number) => void = () => {};
          mockPty.onExit.mockImplementation((cb: (id: string, exitCode: number) => void) => {
            ptyCallback = cb;
            return () => {};
          });

          const handler = vi.fn();
          api.terminal.onExit('my-session', handler);

          // Exit for our session — should fire
          ptyCallback('plugin:test-plugin:my-session', 0);
          expect(handler).toHaveBeenCalledWith(0);

          // Exit for a different session — should NOT fire
          ptyCallback('plugin:test-plugin:other-session', 1);
          expect(handler).toHaveBeenCalledTimes(1);

          // Exit for a different plugin — should NOT fire
          ptyCallback('plugin:other-plugin:my-session', 1);
          expect(handler).toHaveBeenCalledTimes(1);
        });

        it('passes exit code through to callback', () => {
          let ptyCallback: (id: string, exitCode: number) => void = () => {};
          mockPty.onExit.mockImplementation((cb: (id: string, exitCode: number) => void) => {
            ptyCallback = cb;
            return () => {};
          });

          const handler = vi.fn();
          api.terminal.onExit('s1', handler);

          ptyCallback('plugin:test-plugin:s1', 137);
          expect(handler).toHaveBeenCalledWith(137);
        });

        it('dispose calls the PTY cleanup function', () => {
          const cleanup = vi.fn();
          mockPty.onExit.mockReturnValue(cleanup);
          const disposable = api.terminal.onExit('s1', () => {});
          disposable.dispose();
          expect(cleanup).toHaveBeenCalledTimes(1);
        });
      });

      // ── ShellTerminal widget ─────────────────────────────────────────

      describe('ShellTerminal widget', () => {
        it('is a function (React component)', () => {
          expect(typeof api.terminal.ShellTerminal).toBe('function');
        });

        it('each plugin gets its own ShellTerminal instance (not shared)', () => {
          const api2 = createPluginAPI(makeCtx({ pluginId: 'other-plugin' }));
          // They should be different closures (different namespace)
          expect(api.terminal.ShellTerminal).not.toBe(api2.terminal.ShellTerminal);
        });

        it('terminal API is a fresh instance per createPluginAPI call', () => {
          const api2 = createPluginAPI(makeCtx());
          expect(api.terminal).not.toBe(api2.terminal);
        });
      });

      // ── namespace isolation ──────────────────────────────────────────

      describe('namespace isolation', () => {
        it('different plugins get different namespaces', async () => {
          const api2 = createPluginAPI(makeCtx({ pluginId: 'other-plugin' }));
          await api.terminal.spawn('shared-name');
          await api2.terminal.spawn('shared-name');
          expect(mockPty.spawnShell).toHaveBeenCalledWith('plugin:test-plugin:shared-name', expect.any(String));
          expect(mockPty.spawnShell).toHaveBeenCalledWith('plugin:other-plugin:shared-name', expect.any(String));
        });

        it('plugin cannot write to another plugin session via write()', () => {
          api.terminal.write('s1', 'data');
          // Should be namespaced to this plugin — not a raw ID
          expect(mockPty.write).toHaveBeenCalledWith('plugin:test-plugin:s1', 'data');
          expect(mockPty.write).not.toHaveBeenCalledWith('s1', 'data');
        });

        it('plugin cannot kill another plugin session via kill()', async () => {
          await api.terminal.kill('s1');
          expect(mockPty.kill).toHaveBeenCalledWith('plugin:test-plugin:s1');
          expect(mockPty.kill).not.toHaveBeenCalledWith('s1');
        });

        it('plugin cannot read another plugin buffer via getBuffer()', async () => {
          await api.terminal.getBuffer('s1');
          expect(mockPty.getBuffer).toHaveBeenCalledWith('plugin:test-plugin:s1');
          expect(mockPty.getBuffer).not.toHaveBeenCalledWith('s1');
        });

        it('plugin cannot intercept agent PTY sessions', () => {
          let ptyCallback: (id: string, data: string) => void = () => {};
          mockPty.onData.mockImplementation((cb: (id: string, data: string) => void) => {
            ptyCallback = cb;
            return () => {};
          });

          const handler = vi.fn();
          api.terminal.onData('agent-123', handler);

          // Raw agent PTY data — should NOT match because namespace differs
          ptyCallback('agent-123', 'secret agent data');
          expect(handler).not.toHaveBeenCalled();

          // Only the namespaced version would match
          ptyCallback('plugin:test-plugin:agent-123', 'data');
          expect(handler).toHaveBeenCalledWith('data');
        });

        it('namespace format is plugin:{pluginId}:{sessionId}', async () => {
          await api.terminal.spawn('test-session');
          const calledWith = mockPty.spawnShell.mock.calls[0][0];
          expect(calledWith).toMatch(/^plugin:[^:]+:.+$/);
          expect(calledWith).toBe('plugin:test-plugin:test-session');
        });

        it('all methods use the same namespace for the same session', async () => {
          const expectedId = 'plugin:test-plugin:consistent';
          await api.terminal.spawn('consistent');
          api.terminal.write('consistent', 'x');
          api.terminal.resize('consistent', 80, 24);
          await api.terminal.kill('consistent');
          await api.terminal.getBuffer('consistent');

          expect(mockPty.spawnShell).toHaveBeenCalledWith(expectedId, expect.any(String));
          expect(mockPty.write).toHaveBeenCalledWith(expectedId, 'x');
          expect(mockPty.resize).toHaveBeenCalledWith(expectedId, 80, 24);
          expect(mockPty.kill).toHaveBeenCalledWith(expectedId);
          expect(mockPty.getBuffer).toHaveBeenCalledWith(expectedId);
        });
      });
    });

    // ── Logging API ─────────────────────────────────────────────────────

    describe('logging API', () => {
      it('provides all five log level methods', () => {
        const api = createPluginAPI(makeCtx());
        expect(typeof api.logging.debug).toBe('function');
        expect(typeof api.logging.info).toBe('function');
        expect(typeof api.logging.warn).toBe('function');
        expect(typeof api.logging.error).toBe('function');
        expect(typeof api.logging.fatal).toBe('function');
      });

      it('sends log entries with plugin namespace', () => {
        const api = createPluginAPI(makeCtx({ pluginId: 'my-plugin' }));
        api.logging.info('test message');

        expect(mockLog.write).toHaveBeenCalledTimes(1);
        const entry = mockLog.write.mock.calls[0][0];
        expect(entry.ns).toBe('plugin:my-plugin');
        expect(entry.level).toBe('info');
        expect(entry.msg).toBe('test message');
      });

      it('includes projectId from context', () => {
        const api = createPluginAPI(makeCtx({ pluginId: 'test-plugin', projectId: 'proj-1' }));
        api.logging.warn('warning');

        const entry = mockLog.write.mock.calls[0][0];
        expect(entry.projectId).toBe('proj-1');
      });

      it('passes meta through', () => {
        const api = createPluginAPI(makeCtx());
        api.logging.error('failed', { code: 500, source: 'api' });

        const entry = mockLog.write.mock.calls[0][0];
        expect(entry.meta).toEqual({ code: 500, source: 'api' });
      });

      it('each level method sends the correct level', () => {
        const api = createPluginAPI(makeCtx());
        const levels = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
        for (const level of levels) {
          mockLog.write.mockClear();
          api.logging[level](`msg-${level}`);
          expect(mockLog.write.mock.calls[0][0].level).toBe(level);
        }
      });

      it('different plugins get different namespaces', () => {
        const api1 = createPluginAPI(makeCtx({ pluginId: 'plugin-a' }));
        const api2 = createPluginAPI(makeCtx({ pluginId: 'plugin-b' }));

        api1.logging.info('from a');
        api2.logging.info('from b');

        expect(mockLog.write.mock.calls[0][0].ns).toBe('plugin:plugin-a');
        expect(mockLog.write.mock.calls[1][0].ns).toBe('plugin:plugin-b');
      });

      it('is available for all scopes', () => {
        const project = createPluginAPI(makeCtx({ scope: 'project' }));
        const app = createPluginAPI(makeCtx({ scope: 'app', projectId: undefined, projectPath: undefined }));
        const dual = createPluginAPI(makeCtx({ scope: 'dual' }), 'app');

        expect(typeof project.logging.info).toBe('function');
        expect(typeof app.logging.info).toBe('function');
        expect(typeof dual.logging.info).toBe('function');
      });

      it('is fire-and-forget (returns void)', () => {
        const api = createPluginAPI(makeCtx());
        expect(api.logging.info('test')).toBeUndefined();
      });
    });

    // ── runQuick() — projectId override ─────────────────────────────────

    describe('runQuick()', () => {
      it('uses context project when no override', async () => {
        const spawnSpy = vi.spyOn(useAgentStore.getState(), 'spawnQuickAgent').mockResolvedValue('qa-1');
        const api = createPluginAPI(makeCtx());
        await api.agents.runQuick('do stuff');
        expect(spawnSpy).toHaveBeenCalledWith('proj-1', '/projects/my-project', 'do stuff', undefined);
      });

      it('uses override projectId to resolve different project path', async () => {
        const { useProjectStore } = await import('../stores/projectStore');
        useProjectStore.setState({
          projects: [
            { id: 'proj-1', name: 'P1', path: '/projects/p1' },
            { id: 'proj-2', name: 'P2', path: '/projects/p2' },
          ] as any,
        });
        const spawnSpy = vi.spyOn(useAgentStore.getState(), 'spawnQuickAgent').mockResolvedValue('qa-2');
        const api = createPluginAPI(makeCtx({ projectId: 'proj-1', projectPath: '/projects/p1' }));
        await api.agents.runQuick('task', { projectId: 'proj-2' });
        expect(spawnSpy).toHaveBeenCalledWith('proj-2', '/projects/p2', 'task', undefined);
      });

      it('throws on unknown projectId', async () => {
        const { useProjectStore } = await import('../stores/projectStore');
        useProjectStore.setState({ projects: [] });
        const api = createPluginAPI(makeCtx());
        await expect(api.agents.runQuick('task', { projectId: 'nope' })).rejects.toThrow('Project not found');
      });

      it('throws without project context', async () => {
        const api = createPluginAPI(makeCtx({ scope: 'app', projectId: undefined, projectPath: undefined }));
        await expect(api.agents.runQuick('task')).rejects.toThrow('runQuick requires a project context');
      });

      it('passes model option through', async () => {
        const spawnSpy = vi.spyOn(useAgentStore.getState(), 'spawnQuickAgent').mockResolvedValue('qa-3');
        const api = createPluginAPI(makeCtx());
        await api.agents.runQuick('task', { model: 'opus' });
        expect(spawnSpy).toHaveBeenCalledWith('proj-1', '/projects/my-project', 'task', 'opus');
      });
    });
  });
});
