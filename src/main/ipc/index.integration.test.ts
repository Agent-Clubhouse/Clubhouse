/**
 * Integration tests for registerAllHandlers().
 *
 * Unlike index.test.ts (which mocks every handler module and only verifies
 * wiring order), these tests let the real handler registration functions run
 * and verify that representative IPC handlers actually respond correctly when
 * invoked.  This closes the gap identified in GitHub Issue #659 / TC-25.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Electron mock ──────────────────────────────────────────────────────
// Captures handlers registered via ipcMain.handle / ipcMain.on so we can
// invoke them directly in tests.
const handleHandlers = new Map<string, (...args: any[]) => any>();
const onHandlers = new Map<string, (...args: any[]) => any>();

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '2.5.0'),
    getPath: vi.fn(() => '/tmp/test-app'),
    dock: { setBadge: vi.fn() },
    setBadgeCount: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: any) => {
      handleHandlers.set(channel, handler);
    }),
    on: vi.fn(((channel: string, handler: any) => {
      onHandlers.set(channel, handler);
    }) as any),
    once: vi.fn(),
    removeListener: vi.fn(),
    emit: vi.fn(),
  },
  shell: { openExternal: vi.fn(async () => {}) },
}));

// ── child_process ──────────────────────────────────────────────────────
vi.mock('child_process', () => ({
  execSync: vi.fn(() => '0'),
  execFile: vi.fn(),
}));

// ── fs (needed by project-handlers, agent-handlers) ───────────────────
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => Buffer.from('')),
    readdirSync: vi.fn(() => []),
    rmSync: vi.fn(),
  };
});

// ── Orchestrator / index.ts orchestration deps ─────────────────────────
vi.mock('../orchestrators', () => ({
  registerBuiltinProviders: vi.fn(),
  getProvider: vi.fn(() => ({
    getProfileEnvKeys: vi.fn(() => ['ANTHROPIC_API_KEY']),
  })),
}));

vi.mock('../services/hook-server', () => ({
  start: vi.fn(async () => {}),
}));

vi.mock('../util/ipc-broadcast-policies', () => ({
  registerDefaultBroadcastPolicies: vi.fn(),
}));

vi.mock('../util/ipc-broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}));

// ── Service mocks (app-handlers deps) ──────────────────────────────────
vi.mock('../services/notification-service', () => ({
  getSettings: vi.fn(() => ({ enabled: true, sound: false })),
  saveSettings: vi.fn(),
  sendNotification: vi.fn(),
  closeNotification: vi.fn(),
}));

vi.mock('../services/theme-service', () => ({
  getSettings: vi.fn(() => ({ themeId: 'catppuccin-mocha' })),
  saveSettings: vi.fn(),
}));

vi.mock('../services/orchestrator-settings', () => ({
  getSettings: vi.fn(() => ({ enabled: ['claude-code'] })),
  saveSettings: vi.fn(),
}));

vi.mock('../services/headless-settings', () => ({
  getSettings: vi.fn(() => ({ enabled: false })),
  saveSettings: vi.fn(),
}));

vi.mock('../services/clubhouse-mode-settings', () => ({
  getSettings: vi.fn(() => ({ enabled: false })),
  saveSettings: vi.fn(),
  isClubhouseModeEnabled: vi.fn(() => false),
}));

vi.mock('../services/badge-settings', () => ({
  getSettings: vi.fn(() => ({ showBadge: true })),
  saveSettings: vi.fn(),
}));

vi.mock('../services/clipboard-settings', () => ({
  getSettings: vi.fn(() => ({ clipboardCompat: false })),
  saveSettings: vi.fn(),
}));

vi.mock('../services/auto-update-service', () => ({
  getSettings: vi.fn(() => ({ autoUpdate: true })),
  saveSettings: vi.fn(),
  startPeriodicChecks: vi.fn(),
  stopPeriodicChecks: vi.fn(),
  checkForUpdates: vi.fn(async () => null),
  getStatus: vi.fn(() => ({ state: 'idle' })),
  applyUpdate: vi.fn(async () => {}),
  getPendingReleaseNotes: vi.fn(() => null),
  clearPendingReleaseNotes: vi.fn(),
  getVersionHistory: vi.fn(() => []),
}));

vi.mock('../services/sound-service', () => ({
  getSettings: vi.fn(() => ({ packId: 'default', enabled: true })),
  saveSettings: vi.fn(),
  getAllSoundPacks: vi.fn(() => []),
  importSoundPack: vi.fn(async () => null),
  deleteSoundPack: vi.fn(),
  getSoundData: vi.fn(() => null),
}));

vi.mock('../services/session-settings', () => ({
  getSettings: vi.fn(() => ({ maxSessions: 10 })),
  saveSettings: vi.fn(),
}));

vi.mock('../services/log-service', () => ({
  init: vi.fn(),
  log: vi.fn(),
  appLog: vi.fn(),
  getNamespaces: vi.fn(() => ['core:startup']),
  getLogPath: vi.fn(() => '/tmp/clubhouse.log'),
}));

vi.mock('../services/log-settings', () => ({
  getSettings: vi.fn(() => ({ enabled: true, namespaces: {} })),
  saveSettings: vi.fn(),
}));

vi.mock('../services/materialization-service', () => ({
  ensureDefaultTemplates: vi.fn(),
  enableExclusions: vi.fn(),
  disableExclusions: vi.fn(),
  materializeAgent: vi.fn(),
  previewMaterialization: vi.fn(),
  resetProjectAgentDefaults: vi.fn(),
}));

vi.mock('../services/agent-system', () => ({
  resolveOrchestrator: vi.fn(() => ({})),
}));

vi.mock('../services/annex-server', () => ({
  broadcastThemeChanged: vi.fn(),
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  getStatus: vi.fn(() => ({ running: false })),
}));

// ── Service mocks (project-handlers deps) ──────────────────────────────
vi.mock('../services/project-store', () => ({
  list: vi.fn(() => [
    { id: 'p1', name: 'ProjectA', path: '/projects/a' },
    { id: 'p2', name: 'ProjectB', path: '/projects/b' },
  ]),
  add: vi.fn((dirPath: string) => ({ id: 'p3', name: 'New', path: dirPath })),
  remove: vi.fn(),
  update: vi.fn(),
  reorder: vi.fn(),
  setIcon: vi.fn(),
  readIconData: vi.fn(),
  saveCroppedIcon: vi.fn(),
}));

vi.mock('../services/agent-config', () => ({
  ensureGitignore: vi.fn(),
  getDurableConfig: vi.fn(() => ({})),
}));

// ── Service mocks (process-handlers deps) ──────────────────────────────
vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: '/usr/bin' })),
}));

vi.mock('../services/plugin-manifest-registry', () => ({
  getAllowedCommands: vi.fn(() => []),
  initializeTrustedManifests: vi.fn(),
  refreshManifest: vi.fn(),
  unregisterManifest: vi.fn(),
  getManifest: vi.fn(() => null),
}));

// ── Service mocks (profile-handlers deps) ──────────────────────────────
vi.mock('../services/profile-settings', () => ({
  getSettings: vi.fn(() => ({
    profiles: [{ id: 'prof1', name: 'Default', orchestratorId: 'claude-code', env: {} }],
  })),
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));

// ── Service mocks (pty-handlers deps) ──────────────────────────────────
vi.mock('../services/pty-manager', () => ({
  spawnShell: vi.fn(() => 'session-1'),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  getBuffer: vi.fn(() => ''),
}));

// ── Service mocks (file-handlers deps) ─────────────────────────────────
vi.mock('../services/file-service', () => ({
  readTree: vi.fn(() => []),
  readFile: vi.fn(() => ''),
  readBinary: vi.fn(() => null),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  deleteItem: vi.fn(),
  rename: vi.fn(),
  copy: vi.fn(),
  stat: vi.fn(() => null),
}));

vi.mock('../services/search-service', () => ({
  search: vi.fn(() => []),
}));

vi.mock('../services/file-watch-service', () => ({
  startWatch: vi.fn(),
  stopWatch: vi.fn(),
}));

// ── Service mocks (git-handlers deps) ──────────────────────────────────
vi.mock('../services/git-service', () => ({
  info: vi.fn(() => ({})),
  checkout: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
  stageAll: vi.fn(),
  unstageAll: vi.fn(),
  discard: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
  pull: vi.fn(),
  diff: vi.fn(() => ''),
  createBranch: vi.fn(),
  stash: vi.fn(),
  stashPop: vi.fn(),
}));

// ── Service mocks (agent-handlers deps) ────────────────────────────────
vi.mock('../services/headless-manager', () => ({
  isHeadlessAgent: vi.fn(() => false),
}));

vi.mock('../services/structured-manager', () => ({
  startSession: vi.fn(),
  cancelSession: vi.fn(),
  sendMessage: vi.fn(),
  respondPermission: vi.fn(),
}));

vi.mock('../orchestrators/shared', () => ({
  buildSummaryInstruction: vi.fn(() => ''),
  readQuickSummary: vi.fn(() => null),
}));

vi.mock('../services/session-reader', () => ({
  normalizeSessionEvents: vi.fn(() => []),
  buildSessionSummary: vi.fn(() => ''),
  paginateEvents: vi.fn(() => ({ events: [], hasMore: false })),
}));

// ── Service mocks (agent-settings-handlers deps) ───────────────────────
vi.mock('../services/agent-settings-service', () => ({
  readSettings: vi.fn(() => ({})),
  writeSettings: vi.fn(),
  readProjectAgentDefaults: vi.fn(() => ({})),
  writeProjectAgentDefaults: vi.fn(),
  getConventions: vi.fn(() => ({})),
  listSkills: vi.fn(() => []),
  readSkillContent: vi.fn(() => ''),
  writeSkillContent: vi.fn(),
  deleteSkill: vi.fn(),
  listAgentTemplates: vi.fn(() => []),
  readAgentTemplateContent: vi.fn(() => ''),
  writeAgentTemplateContent: vi.fn(),
  deleteAgentTemplate: vi.fn(),
  listAgentTemplateFiles: vi.fn(() => []),
  listSourceSkills: vi.fn(() => []),
  readSourceSkillContent: vi.fn(() => ''),
  writeSourceSkillContent: vi.fn(),
  deleteSourceSkill: vi.fn(),
  listSourceAgentTemplates: vi.fn(() => []),
  readSourceAgentTemplateContent: vi.fn(() => ''),
  writeSourceAgentTemplateContent: vi.fn(),
  deleteSourceAgentTemplate: vi.fn(),
}));

vi.mock('../services/config-diff-service', () => ({
  computeConfigDiff: vi.fn(() => ({})),
  propagateChanges: vi.fn(),
}));

// ── Service mocks (plugin-handlers deps) ───────────────────────────────
vi.mock('../services/plugin-storage', () => ({
  read: vi.fn(() => null),
  write: vi.fn(),
  deleteKey: vi.fn(),
  list: vi.fn(() => []),
  readFile: vi.fn(() => null),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  fileExists: vi.fn(() => false),
  listDir: vi.fn(() => []),
  mkdir: vi.fn(),
  readStartupMarker: vi.fn(() => null),
  writeStartupMarker: vi.fn(),
  clearStartupMarker: vi.fn(),
}));

vi.mock('../services/plugin-discovery', () => ({
  discoverCommunityPlugins: vi.fn(() => []),
  uninstallPlugin: vi.fn(),
  cleanupProjectInjections: vi.fn(),
  listProjectInjections: vi.fn(() => []),
  listOrphanedPluginIds: vi.fn(() => []),
}));

vi.mock('../services/gitignore-manager', () => ({
  addEntry: vi.fn(),
  removeEntry: vi.fn(),
  checkEntry: vi.fn(() => false),
}));

vi.mock('../services/safe-mode', () => ({
  isSafeModeEnabled: vi.fn(() => false),
}));

// ── Service mocks (annex-handlers deps) ────────────────────────────────
vi.mock('../services/annex-settings', () => ({
  getSettings: vi.fn(() => ({ enabled: false, pin: '1234' })),
  saveSettings: vi.fn(),
  regeneratePin: vi.fn(() => '5678'),
}));

// ── Service mocks (marketplace-handlers deps) ──────────────────────────
vi.mock('../services/marketplace-service', () => ({
  fetchRegistry: vi.fn(async () => []),
  installPlugin: vi.fn(async () => ({})),
}));

vi.mock('../services/plugin-update-service', () => ({
  checkForUpdates: vi.fn(async () => []),
  updatePlugin: vi.fn(async () => ({})),
}));

vi.mock('../services/custom-marketplace-service', () => ({
  list: vi.fn(() => []),
  add: vi.fn(),
  remove: vi.fn(),
  toggle: vi.fn(),
}));

// ── Window-handlers: mock the theme helpers it imports ──────────────────
vi.mock('../services/theme-service');
vi.mock('../title-bar-colors', () => ({
  getThemeColorsForTitleBar: vi.fn(() => ({ bg: '#000', mantle: '#111', text: '#fff' })),
}));

// ── Imports ────────────────────────────────────────────────────────────
import { IPC } from '../../shared/ipc-channels';
import { registerAllHandlers } from './index';
import { execFile } from 'child_process';
import * as notificationService from '../services/notification-service';
import * as projectStore from '../services/project-store';
import * as logService from '../services/log-service';
import * as profileSettings from '../services/profile-settings';
import { getAllowedCommands } from '../services/plugin-manifest-registry';

// ════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════

describe('registerAllHandlers — integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleHandlers.clear();
    onHandlers.clear();
    registerAllHandlers();
  });

  // ── Smoke: handlers are actually registered ─────────────────────────

  it('registers handlers across multiple modules via ipcMain.handle', () => {
    // Spot-check channels from different handler modules
    expect(handleHandlers.has(IPC.APP.GET_VERSION)).toBe(true);
    expect(handleHandlers.has(IPC.PROJECT.LIST)).toBe(true);
    expect(handleHandlers.has(IPC.PROCESS.EXEC)).toBe(true);
    expect(handleHandlers.has(IPC.PROFILE.GET_SETTINGS)).toBe(true);
    expect(handleHandlers.has(IPC.GIT.INFO)).toBe(true);
    expect(handleHandlers.has(IPC.FILE.READ)).toBe(true);
  });

  it('registers fire-and-forget handlers via ipcMain.on', () => {
    expect(onHandlers.has(IPC.LOG.LOG_WRITE)).toBe(true);
  });

  // ── App handlers: actual invocation ─────────────────────────────────

  it('GET_VERSION handler returns the app version', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_VERSION)!;
    const result = await handler({});
    expect(result).toBe('2.5.0');
  });

  it('GET_NOTIFICATION_SETTINGS handler delegates to notificationService', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_NOTIFICATION_SETTINGS)!;
    const result = await handler({});
    expect(notificationService.getSettings).toHaveBeenCalled();
    expect(result).toEqual({ enabled: true, sound: false });
  });

  it('SAVE_NOTIFICATION_SETTINGS handler passes settings to service', async () => {
    const handler = handleHandlers.get(IPC.APP.SAVE_NOTIFICATION_SETTINGS)!;
    await handler({}, { enabled: false, sound: true });
    expect(notificationService.saveSettings).toHaveBeenCalledWith({ enabled: false, sound: true });
  });

  // ── Project handlers: actual invocation ─────────────────────────────

  it('PROJECT.LIST handler returns projects from the store', async () => {
    const handler = handleHandlers.get(IPC.PROJECT.LIST)!;
    const result = await handler({});
    expect(projectStore.list).toHaveBeenCalled();
    expect(result).toEqual([
      { id: 'p1', name: 'ProjectA', path: '/projects/a' },
      { id: 'p2', name: 'ProjectB', path: '/projects/b' },
    ]);
  });

  it('PROJECT.ADD handler adds and returns the new project', async () => {
    const handler = handleHandlers.get(IPC.PROJECT.ADD)!;
    const result = await handler({}, '/home/user/my-project');
    expect(projectStore.add).toHaveBeenCalledWith('/home/user/my-project');
    expect(result).toEqual({ id: 'p3', name: 'New', path: '/home/user/my-project' });
  });

  // ── Process handlers: validation logic ──────────────────────────────

  it('PROCESS.EXEC rejects requests with missing pluginId', async () => {
    const handler = handleHandlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, { command: 'ls', args: [] });
    expect(result).toEqual({ stdout: '', stderr: 'Missing pluginId', exitCode: 1 });
  });

  it('PROCESS.EXEC rejects commands with path separators', async () => {
    const handler = handleHandlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'test-plugin',
      command: '/usr/bin/ls',
      args: [],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid command');
  });

  it('PROCESS.EXEC rejects commands not in the server-side manifest', async () => {
    vi.mocked(getAllowedCommands).mockReturnValue(['git']);
    const handler = handleHandlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'test-plugin',
      command: 'rm',
      args: ['-rf', '/'],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not allowed');
  });

  it('PROCESS.EXEC executes allowed commands and returns output', async () => {
    vi.mocked(getAllowedCommands).mockReturnValue(['node']);
    vi.mocked(execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        callback(null, 'v20.0.0', '');
        return {} as any;
      },
    );

    const handler = handleHandlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'test-plugin',
      command: 'node',
      args: ['--version'],
      projectPath: '/project',
    });
    expect(result).toEqual({ stdout: 'v20.0.0', stderr: '', exitCode: 0 });
  });

  // ── Log handlers: fire-and-forget ───────────────────────────────────

  it('LOG_WRITE handler delegates to logService.log', () => {
    const handler = onHandlers.get(IPC.LOG.LOG_WRITE)!;
    const entry = { ts: '2026-03-08', ns: 'app:test', level: 'info', msg: 'hello' };
    handler({}, entry);
    expect(logService.log).toHaveBeenCalledWith(entry);
  });

  it('GET_LOG_PATH handler returns the log file path', async () => {
    const handler = handleHandlers.get(IPC.LOG.GET_LOG_PATH)!;
    const result = await handler({});
    expect(result).toBe('/tmp/clubhouse.log');
  });

  // ── Profile handlers: actual invocation ─────────────────────────────

  it('PROFILE.GET_SETTINGS handler returns profile settings', async () => {
    const handler = handleHandlers.get(IPC.PROFILE.GET_SETTINGS)!;
    const result = await handler({});
    expect(profileSettings.getSettings).toHaveBeenCalled();
    expect(result).toEqual({
      profiles: [{ id: 'prof1', name: 'Default', orchestratorId: 'claude-code', env: {} }],
    });
  });

  it('PROFILE.SAVE_PROFILE handler delegates to profileSettings', async () => {
    const handler = handleHandlers.get(IPC.PROFILE.SAVE_PROFILE)!;
    const profile = { id: 'prof2', name: 'Custom', orchestratorId: 'claude-code', env: { FOO: 'bar' } };
    await handler({}, profile);
    expect(profileSettings.saveProfile).toHaveBeenCalledWith(profile);
  });
});
