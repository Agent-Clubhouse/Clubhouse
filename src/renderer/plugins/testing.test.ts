import { describe, it, expect } from 'vitest';
import { createMockContext, createMockAPI } from './testing';
import type { PluginContext, PluginAPI } from '../../shared/plugin-types';

describe('testing utilities', () => {
  describe('createMockContext', () => {
    it('returns a valid PluginContext with defaults', () => {
      const ctx = createMockContext();
      expect(ctx.pluginId).toBe('test-plugin');
      expect(ctx.pluginPath).toBe('/tmp/test-plugin');
      expect(ctx.scope).toBe('project');
      expect(ctx.projectId).toBe('test-project');
      expect(ctx.projectPath).toBe('/tmp/test-project');
      expect(ctx.subscriptions).toEqual([]);
      expect(ctx.settings).toEqual({});
    });

    it('allows overriding individual fields', () => {
      const ctx = createMockContext({
        pluginId: 'custom-id',
        scope: 'app',
        projectId: undefined,
      });
      expect(ctx.pluginId).toBe('custom-id');
      expect(ctx.scope).toBe('app');
      expect(ctx.projectId).toBeUndefined();
      // Non-overridden fields keep defaults
      expect(ctx.pluginPath).toBe('/tmp/test-plugin');
    });

    it('subscriptions array is a fresh instance per call', () => {
      const a = createMockContext();
      const b = createMockContext();
      expect(a.subscriptions).not.toBe(b.subscriptions);
    });

    it('settings object is a fresh instance per call', () => {
      const a = createMockContext();
      const b = createMockContext();
      expect(a.settings).not.toBe(b.settings);
    });
  });

  describe('createMockAPI', () => {
    it('returns an object with all PluginAPI namespaces', () => {
      const api = createMockAPI();
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
      expect(api.context).toBeDefined();
    });

    it('project API methods return safe defaults', async () => {
      const api = createMockAPI();
      expect(await api.project.readFile('x')).toBe('');
      expect(await api.project.fileExists('x')).toBe(false);
      expect(await api.project.listDirectory()).toEqual([]);
      // write and delete should resolve without error
      await expect(api.project.writeFile('x', 'y')).resolves.toBeUndefined();
      await expect(api.project.deleteFile('x')).resolves.toBeUndefined();
    });

    it('projects API methods return safe defaults', () => {
      const api = createMockAPI();
      expect(api.projects.list()).toEqual([]);
      expect(api.projects.getActive()).toBeNull();
    });

    it('git API methods return safe defaults', async () => {
      const api = createMockAPI();
      expect(await api.git.status()).toEqual([]);
      expect(await api.git.log()).toEqual([]);
      expect(await api.git.currentBranch()).toBe('main');
      expect(await api.git.diff('file.ts')).toBe('');
    });

    it('storage API methods return safe defaults', async () => {
      const api = createMockAPI();
      expect(await api.storage.project.read('k')).toBeUndefined();
      expect(await api.storage.global.list()).toEqual([]);
      await expect(api.storage.project.write('k', 'v')).resolves.toBeUndefined();
      await expect(api.storage.global.delete('k')).resolves.toBeUndefined();
    });

    it('ui methods are callable without error', async () => {
      const api = createMockAPI();
      expect(() => api.ui.showNotice('hi')).not.toThrow();
      expect(() => api.ui.showError('err')).not.toThrow();
      expect(await api.ui.showConfirm('ok?')).toBe(false);
      expect(await api.ui.showInput('name?')).toBeNull();
    });

    it('commands register returns a disposable', () => {
      const api = createMockAPI();
      const d = api.commands.register('cmd', () => {});
      expect(typeof d.dispose).toBe('function');
      expect(() => d.dispose()).not.toThrow();
    });

    it('events on returns a disposable', () => {
      const api = createMockAPI();
      const d = api.events.on('ev', () => {});
      expect(typeof d.dispose).toBe('function');
      expect(() => d.dispose()).not.toThrow();
    });

    it('settings methods return safe defaults', () => {
      const api = createMockAPI();
      expect(api.settings.get('key')).toBeUndefined();
      expect(api.settings.getAll()).toEqual({});
      const d = api.settings.onChange(() => {});
      expect(typeof d.dispose).toBe('function');
    });

    it('agents API returns safe defaults', async () => {
      const api = createMockAPI();
      expect(api.agents.list()).toEqual([]);
      expect(await api.agents.runQuick('do stuff')).toBe('');
    });

    it('allows overriding specific namespaces', () => {
      const customProject = {
        projectPath: '/custom',
        projectId: 'custom-id',
        readFile: async () => 'custom content',
        writeFile: async () => {},
        deleteFile: async () => {},
        fileExists: async () => true,
        listDirectory: async () => [],
      };
      const api = createMockAPI({ project: customProject });
      expect(api.project.projectPath).toBe('/custom');
      // Other namespaces still have defaults
      expect(api.projects.list()).toEqual([]);
    });

    it('hub namespace exists', () => {
      const api = createMockAPI();
      expect(api.hub).toBeDefined();
    });

    it('navigation API methods are callable', () => {
      const api = createMockAPI();
      expect(() => api.navigation.focusAgent('a1')).not.toThrow();
      expect(() => api.navigation.setExplorerTab('agents')).not.toThrow();
    });

    it('widgets API provides component types', () => {
      const api = createMockAPI();
      expect(api.widgets.AgentTerminal).toBeDefined();
      expect(api.widgets.SleepingAgent).toBeDefined();
      expect(api.widgets.AgentAvatar).toBeDefined();
      expect(api.widgets.QuickAgentGhost).toBeDefined();
    });

    it('context has expected defaults', () => {
      const api = createMockAPI();
      expect(api.context.mode).toBe('project');
      expect(api.context.projectId).toBe('test-project');
      expect(api.context.projectPath).toBe('/tmp/test-project');
    });

    it('enriched agents API methods return safe defaults', async () => {
      const api = createMockAPI();
      expect(api.agents.listCompleted()).toEqual([]);
      expect(api.agents.getDetailedStatus('x')).toBeNull();
      await expect(api.agents.kill('x')).resolves.toBeUndefined();
      await expect(api.agents.resume('x')).resolves.toBeUndefined();
      expect(() => api.agents.dismissCompleted('p', 'a')).not.toThrow();
      const d = api.agents.onStatusChange(() => {});
      expect(typeof d.dispose).toBe('function');
    });

    it('storage.projectLocal methods return safe defaults', async () => {
      const api = createMockAPI();
      expect(await api.storage.projectLocal.read('k')).toBeUndefined();
      expect(await api.storage.projectLocal.list()).toEqual([]);
      await expect(api.storage.projectLocal.write('k', 'v')).resolves.toBeUndefined();
      await expect(api.storage.projectLocal.delete('k')).resolves.toBeUndefined();
    });

    it('agents.getModelOptions returns default ModelOption', async () => {
      const api = createMockAPI();
      const options = await api.agents.getModelOptions();
      expect(options).toEqual([{ id: 'default', label: 'Default' }]);
    });

    it('agents.onAnyChange returns disposable', () => {
      const api = createMockAPI();
      const d = api.agents.onAnyChange(() => {});
      expect(typeof d.dispose).toBe('function');
      expect(() => d.dispose()).not.toThrow();
    });

    it('agents.runQuick accepts projectId option', async () => {
      const api = createMockAPI();
      const result = await api.agents.runQuick('task', { projectId: 'proj-2' });
      expect(result).toBe('');
    });
  });
});
