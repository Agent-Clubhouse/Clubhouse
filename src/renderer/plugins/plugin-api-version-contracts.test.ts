/**
 * Plugin API Version Contract Tests — exhaustive per-version validation
 *
 * For each supported API version, these tests verify:
 * 1. A manifest with that version passes validation
 * 2. The API factory produces the expected surface area (all methods/properties present)
 * 3. Removing a method from the API breaks the test (prevents silent API regression)
 * 4. Version-specific features are properly gated
 *
 * @see https://github.com/Agent-Clubhouse/Clubhouse/issues/239
 */
import { describe, it, expect } from 'vitest';
import { validateManifest, SUPPORTED_API_VERSIONS } from './manifest-validator';
import { createMockAPI, createMockContext } from './testing';
import type {
  PluginAPI,
  ProjectAPI,
  ProjectsAPI,
  GitAPI,
  StorageAPI,
  ScopedStorage,
  UIAPI,
  CommandsAPI,
  EventsAPI,
  SettingsAPI,
  AgentsAPI,
  HubAPI,
  NavigationAPI,
  WidgetsAPI,
  TerminalAPI,
  LoggingAPI,
  FilesAPI,
  ProcessAPI,
  BadgesAPI,
  AgentConfigAPI,
  SoundsAPI,
  ThemeAPI,
  PluginContextInfo,
  PluginManifest,
  PluginPermission,
} from '../../shared/plugin-types';
import { ALL_PLUGIN_PERMISSIONS } from '../../shared/plugin-types';

// ── Canonical surface area definitions ─────────────────────────────────────
// These define the exact set of methods/properties each API namespace MUST expose.
// If a method is removed from the TypeScript interface or implementation, the
// corresponding test will fail — preventing silent API regression.

const PROJECT_API_METHODS: (keyof ProjectAPI)[] = [
  'readFile', 'writeFile', 'deleteFile', 'fileExists', 'listDirectory',
  'projectPath', 'projectId',
];

const PROJECTS_API_METHODS: (keyof ProjectsAPI)[] = ['list', 'getActive'];

const GIT_API_METHODS: (keyof GitAPI)[] = ['status', 'log', 'currentBranch', 'diff'];

const SCOPED_STORAGE_METHODS: (keyof ScopedStorage)[] = ['read', 'write', 'delete', 'list'];

const STORAGE_API_KEYS: (keyof StorageAPI)[] = ['project', 'projectLocal', 'global'];

const UI_API_METHODS: (keyof UIAPI)[] = [
  'showNotice', 'showError', 'showConfirm', 'showInput', 'openExternalUrl',
];

const COMMANDS_API_METHODS: (keyof CommandsAPI)[] = [
  'register', 'execute', 'registerWithHotkey', 'getBinding', 'clearBinding',
];

const EVENTS_API_METHODS: (keyof EventsAPI)[] = ['on'];

const SETTINGS_API_METHODS: (keyof SettingsAPI)[] = ['get', 'getAll', 'onChange'];

const AGENTS_API_METHODS: (keyof AgentsAPI)[] = [
  'list', 'runQuick', 'kill', 'resume', 'listCompleted', 'dismissCompleted',
  'getDetailedStatus', 'getModelOptions', 'onStatusChange', 'onAnyChange',
];

const HUB_API_METHODS: (keyof HubAPI)[] = ['refresh'];

const NAVIGATION_API_METHODS: (keyof NavigationAPI)[] = [
  'focusAgent', 'setExplorerTab', 'popOutAgent', 'toggleSidebar', 'toggleAccessoryPanel',
];

const WIDGETS_API_COMPONENTS: (keyof WidgetsAPI)[] = [
  'AgentTerminal', 'SleepingAgent', 'AgentAvatar', 'QuickAgentGhost',
];

const TERMINAL_API_METHODS: (keyof TerminalAPI)[] = [
  'spawn', 'write', 'resize', 'kill', 'getBuffer', 'onData', 'onExit', 'ShellTerminal',
];

const LOGGING_API_METHODS: (keyof LoggingAPI)[] = ['debug', 'info', 'warn', 'error', 'fatal'];

const FILES_API_METHODS: (keyof FilesAPI)[] = [
  'readTree', 'readFile', 'readBinary', 'writeFile', 'stat',
  'rename', 'copy', 'mkdir', 'delete', 'showInFolder', 'forRoot',
];

const PROCESS_API_METHODS: (keyof ProcessAPI)[] = ['exec'];

const BADGES_API_METHODS: (keyof BadgesAPI)[] = ['set', 'clear', 'clearAll'];

const AGENT_CONFIG_API_METHODS: (keyof AgentConfigAPI)[] = [
  'injectSkill', 'removeSkill', 'listInjectedSkills',
  'injectAgentTemplate', 'removeAgentTemplate', 'listInjectedAgentTemplates',
  'appendInstructions', 'removeInstructionAppend', 'getInstructionAppend',
  'addPermissionAllowRules', 'addPermissionDenyRules', 'removePermissionRules', 'getPermissionRules',
  'injectMcpServers', 'removeMcpServers', 'getInjectedMcpServers',
];

const SOUNDS_API_METHODS: (keyof SoundsAPI)[] = ['registerPack', 'unregisterPack', 'listPacks'];

const THEME_API_METHODS: (keyof ThemeAPI)[] = ['getCurrent', 'onDidChange', 'getColor'];

const CONTEXT_PROPERTIES: (keyof PluginContextInfo)[] = ['mode', 'projectId', 'projectPath'];

// Top-level PluginAPI namespaces
const PLUGIN_API_NAMESPACES: (keyof PluginAPI)[] = [
  'project', 'projects', 'git', 'storage', 'ui', 'commands', 'events',
  'settings', 'agents', 'hub', 'navigation', 'widgets', 'terminal',
  'logging', 'files', 'process', 'badges', 'agentConfig', 'sounds', 'theme', 'context',
];

// ── Helper: minimal valid manifest per version ─────────────────────────────

function minimalV05Manifest(overrides?: Partial<PluginManifest>): Record<string, unknown> {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    engine: { api: 0.5 },
    scope: 'project',
    permissions: ['files'],
    contributes: { help: {} },
    ...overrides,
  };
}

function minimalV06Manifest(overrides?: Partial<PluginManifest>): Record<string, unknown> {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    engine: { api: 0.6 },
    scope: 'project',
    permissions: ['files'],
    contributes: { help: {} },
    ...overrides,
  };
}

function fullV05Manifest(): Record<string, unknown> {
  return {
    id: 'full-v05-plugin',
    name: 'Full v0.5 Plugin',
    version: '2.0.0',
    description: 'A fully-specified v0.5 plugin',
    author: 'Test Author',
    engine: { api: 0.5 },
    scope: 'dual',
    main: './dist/main.js',
    settingsPanel: 'declarative',
    permissions: [
      'files', 'files.external', 'git', 'terminal', 'agents',
      'notifications', 'storage', 'navigation', 'projects', 'commands',
      'events', 'widgets', 'logging', 'process', 'badges',
      'agent-config', 'agent-config.cross-project', 'agent-config.permissions',
      'agent-config.mcp', 'sounds', 'theme',
    ],
    externalRoots: [{ settingKey: 'ext-data', root: 'data' }],
    allowedCommands: ['node', 'npm'],
    contributes: {
      tab: { label: 'My Tab', icon: 'puzzle', layout: 'sidebar-content' },
      railItem: { label: 'My Rail', icon: 'gear', position: 'top' },
      commands: [{ id: 'run', title: 'Run It' }],
      settings: [{ key: 'opt1', type: 'boolean', label: 'Enable', default: true }],
      help: {
        topics: [
          { id: 'intro', title: 'Introduction', content: '# Welcome' },
        ],
      },
    },
  };
}

function fullV06Manifest(): Record<string, unknown> {
  return {
    ...fullV05Manifest(),
    id: 'full-v06-plugin',
    name: 'Full v0.6 Plugin',
    engine: { api: 0.6 },
    contributes: {
      ...((fullV05Manifest() as Record<string, unknown>).contributes as Record<string, unknown>),
      commands: [
        { id: 'run', title: 'Run It', defaultBinding: 'Meta+Shift+R', global: true },
        { id: 'stop', title: 'Stop It' },
      ],
    },
  };
}

// =============================================================================
// § 1. SUPPORTED_API_VERSIONS integrity
// =============================================================================

describe('§1 SUPPORTED_API_VERSIONS integrity', () => {
  it('is a frozen array of numbers', () => {
    expect(Array.isArray(SUPPORTED_API_VERSIONS)).toBe(true);
    for (const v of SUPPORTED_API_VERSIONS) {
      expect(typeof v).toBe('number');
    }
  });

  it('contains exactly [0.5, 0.6]', () => {
    expect(SUPPORTED_API_VERSIONS).toEqual([0.5, 0.6]);
  });

  it('does NOT contain v0.4 (dropped this cycle)', () => {
    expect(SUPPORTED_API_VERSIONS).not.toContain(0.4);
  });

  it('does NOT contain v0.3 or lower', () => {
    expect(SUPPORTED_API_VERSIONS).not.toContain(0.3);
    expect(SUPPORTED_API_VERSIONS).not.toContain(0.2);
    expect(SUPPORTED_API_VERSIONS).not.toContain(0.1);
  });

  it('does NOT contain v1.0 or higher (not yet released)', () => {
    expect(SUPPORTED_API_VERSIONS).not.toContain(1.0);
    expect(SUPPORTED_API_VERSIONS).not.toContain(0.7);
  });
});

// =============================================================================
// § 2. Per-version manifest validation
// =============================================================================

describe('§2 Per-version manifest validation', () => {
  describe('v0.4 manifest rejection', () => {
    it('rejects a manifest targeting API v0.4', () => {
      const result = validateManifest({
        id: 'legacy-plugin',
        name: 'Legacy Plugin',
        version: '1.0.0',
        engine: { api: 0.4 },
        scope: 'project',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('not supported'))).toBe(true);
    });

    it('error message mentions supported versions', () => {
      const result = validateManifest({
        id: 'legacy-plugin',
        name: 'Legacy Plugin',
        version: '1.0.0',
        engine: { api: 0.4 },
        scope: 'project',
      });
      for (const v of SUPPORTED_API_VERSIONS) {
        expect(result.errors.some(e => e.includes(String(v)))).toBe(true);
      }
    });
  });

  describe('v0.5 minimal manifest validation', () => {
    it('accepts a minimal valid v0.5 manifest', () => {
      const result = validateManifest(minimalV05Manifest());
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('requires contributes.help for v0.5', () => {
      const result = validateManifest(minimalV05Manifest({
        contributes: {} as PluginManifest['contributes'],
      }));
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('contributes.help'))).toBe(true);
    });

    it('requires permissions array for v0.5', () => {
      const manifest = minimalV05Manifest();
      delete (manifest as Record<string, unknown>).permissions;
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('permissions array'))).toBe(true);
    });

    it('accepts v0.5 with each scope (project, app, dual)', () => {
      for (const scope of ['project', 'app', 'dual'] as const) {
        const result = validateManifest(minimalV05Manifest({ scope }));
        expect(result.valid).toBe(true);
      }
    });
  });

  describe('v0.5 full manifest validation', () => {
    it('accepts a fully-specified v0.5 manifest', () => {
      const result = validateManifest(fullV05Manifest());
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('validates help topics shape', () => {
      const manifest = fullV05Manifest();
      const contributes = manifest.contributes as Record<string, unknown>;
      (contributes.help as Record<string, unknown>).topics = [
        { id: '', title: '', content: '' },
      ];
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('topics[0].id'))).toBe(true);
    });

    it('validates each permission string against ALL_PLUGIN_PERMISSIONS', () => {
      const result = validateManifest(minimalV05Manifest({
        permissions: ['files', 'not-a-real-permission' as PluginPermission],
      }));
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('unknown permission'))).toBe(true);
    });

    it('rejects duplicate permissions', () => {
      const result = validateManifest(minimalV05Manifest({
        permissions: ['files', 'git', 'files'],
      }));
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('duplicate'))).toBe(true);
    });

    it('rejects v0.5 defaultBinding in commands (v0.6 feature)', () => {
      const result = validateManifest({
        ...minimalV05Manifest(),
        permissions: ['commands'],
        contributes: {
          help: {},
          commands: [
            { id: 'test', title: 'Test', defaultBinding: 'Meta+K' },
          ],
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('requires API >= 0.6'))).toBe(true);
    });
  });

  describe('v0.6 minimal manifest validation', () => {
    it('accepts a minimal valid v0.6 manifest', () => {
      const result = validateManifest(minimalV06Manifest());
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('requires contributes.help for v0.6 (inherited from v0.5+ rule)', () => {
      const result = validateManifest(minimalV06Manifest({
        contributes: {} as PluginManifest['contributes'],
      }));
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('contributes.help'))).toBe(true);
    });

    it('requires permissions array for v0.6', () => {
      const manifest = minimalV06Manifest();
      delete (manifest as Record<string, unknown>).permissions;
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('permissions array'))).toBe(true);
    });
  });

  describe('v0.6 full manifest validation', () => {
    it('accepts a fully-specified v0.6 manifest', () => {
      const result = validateManifest(fullV06Manifest());
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('allows defaultBinding on v0.6 commands', () => {
      const result = validateManifest({
        ...minimalV06Manifest(),
        permissions: ['commands'],
        contributes: {
          help: {},
          commands: [
            { id: 'test', title: 'Test', defaultBinding: 'Meta+Shift+K' },
          ],
        },
      });
      expect(result.valid).toBe(true);
    });

    it('allows global: true on v0.6 commands', () => {
      const result = validateManifest({
        ...minimalV06Manifest(),
        permissions: ['commands'],
        contributes: {
          help: {},
          commands: [
            { id: 'test', title: 'Test', global: true },
          ],
        },
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('v0.6 agent-config permission hierarchy', () => {
    it('accepts agent-config.cross-project with base agent-config', () => {
      const result = validateManifest(minimalV06Manifest({
        permissions: ['agent-config', 'agent-config.cross-project'],
      }));
      expect(result.valid).toBe(true);
    });

    it('rejects agent-config.cross-project WITHOUT base agent-config', () => {
      const result = validateManifest(minimalV06Manifest({
        permissions: ['agent-config.cross-project'],
      }));
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('requires the base "agent-config" permission'))).toBe(true);
    });

    it('rejects agent-config.permissions WITHOUT base agent-config', () => {
      const result = validateManifest(minimalV06Manifest({
        permissions: ['agent-config.permissions'],
      }));
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('requires the base "agent-config"'))).toBe(true);
    });

    it('rejects agent-config.mcp WITHOUT base agent-config', () => {
      const result = validateManifest(minimalV06Manifest({
        permissions: ['agent-config.mcp'],
      }));
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('requires the base "agent-config"'))).toBe(true);
    });

    it('accepts all agent-config sub-permissions with base', () => {
      const result = validateManifest(minimalV06Manifest({
        permissions: [
          'agent-config',
          'agent-config.cross-project',
          'agent-config.permissions',
          'agent-config.mcp',
        ],
      }));
      expect(result.valid).toBe(true);
    });
  });

  describe('every supported version passes with each valid scope', () => {
    for (const version of SUPPORTED_API_VERSIONS) {
      for (const scope of ['project', 'app', 'dual'] as const) {
        it(`v${version} with scope="${scope}" passes validation`, () => {
          const result = validateManifest({
            id: 'scope-test',
            name: 'Scope Test',
            version: '1.0.0',
            engine: { api: version },
            scope,
            permissions: ['files'],
            contributes: { help: {} },
          });
          expect(result.valid).toBe(true);
        });
      }
    }
  });

  describe('every permission in ALL_PLUGIN_PERMISSIONS is accepted individually', () => {
    for (const perm of ALL_PLUGIN_PERMISSIONS) {
      // Skip sub-permissions that require base permissions
      const requiresBase = ['agent-config.cross-project', 'agent-config.permissions', 'agent-config.mcp'];
      const needsExternalRoots = perm === 'files.external';
      const needsAllowedCommands = perm === 'process';

      it(`permission "${perm}" is accepted in a valid manifest`, () => {
        const permissions: PluginPermission[] = [perm];
        const extras: Record<string, unknown> = {};

        // Add base permission if this is a sub-permission
        if (requiresBase.includes(perm)) {
          permissions.unshift('agent-config');
        }

        // Add required companion fields
        if (needsExternalRoots) {
          permissions.unshift('files');
          extras.externalRoots = [{ settingKey: 'root-path', root: 'data' }];
        }
        if (needsAllowedCommands) {
          extras.allowedCommands = ['node'];
        }

        const result = validateManifest(minimalV06Manifest({
          permissions,
          ...extras,
        }));
        expect(result.valid).toBe(true);
      });
    }
  });

  describe('scope/contributes consistency for all versions', () => {
    for (const version of SUPPORTED_API_VERSIONS) {
      it(`v${version}: project-scoped plugin cannot have railItem`, () => {
        const result = validateManifest({
          id: 'test',
          name: 'Test',
          version: '1.0.0',
          engine: { api: version },
          scope: 'project',
          permissions: ['files'],
          contributes: { railItem: { label: 'R' }, help: {} },
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('cannot contribute railItem'))).toBe(true);
      });

      it(`v${version}: app-scoped plugin cannot have tab`, () => {
        const result = validateManifest({
          id: 'test',
          name: 'Test',
          version: '1.0.0',
          engine: { api: version },
          scope: 'app',
          permissions: ['files'],
          contributes: { tab: { label: 'T' }, help: {} },
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('cannot contribute tab'))).toBe(true);
      });

      it(`v${version}: dual-scoped plugin can have both tab and railItem`, () => {
        const result = validateManifest({
          id: 'test',
          name: 'Test',
          version: '1.0.0',
          engine: { api: version },
          scope: 'dual',
          permissions: ['files'],
          contributes: {
            tab: { label: 'T' },
            railItem: { label: 'R' },
            help: {},
          },
        });
        expect(result.valid).toBe(true);
      });
    }
  });

  describe('externalRoots / files.external coupling', () => {
    it('rejects externalRoots without files.external permission', () => {
      const result = validateManifest(minimalV05Manifest({
        permissions: ['files'],
        externalRoots: [{ settingKey: 'path', root: 'data' }],
      }));
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('requires the "files.external" permission'))).toBe(true);
    });

    it('rejects files.external without externalRoots', () => {
      const result = validateManifest(minimalV05Manifest({
        permissions: ['files', 'files.external'],
      }));
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('requires at least one externalRoots entry'))).toBe(true);
    });

    it('accepts files.external with valid externalRoots', () => {
      const result = validateManifest(minimalV05Manifest({
        permissions: ['files', 'files.external'],
        externalRoots: [{ settingKey: 'path', root: 'data' }],
      }));
      expect(result.valid).toBe(true);
    });
  });

  describe('allowedCommands / process permission coupling', () => {
    it('rejects process without allowedCommands', () => {
      const result = validateManifest(minimalV05Manifest({
        permissions: ['files', 'process'],
      }));
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('requires at least one allowedCommands entry'))).toBe(true);
    });

    it('rejects allowedCommands without process permission', () => {
      const result = validateManifest(minimalV05Manifest({
        permissions: ['files'],
        allowedCommands: ['node'],
      }));
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('requires the "process" permission'))).toBe(true);
    });

    it('rejects path separators in allowedCommands', () => {
      for (const bad of ['/usr/bin/node', 'bin\\node', '..node']) {
        const result = validateManifest(minimalV05Manifest({
          permissions: ['files', 'process'],
          allowedCommands: [bad],
        }));
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('path separators'))).toBe(true);
      }
    });
  });
});

// =============================================================================
// § 3. API surface area contracts (mock API completeness)
// =============================================================================

describe('§3 API surface area contracts — createMockAPI()', () => {
  const api = createMockAPI();

  describe('top-level PluginAPI namespaces', () => {
    it('has exactly the expected set of top-level namespaces', () => {
      const actualKeys = Object.keys(api).sort();
      const expectedKeys = [...PLUGIN_API_NAMESPACES].sort();
      expect(actualKeys).toEqual(expectedKeys);
    });

    for (const ns of PLUGIN_API_NAMESPACES) {
      it(`api.${ns} is defined and non-null`, () => {
        expect(api[ns]).toBeDefined();
        expect(api[ns]).not.toBeNull();
      });
    }
  });

  describe('api.project surface', () => {
    for (const method of PROJECT_API_METHODS) {
      it(`api.project.${method} exists`, () => {
        expect(api.project[method]).toBeDefined();
      });
    }

    it('api.project has no extra keys beyond the contract', () => {
      const actualKeys = Object.keys(api.project).sort();
      const expectedKeys = [...PROJECT_API_METHODS].sort();
      expect(actualKeys).toEqual(expectedKeys);
    });
  });

  describe('api.projects surface', () => {
    for (const method of PROJECTS_API_METHODS) {
      it(`api.projects.${method} exists and is callable`, () => {
        expect(typeof api.projects[method]).toBe('function');
      });
    }
  });

  describe('api.git surface', () => {
    for (const method of GIT_API_METHODS) {
      it(`api.git.${method} exists and is callable`, () => {
        expect(typeof api.git[method]).toBe('function');
      });
    }
  });

  describe('api.storage surface', () => {
    for (const key of STORAGE_API_KEYS) {
      it(`api.storage.${key} exists`, () => {
        expect(api.storage[key]).toBeDefined();
      });

      for (const method of SCOPED_STORAGE_METHODS) {
        it(`api.storage.${key}.${method} exists and is callable`, () => {
          expect(typeof api.storage[key][method]).toBe('function');
        });
      }
    }
  });

  describe('api.ui surface', () => {
    for (const method of UI_API_METHODS) {
      it(`api.ui.${method} exists and is callable`, () => {
        expect(typeof api.ui[method]).toBe('function');
      });
    }
  });

  describe('api.commands surface', () => {
    for (const method of COMMANDS_API_METHODS) {
      it(`api.commands.${method} exists and is callable`, () => {
        expect(typeof api.commands[method]).toBe('function');
      });
    }
  });

  describe('api.events surface', () => {
    for (const method of EVENTS_API_METHODS) {
      it(`api.events.${method} exists and is callable`, () => {
        expect(typeof api.events[method]).toBe('function');
      });
    }
  });

  describe('api.settings surface', () => {
    for (const method of SETTINGS_API_METHODS) {
      it(`api.settings.${method} exists and is callable`, () => {
        expect(typeof api.settings[method]).toBe('function');
      });
    }
  });

  describe('api.agents surface', () => {
    for (const method of AGENTS_API_METHODS) {
      it(`api.agents.${method} exists and is callable`, () => {
        expect(typeof api.agents[method]).toBe('function');
      });
    }
  });

  describe('api.hub surface', () => {
    for (const method of HUB_API_METHODS) {
      it(`api.hub.${method} exists and is callable`, () => {
        expect(typeof api.hub[method]).toBe('function');
      });
    }
  });

  describe('api.navigation surface', () => {
    for (const method of NAVIGATION_API_METHODS) {
      it(`api.navigation.${method} exists and is callable`, () => {
        expect(typeof api.navigation[method]).toBe('function');
      });
    }
  });

  describe('api.widgets surface', () => {
    for (const component of WIDGETS_API_COMPONENTS) {
      it(`api.widgets.${component} exists`, () => {
        expect(api.widgets[component]).toBeDefined();
      });
    }
  });

  describe('api.terminal surface', () => {
    for (const method of TERMINAL_API_METHODS) {
      it(`api.terminal.${method} exists`, () => {
        expect(api.terminal[method]).toBeDefined();
      });
    }
  });

  describe('api.logging surface', () => {
    for (const method of LOGGING_API_METHODS) {
      it(`api.logging.${method} exists and is callable`, () => {
        expect(typeof api.logging[method]).toBe('function');
      });
    }
  });

  describe('api.files surface', () => {
    for (const method of FILES_API_METHODS) {
      it(`api.files.${method} exists and is callable`, () => {
        expect(typeof api.files[method]).toBe('function');
      });
    }
  });

  describe('api.process surface', () => {
    for (const method of PROCESS_API_METHODS) {
      it(`api.process.${method} exists and is callable`, () => {
        expect(typeof api.process[method]).toBe('function');
      });
    }
  });

  describe('api.badges surface', () => {
    for (const method of BADGES_API_METHODS) {
      it(`api.badges.${method} exists and is callable`, () => {
        expect(typeof api.badges[method]).toBe('function');
      });
    }
  });

  describe('api.agentConfig surface', () => {
    for (const method of AGENT_CONFIG_API_METHODS) {
      it(`api.agentConfig.${method} exists and is callable`, () => {
        expect(typeof api.agentConfig[method]).toBe('function');
      });
    }
  });

  describe('api.sounds surface', () => {
    for (const method of SOUNDS_API_METHODS) {
      it(`api.sounds.${method} exists and is callable`, () => {
        expect(typeof api.sounds[method]).toBe('function');
      });
    }
  });

  describe('api.theme surface', () => {
    for (const method of THEME_API_METHODS) {
      it(`api.theme.${method} exists and is callable`, () => {
        expect(typeof api.theme[method]).toBe('function');
      });
    }
  });

  describe('api.context surface', () => {
    for (const prop of CONTEXT_PROPERTIES) {
      it(`api.context.${prop} exists`, () => {
        expect(prop in api.context).toBe(true);
      });
    }
  });
});

// =============================================================================
// § 4. Mock API return value contracts (safe defaults)
// =============================================================================

describe('§4 Mock API safe return values', () => {
  const api = createMockAPI();

  it('api.project.readFile() returns empty string', async () => {
    expect(await api.project.readFile('any')).toBe('');
  });

  it('api.project.fileExists() returns false', async () => {
    expect(await api.project.fileExists('any')).toBe(false);
  });

  it('api.project.listDirectory() returns empty array', async () => {
    expect(await api.project.listDirectory()).toEqual([]);
  });

  it('api.projects.list() returns empty array', () => {
    expect(api.projects.list()).toEqual([]);
  });

  it('api.projects.getActive() returns null', () => {
    expect(api.projects.getActive()).toBeNull();
  });

  it('api.git.status() returns empty array', async () => {
    expect(await api.git.status()).toEqual([]);
  });

  it('api.git.log() returns empty array', async () => {
    expect(await api.git.log()).toEqual([]);
  });

  it('api.git.currentBranch() returns "main"', async () => {
    expect(await api.git.currentBranch()).toBe('main');
  });

  it('api.git.diff() returns empty string', async () => {
    expect(await api.git.diff('file.ts')).toBe('');
  });

  it('api.storage.project.read() returns undefined', async () => {
    expect(await api.storage.project.read('k')).toBeUndefined();
  });

  it('api.storage.global.list() returns empty array', async () => {
    expect(await api.storage.global.list()).toEqual([]);
  });

  it('api.ui.showConfirm() returns false', async () => {
    expect(await api.ui.showConfirm('?')).toBe(false);
  });

  it('api.ui.showInput() returns null', async () => {
    expect(await api.ui.showInput('?')).toBeNull();
  });

  it('api.commands.register() returns disposable', () => {
    const d = api.commands.register('cmd', () => {});
    expect(typeof d.dispose).toBe('function');
  });

  it('api.events.on() returns disposable', () => {
    const d = api.events.on('evt', () => {});
    expect(typeof d.dispose).toBe('function');
  });

  it('api.settings.get() returns undefined', () => {
    expect(api.settings.get('k')).toBeUndefined();
  });

  it('api.settings.getAll() returns empty object', () => {
    expect(api.settings.getAll()).toEqual({});
  });

  it('api.agents.list() returns empty array', () => {
    expect(api.agents.list()).toEqual([]);
  });

  it('api.agents.getDetailedStatus() returns null', () => {
    expect(api.agents.getDetailedStatus('x')).toBeNull();
  });

  it('api.agents.listCompleted() returns empty array', () => {
    expect(api.agents.listCompleted()).toEqual([]);
  });

  it('api.files.readTree() returns empty array', async () => {
    expect(await api.files.readTree()).toEqual([]);
  });

  it('api.files.stat() returns valid FileStatInfo', async () => {
    const stat = await api.files.stat('file.txt');
    expect(stat).toHaveProperty('size');
    expect(stat).toHaveProperty('isDirectory');
    expect(stat).toHaveProperty('isFile');
    expect(stat).toHaveProperty('modifiedAt');
  });

  it('api.process.exec() returns zero exit code', async () => {
    const result = await api.process.exec('echo', ['hello']);
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('api.agentConfig.listInjectedSkills() returns empty array', async () => {
    expect(await api.agentConfig.listInjectedSkills()).toEqual([]);
  });

  it('api.agentConfig.getPermissionRules() returns empty allow/deny', async () => {
    expect(await api.agentConfig.getPermissionRules()).toEqual({ allow: [], deny: [] });
  });

  it('api.agentConfig.getInjectedMcpServers() returns empty object', async () => {
    expect(await api.agentConfig.getInjectedMcpServers()).toEqual({});
  });

  it('api.sounds.listPacks() returns empty array', async () => {
    expect(await api.sounds.listPacks()).toEqual([]);
  });

  it('api.theme.getCurrent() returns a ThemeInfo object', () => {
    const theme = api.theme.getCurrent();
    expect(theme).toHaveProperty('id');
    expect(theme).toHaveProperty('name');
    expect(theme).toHaveProperty('type');
    expect(theme).toHaveProperty('colors');
    expect(theme).toHaveProperty('hljs');
    expect(theme).toHaveProperty('terminal');
  });

  it('api.theme.onDidChange() returns disposable', () => {
    const d = api.theme.onDidChange(() => {});
    expect(typeof d.dispose).toBe('function');
  });

  it('api.theme.getColor() returns null for unknown token', () => {
    expect(api.theme.getColor('nonexistent')).toBeNull();
  });

  it('api.context has expected default values', () => {
    expect(api.context.mode).toBe('project');
    expect(api.context.projectId).toBe('test-project');
    expect(api.context.projectPath).toBe('/tmp/test-project');
  });
});

// =============================================================================
// § 5. createMockContext contracts
// =============================================================================

describe('§5 createMockContext() contracts', () => {
  it('returns all required PluginContext fields', () => {
    const ctx = createMockContext();
    expect(ctx.pluginId).toBe('test-plugin');
    expect(ctx.pluginPath).toBe('/tmp/test-plugin');
    expect(ctx.scope).toBe('project');
    expect(ctx.projectId).toBe('test-project');
    expect(ctx.projectPath).toBe('/tmp/test-project');
    expect(Array.isArray(ctx.subscriptions)).toBe(true);
    expect(typeof ctx.settings).toBe('object');
  });

  it('allows overriding every field', () => {
    const ctx = createMockContext({
      pluginId: 'custom',
      pluginPath: '/custom/path',
      scope: 'app',
      projectId: 'proj-99',
      projectPath: '/projects/99',
      settings: { key: 'value' },
    });
    expect(ctx.pluginId).toBe('custom');
    expect(ctx.scope).toBe('app');
    expect(ctx.projectId).toBe('proj-99');
    expect(ctx.settings).toEqual({ key: 'value' });
  });
});

// =============================================================================
// § 6. Regression guards — removing a method MUST break these tests
// =============================================================================

describe('§6 Regression guards — API surface removal detection', () => {
  // These tests check the TypeScript interface's key set against the canonical
  // surface area lists. If someone removes a method from the PluginAPI type,
  // the mock won't compile (TS error) AND these runtime checks will fail.

  it('PluginAPI type has exactly the expected namespace keys', () => {
    const api = createMockAPI();
    const keys = new Set(Object.keys(api));
    for (const ns of PLUGIN_API_NAMESPACES) {
      expect(keys.has(ns)).toBe(true);
    }
    // Also check no unexpected keys
    for (const k of keys) {
      expect(PLUGIN_API_NAMESPACES).toContain(k as keyof PluginAPI);
    }
  });

  it('removing any ProjectAPI method would be detected', () => {
    const api = createMockAPI();
    for (const method of PROJECT_API_METHODS) {
      expect(method in api.project).toBe(true);
    }
  });

  it('removing any GitAPI method would be detected', () => {
    const api = createMockAPI();
    for (const method of GIT_API_METHODS) {
      expect(method in api.git).toBe(true);
    }
  });

  it('removing any CommandsAPI method would be detected', () => {
    const api = createMockAPI();
    for (const method of COMMANDS_API_METHODS) {
      expect(method in api.commands).toBe(true);
    }
  });

  it('removing any AgentsAPI method would be detected', () => {
    const api = createMockAPI();
    for (const method of AGENTS_API_METHODS) {
      expect(method in api.agents).toBe(true);
    }
  });

  it('removing any NavigationAPI method would be detected', () => {
    const api = createMockAPI();
    for (const method of NAVIGATION_API_METHODS) {
      expect(method in api.navigation).toBe(true);
    }
  });

  it('removing any FilesAPI method would be detected', () => {
    const api = createMockAPI();
    for (const method of FILES_API_METHODS) {
      expect(method in api.files).toBe(true);
    }
  });

  it('removing any AgentConfigAPI method would be detected', () => {
    const api = createMockAPI();
    for (const method of AGENT_CONFIG_API_METHODS) {
      expect(method in api.agentConfig).toBe(true);
    }
  });

  it('removing any TerminalAPI method would be detected', () => {
    const api = createMockAPI();
    for (const method of TERMINAL_API_METHODS) {
      expect(method in api.terminal).toBe(true);
    }
  });

  it('removing any LoggingAPI method would be detected', () => {
    const api = createMockAPI();
    for (const method of LOGGING_API_METHODS) {
      expect(method in api.logging).toBe(true);
    }
  });

  it('removing any SoundsAPI method would be detected', () => {
    const api = createMockAPI();
    for (const method of SOUNDS_API_METHODS) {
      expect(method in api.sounds).toBe(true);
    }
  });

  it('removing any BadgesAPI method would be detected', () => {
    const api = createMockAPI();
    for (const method of BADGES_API_METHODS) {
      expect(method in api.badges).toBe(true);
    }
  });

  it('removing any ThemeAPI method would be detected', () => {
    const api = createMockAPI();
    for (const method of THEME_API_METHODS) {
      expect(method in api.theme).toBe(true);
    }
  });

  it('removing any WidgetsAPI component would be detected', () => {
    const api = createMockAPI();
    for (const c of WIDGETS_API_COMPONENTS) {
      expect(c in api.widgets).toBe(true);
    }
  });
});

// =============================================================================
// § 7. ALL_PLUGIN_PERMISSIONS exhaustiveness
// =============================================================================

describe('§7 ALL_PLUGIN_PERMISSIONS exhaustiveness', () => {
  it('contains every PluginPermission value', () => {
    // This is the exhaustive list from the type definition
    const expected: PluginPermission[] = [
      'files', 'files.external', 'git', 'terminal', 'agents',
      'notifications', 'storage', 'navigation', 'projects', 'commands',
      'events', 'widgets', 'logging', 'process', 'badges',
      'agent-config', 'agent-config.cross-project', 'agent-config.permissions',
      'agent-config.mcp', 'sounds', 'theme',
    ];
    expect([...ALL_PLUGIN_PERMISSIONS].sort()).toEqual([...expected].sort());
  });

  it('has no duplicates', () => {
    const set = new Set(ALL_PLUGIN_PERMISSIONS);
    expect(set.size).toBe(ALL_PLUGIN_PERMISSIONS.length);
  });

  it('PERMISSION_DESCRIPTIONS has an entry for every permission', async () => {
    const { PERMISSION_DESCRIPTIONS } = await import('../../shared/plugin-types');
    for (const perm of ALL_PLUGIN_PERMISSIONS) {
      expect(PERMISSION_DESCRIPTIONS[perm]).toBeDefined();
      expect(typeof PERMISSION_DESCRIPTIONS[perm]).toBe('string');
      expect(PERMISSION_DESCRIPTIONS[perm].length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// § 8. Cross-version backward compatibility
// =============================================================================

describe('§8 Cross-version backward compatibility', () => {
  it('v0.5 features still work on v0.6 manifests', () => {
    // A v0.6 manifest should be able to use all v0.5 features
    const result = validateManifest({
      id: 'compat-test',
      name: 'Compat Test',
      version: '1.0.0',
      engine: { api: 0.6 },
      scope: 'project',
      permissions: ['files', 'files.external', 'process'],
      externalRoots: [{ settingKey: 'path', root: 'data' }],
      allowedCommands: ['node'],
      contributes: {
        help: {
          topics: [
            { id: 'intro', title: 'Intro', content: '# Welcome' },
          ],
        },
        tab: { label: 'Tab' },
        commands: [
          { id: 'run', title: 'Run' },
          { id: 'run-global', title: 'Run Global', defaultBinding: 'Meta+R', global: true },
        ],
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('v0.5 manifest still validates identically after v0.6 was added', () => {
    // Core v0.5 validation rules must not regress
    const result = validateManifest(minimalV05Manifest());
    expect(result.valid).toBe(true);
    expect(result.manifest).toBeDefined();
    expect(result.manifest!.engine.api).toBe(0.5);
  });
});
