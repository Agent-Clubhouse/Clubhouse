import React from 'react';
import type { PluginContext, PluginAPI } from '../../shared/plugin-types';

export function createMockContext(overrides?: Partial<PluginContext>): PluginContext {
  return {
    pluginId: 'test-plugin',
    pluginPath: '/tmp/test-plugin',
    scope: 'project',
    projectId: 'test-project',
    projectPath: '/tmp/test-project',
    subscriptions: [],
    settings: {},
    ...overrides,
  };
}

function noop(): void {}
async function asyncNoop(): Promise<void> {}
async function asyncNull(): Promise<null> { return null; }

export function createMockAPI(overrides?: Partial<PluginAPI>): PluginAPI {
  return {
    project: {
      projectPath: '/tmp/test-project',
      projectId: 'test-project',
      readFile: async () => '',
      writeFile: asyncNoop,
      deleteFile: asyncNoop,
      fileExists: async () => false,
      listDirectory: async () => [],
    },
    projects: {
      list: () => [],
      getActive: () => null,
    },
    git: {
      status: async () => [],
      log: async () => [],
      currentBranch: async () => 'main',
      diff: async () => '',
    },
    storage: {
      project: {
        read: async () => undefined,
        write: asyncNoop,
        delete: asyncNoop,
        list: async () => [],
      },
      projectLocal: {
        read: async () => undefined,
        write: asyncNoop,
        delete: asyncNoop,
        list: async () => [],
      },
      global: {
        read: async () => undefined,
        write: asyncNoop,
        delete: asyncNoop,
        list: async () => [],
      },
    },
    ui: {
      showNotice: noop,
      showError: noop,
      showConfirm: async () => false,
      showInput: asyncNull,
    },
    commands: {
      register: () => ({ dispose: noop }),
      execute: asyncNoop,
    },
    events: {
      on: () => ({ dispose: noop }),
    },
    settings: {
      get: (): undefined => undefined,
      getAll: () => ({}),
      onChange: () => ({ dispose: noop }),
    },
    agents: {
      list: () => [],
      runQuick: async () => '',
      kill: asyncNoop,
      resume: asyncNoop,
      listCompleted: () => [],
      dismissCompleted: noop,
      getDetailedStatus: () => null,
      getModelOptions: async () => [{ id: 'default', label: 'Default' }],
      onStatusChange: () => ({ dispose: noop }),
      onAnyChange: () => ({ dispose: noop }),
    },
    hub: {
      refresh: noop,
    },
    navigation: {
      focusAgent: noop,
      setExplorerTab: noop,
    },
    widgets: {
      AgentTerminal: noop as unknown as PluginAPI['widgets']['AgentTerminal'],
      SleepingAgent: noop as unknown as PluginAPI['widgets']['SleepingAgent'],
      AgentAvatar: noop as unknown as PluginAPI['widgets']['AgentAvatar'],
      QuickAgentGhost: noop as unknown as PluginAPI['widgets']['QuickAgentGhost'],
    },
    terminal: {
      spawn: asyncNoop,
      write: noop,
      resize: noop,
      kill: asyncNoop,
      getBuffer: async () => '',
      onData: () => ({ dispose: noop }),
      onExit: () => ({ dispose: noop }),
      ShellTerminal: noop as unknown as PluginAPI['terminal']['ShellTerminal'],
    },
    logging: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      fatal: noop,
    },
    context: {
      mode: 'project',
      projectId: 'test-project',
      projectPath: '/tmp/test-project',
    },
    ...overrides,
  };
}
