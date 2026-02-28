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
      openExternalUrl: asyncNoop,
    },
    commands: {
      register: () => ({ dispose: noop }),
      execute: asyncNoop,
      registerWithHotkey: () => ({ dispose: noop }),
      getBinding: () => null,
      clearBinding: noop,
    },
    events: {
      on: () => ({ dispose: noop }),
    },
    settings: {
      get: (): undefined => undefined,
      getAll: () => ({}),
      set: noop,
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
      listOrchestrators: () => [],
      checkOrchestratorAvailability: async () => ({ available: false }),
      onStatusChange: () => ({ dispose: noop }),
      onAnyChange: () => ({ dispose: noop }),
    },
    hub: {},
    navigation: {
      focusAgent: noop,
      setExplorerTab: noop,
      popOutAgent: asyncNoop,
      toggleSidebar: noop,
      toggleAccessoryPanel: noop,
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
    files: {
      readTree: async () => [],
      readFile: async () => '',
      readBinary: async () => '',
      writeFile: asyncNoop,
      stat: async () => ({ size: 0, isDirectory: false, isFile: true, modifiedAt: 0 }),
      rename: asyncNoop,
      copy: asyncNoop,
      mkdir: asyncNoop,
      delete: asyncNoop,
      showInFolder: asyncNoop,
      forRoot: () => { throw new Error('forRoot not available in test stub'); },
    },
    process: {
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    badges: {
      set: noop,
      clear: noop,
      clearAll: noop,
    },
    agentConfig: {
      injectSkill: asyncNoop,
      removeSkill: asyncNoop,
      listInjectedSkills: async () => [],
      injectAgentTemplate: asyncNoop,
      removeAgentTemplate: asyncNoop,
      listInjectedAgentTemplates: async () => [],
      appendInstructions: asyncNoop,
      removeInstructionAppend: asyncNoop,
      getInstructionAppend: asyncNull,
      addPermissionAllowRules: asyncNoop,
      addPermissionDenyRules: asyncNoop,
      removePermissionRules: asyncNoop,
      getPermissionRules: async () => ({ allow: [], deny: [] }),
      injectMcpServers: asyncNoop,
      removeMcpServers: asyncNoop,
      getInjectedMcpServers: async () => ({}),
    },
    sounds: {
      registerPack: asyncNoop,
      unregisterPack: asyncNoop,
      listPacks: async () => [],
    },
    theme: {
      getCurrent: () => ({
        id: 'catppuccin-mocha',
        name: 'Catppuccin Mocha',
        type: 'dark' as const,
        colors: { base: '#1e1e2e', mantle: '#181825', crust: '#11111b', text: '#cdd6f4', subtext0: '#a6adc8', subtext1: '#bac2de', surface0: '#313244', surface1: '#45475a', surface2: '#585b70', accent: '#89b4fa', link: '#89b4fa', warning: '#f9e2af', error: '#f38ba8', info: '#89dceb', success: '#a6e3a1' },
        hljs: { keyword: '#cba6f7', string: '#a6e3a1', number: '#fab387', comment: '#6c7086', function: '#89b4fa', type: '#f9e2af', variable: '#cdd6f4', regexp: '#f5c2e7', tag: '#89b4fa', attribute: '#a6e3a1', symbol: '#f2cdcd', meta: '#f5c2e7', addition: '#a6e3a1', deletion: '#f38ba8', property: '#89dceb', punctuation: '#bac2de' },
        terminal: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e', selectionBackground: '#585b70', selectionForeground: '#cdd6f4', black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de', brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8' },
      }),
      onDidChange: () => ({ dispose: noop }),
      getColor: () => null,
    },
    context: {
      mode: 'project',
      projectId: 'test-project',
      projectPath: '/tmp/test-project',
    },
    ...overrides,
  };
}
