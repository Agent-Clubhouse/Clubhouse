import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.0.0'),
    getPath: vi.fn(() => '/tmp/test-app'),
    dock: { setBadge: vi.fn() },
    setBadgeCount: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => ({
      setTitleBarOverlay: vi.fn(),
    })),
    getAllWindows: vi.fn(() => []),
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: { openExternal: vi.fn(async () => {}) },
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => '0'),
}));

vi.mock('../services/notification-service', () => ({
  getSettings: vi.fn(() => ({ enabled: true })),
  saveSettings: vi.fn(),
  sendNotification: vi.fn(),
  closeNotification: vi.fn(),
}));

vi.mock('../services/theme-service', () => ({
  getSettings: vi.fn(() => ({ themeId: 'dark' })),
  saveSettings: vi.fn(),
}));

vi.mock('../services/orchestrator-settings', () => ({
  getSettings: vi.fn(() => ({ enabled: ['claude-code'] })),
  saveSettings: vi.fn(),
}));

vi.mock('../services/headless-settings', () => ({
  getSettings: vi.fn(() => ({ enabled: true })),
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

vi.mock('../services/log-service', () => ({
  log: vi.fn(),
  appLog: vi.fn(),
}));

vi.mock('../services/log-settings', () => ({
  getSettings: vi.fn(() => ({ enabled: true, namespaces: {} })),
  saveSettings: vi.fn(),
}));

vi.mock('../services/materialization-service', () => ({
  ensureDefaultTemplates: vi.fn(),
  enableExclusions: vi.fn(),
  disableExclusions: vi.fn(),
}));

vi.mock('../services/agent-system', () => ({
  resolveOrchestrator: vi.fn(),
}));

vi.mock('../services/annex-server', () => ({
  broadcastThemeChanged: vi.fn(),
}));

import { app, ipcMain, shell } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerAppHandlers } from './app-handlers';
import * as notificationService from '../services/notification-service';
import * as themeService from '../services/theme-service';
import * as orchestratorSettings from '../services/orchestrator-settings';
import * as autoUpdateService from '../services/auto-update-service';
import * as logService from '../services/log-service';
import * as logSettings from '../services/log-settings';
import * as annexServer from '../services/annex-server';

describe('app-handlers', () => {
  let handleHandlers: Map<string, (...args: any[]) => any>;
  let onHandlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    vi.clearAllMocks();
    handleHandlers = new Map();
    onHandlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: any) => {
      handleHandlers.set(channel, handler);
    });
    vi.mocked(ipcMain.on).mockImplementation(((channel: string, handler: any) => {
      onHandlers.set(channel, handler);
    }) as any);
    registerAppHandlers();
  });

  it('registers all expected app IPC handlers', () => {
    const expectedHandleChannels = [
      IPC.APP.OPEN_EXTERNAL_URL, IPC.APP.GET_VERSION, IPC.APP.GET_ARCH_INFO,
      IPC.APP.GET_NOTIFICATION_SETTINGS, IPC.APP.SAVE_NOTIFICATION_SETTINGS,
      IPC.APP.SEND_NOTIFICATION, IPC.APP.CLOSE_NOTIFICATION,
      IPC.APP.GET_THEME, IPC.APP.SAVE_THEME, IPC.APP.UPDATE_TITLE_BAR_OVERLAY,
      IPC.APP.GET_ORCHESTRATOR_SETTINGS, IPC.APP.SAVE_ORCHESTRATOR_SETTINGS,
      IPC.APP.GET_HEADLESS_SETTINGS, IPC.APP.SAVE_HEADLESS_SETTINGS,
      IPC.APP.GET_BADGE_SETTINGS, IPC.APP.SAVE_BADGE_SETTINGS,
      IPC.APP.GET_CLIPBOARD_SETTINGS, IPC.APP.SAVE_CLIPBOARD_SETTINGS,
      IPC.APP.SET_DOCK_BADGE,
      IPC.APP.GET_UPDATE_SETTINGS, IPC.APP.SAVE_UPDATE_SETTINGS,
      IPC.APP.CHECK_FOR_UPDATES, IPC.APP.GET_UPDATE_STATUS, IPC.APP.APPLY_UPDATE,
      IPC.APP.GET_PENDING_RELEASE_NOTES, IPC.APP.CLEAR_PENDING_RELEASE_NOTES,
      IPC.APP.GET_VERSION_HISTORY,
      IPC.APP.GET_CLUBHOUSE_MODE_SETTINGS, IPC.APP.SAVE_CLUBHOUSE_MODE_SETTINGS,
    ];
    for (const channel of expectedHandleChannels) {
      expect(handleHandlers.has(channel)).toBe(true);
    }
    // Logging uses on() for fire-and-forget write
    expect(onHandlers.has(IPC.LOG.LOG_WRITE)).toBe(true);
  });

  it('OPEN_EXTERNAL_URL delegates to shell.openExternal', async () => {
    const handler = handleHandlers.get(IPC.APP.OPEN_EXTERNAL_URL)!;
    await handler({}, 'https://example.com');
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('GET_VERSION returns app version', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_VERSION)!;
    const result = await handler({});
    expect(app.getVersion).toHaveBeenCalled();
    expect(result).toBe('1.0.0');
  });

  it('GET_ARCH_INFO returns arch, platform, and rosetta info', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_ARCH_INFO)!;
    const result = await handler({});
    expect(result).toEqual(
      expect.objectContaining({
        arch: expect.any(String),
        platform: expect.any(String),
        rosetta: expect.any(Boolean),
      }),
    );
  });

  it('GET_NOTIFICATION_SETTINGS delegates to notificationService', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_NOTIFICATION_SETTINGS)!;
    const result = await handler({});
    expect(notificationService.getSettings).toHaveBeenCalled();
    expect(result).toEqual({ enabled: true });
  });

  it('SAVE_NOTIFICATION_SETTINGS delegates to notificationService', async () => {
    const handler = handleHandlers.get(IPC.APP.SAVE_NOTIFICATION_SETTINGS)!;
    await handler({}, { enabled: false });
    expect(notificationService.saveSettings).toHaveBeenCalledWith({ enabled: false });
  });

  it('GET_THEME delegates to themeService', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_THEME)!;
    const result = await handler({});
    expect(themeService.getSettings).toHaveBeenCalled();
    expect(result).toEqual({ themeId: 'dark' });
  });

  it('SAVE_THEME saves settings and broadcasts theme change', async () => {
    const handler = handleHandlers.get(IPC.APP.SAVE_THEME)!;
    await handler({}, { themeId: 'light' });
    expect(themeService.saveSettings).toHaveBeenCalled();
    expect(annexServer.broadcastThemeChanged).toHaveBeenCalled();
  });

  it('GET_ORCHESTRATOR_SETTINGS delegates to orchestratorSettings', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_ORCHESTRATOR_SETTINGS)!;
    const result = await handler({});
    expect(orchestratorSettings.getSettings).toHaveBeenCalled();
    expect(result).toEqual({ enabled: ['claude-code'] });
  });

  it('SAVE_UPDATE_SETTINGS starts periodic checks when autoUpdate enabled', async () => {
    const handler = handleHandlers.get(IPC.APP.SAVE_UPDATE_SETTINGS)!;
    await handler({}, { autoUpdate: true });
    expect(autoUpdateService.startPeriodicChecks).toHaveBeenCalled();
  });

  it('SAVE_UPDATE_SETTINGS stops periodic checks when autoUpdate disabled', async () => {
    const handler = handleHandlers.get(IPC.APP.SAVE_UPDATE_SETTINGS)!;
    await handler({}, { autoUpdate: false });
    expect(autoUpdateService.stopPeriodicChecks).toHaveBeenCalled();
  });

  it('LOG_WRITE delegates to logService.log via on()', async () => {
    const handler = onHandlers.get(IPC.LOG.LOG_WRITE)!;
    const entry = { ts: '2024-01-01', ns: 'app:test', level: 'info', msg: 'test' };
    handler({}, entry);
    expect(logService.log).toHaveBeenCalledWith(entry);
  });

  it('GET_LOG_SETTINGS delegates to logSettings', async () => {
    const handler = handleHandlers.get(IPC.LOG.GET_LOG_SETTINGS)!;
    const result = await handler({});
    expect(logSettings.getSettings).toHaveBeenCalled();
    expect(result).toEqual({ enabled: true, namespaces: {} });
  });
});
