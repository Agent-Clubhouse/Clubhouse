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

vi.mock('../services/sound-service', () => ({
  getSettings: vi.fn(() => ({ packId: 'default', enabled: true })),
  saveSettings: vi.fn(),
  getAllSoundPacks: vi.fn(() => [{ id: 'default', name: 'Default' }]),
  importSoundPack: vi.fn(async () => ({ id: 'custom', name: 'Custom' })),
  deleteSoundPack: vi.fn(),
  getSoundData: vi.fn(() => 'base64-audio'),
}));

vi.mock('../services/log-service', () => ({
  log: vi.fn(),
  appLog: vi.fn(),
  getNamespaces: vi.fn(() => ['app:test', 'core:ipc']),
  getLogPath: vi.fn(() => '/tmp/app.log'),
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
  resolveOrchestrator: vi.fn(() => ({})),
}));

vi.mock('../services/annex-server', () => ({
  broadcastThemeChanged: vi.fn(),
}));

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerAppHandlers } from './app-handlers';
import * as notificationService from '../services/notification-service';
import * as themeService from '../services/theme-service';
import * as orchestratorSettings from '../services/orchestrator-settings';
import * as headlessSettings from '../services/headless-settings';
import * as clubhouseModeSettings from '../services/clubhouse-mode-settings';
import * as badgeSettings from '../services/badge-settings';
import * as clipboardSettings from '../services/clipboard-settings';
import * as autoUpdateService from '../services/auto-update-service';
import * as soundService from '../services/sound-service';
import * as logService from '../services/log-service';
import * as logSettings from '../services/log-settings';
import * as annexServer from '../services/annex-server';
import { ensureDefaultTemplates, enableExclusions, disableExclusions } from '../services/materialization-service';
import { resolveOrchestrator } from '../services/agent-system';

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
      IPC.APP.GET_SOUND_SETTINGS, IPC.APP.SAVE_SOUND_SETTINGS,
      IPC.APP.LIST_SOUND_PACKS, IPC.APP.IMPORT_SOUND_PACK,
      IPC.APP.DELETE_SOUND_PACK, IPC.APP.GET_SOUND_DATA,
      IPC.LOG.GET_LOG_SETTINGS, IPC.LOG.SAVE_LOG_SETTINGS,
      IPC.LOG.GET_LOG_NAMESPACES, IPC.LOG.GET_LOG_PATH,
    ];
    for (const channel of expectedHandleChannels) {
      expect(handleHandlers.has(channel)).toBe(true);
    }
    expect(onHandlers.has(IPC.LOG.LOG_WRITE)).toBe(true);
  });

  // --- Core ---

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

  // --- Notifications ---

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

  it('SEND_NOTIFICATION delegates to notificationService.sendNotification', async () => {
    const handler = handleHandlers.get(IPC.APP.SEND_NOTIFICATION)!;
    await handler({}, 'Title', 'Body', true, 'a1', 'p1');
    expect(notificationService.sendNotification).toHaveBeenCalledWith('Title', 'Body', true, 'a1', 'p1');
  });

  it('CLOSE_NOTIFICATION delegates to notificationService.closeNotification', async () => {
    const handler = handleHandlers.get(IPC.APP.CLOSE_NOTIFICATION)!;
    await handler({}, 'a1', 'p1');
    expect(notificationService.closeNotification).toHaveBeenCalledWith('a1', 'p1');
  });

  // --- Theme ---

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

  it('UPDATE_TITLE_BAR_OVERLAY sets overlay on focused window on win32', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    const mockSetOverlay = vi.fn();
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValueOnce({ setTitleBarOverlay: mockSetOverlay } as any);

    const handler = handleHandlers.get(IPC.APP.UPDATE_TITLE_BAR_OVERLAY)!;
    await handler({}, { color: '#000', symbolColor: '#fff' });
    expect(mockSetOverlay).toHaveBeenCalledWith({ color: '#000', symbolColor: '#fff' });

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  // --- Orchestrator ---

  it('GET_ORCHESTRATOR_SETTINGS delegates to orchestratorSettings', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_ORCHESTRATOR_SETTINGS)!;
    const result = await handler({});
    expect(orchestratorSettings.getSettings).toHaveBeenCalled();
    expect(result).toEqual({ enabled: ['claude-code'] });
  });

  it('SAVE_ORCHESTRATOR_SETTINGS delegates to orchestratorSettings.saveSettings', async () => {
    const handler = handleHandlers.get(IPC.APP.SAVE_ORCHESTRATOR_SETTINGS)!;
    await handler({}, { enabled: ['claude-code', 'aider'] });
    expect(orchestratorSettings.saveSettings).toHaveBeenCalledWith({ enabled: ['claude-code', 'aider'] });
  });

  // --- Headless ---

  it('GET_HEADLESS_SETTINGS delegates to headlessSettings', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_HEADLESS_SETTINGS)!;
    const result = await handler({});
    expect(headlessSettings.getSettings).toHaveBeenCalled();
    expect(result).toEqual({ enabled: true });
  });

  it('SAVE_HEADLESS_SETTINGS delegates to headlessSettings.saveSettings', async () => {
    const handler = handleHandlers.get(IPC.APP.SAVE_HEADLESS_SETTINGS)!;
    await handler({}, { enabled: false });
    expect(headlessSettings.saveSettings).toHaveBeenCalledWith({ enabled: false });
  });

  // --- Badge ---

  it('GET_BADGE_SETTINGS delegates to badgeSettings', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_BADGE_SETTINGS)!;
    const result = await handler({});
    expect(badgeSettings.getSettings).toHaveBeenCalled();
    expect(result).toEqual({ showBadge: true });
  });

  it('SAVE_BADGE_SETTINGS delegates to badgeSettings.saveSettings', async () => {
    const handler = handleHandlers.get(IPC.APP.SAVE_BADGE_SETTINGS)!;
    await handler({}, { showBadge: false });
    expect(badgeSettings.saveSettings).toHaveBeenCalledWith({ showBadge: false });
  });

  // --- Clipboard ---

  it('GET_CLIPBOARD_SETTINGS delegates to clipboardSettings', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_CLIPBOARD_SETTINGS)!;
    const result = await handler({});
    expect(clipboardSettings.getSettings).toHaveBeenCalled();
    expect(result).toEqual({ clipboardCompat: false });
  });

  it('SAVE_CLIPBOARD_SETTINGS delegates to clipboardSettings.saveSettings', async () => {
    const handler = handleHandlers.get(IPC.APP.SAVE_CLIPBOARD_SETTINGS)!;
    await handler({}, { clipboardCompat: true });
    expect(clipboardSettings.saveSettings).toHaveBeenCalledWith({ clipboardCompat: true });
  });

  // --- Dock Badge ---

  it('SET_DOCK_BADGE sets badge on macOS via app.dock.setBadge', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const handler = handleHandlers.get(IPC.APP.SET_DOCK_BADGE)!;
    await handler({}, 5);
    expect(app.dock.setBadge).toHaveBeenCalledWith('5');

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('SET_DOCK_BADGE sets empty string for count 0 on macOS', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const handler = handleHandlers.get(IPC.APP.SET_DOCK_BADGE)!;
    await handler({}, 0);
    expect(app.dock.setBadge).toHaveBeenCalledWith('');

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('SET_DOCK_BADGE uses app.setBadgeCount on non-macOS', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });

    const handler = handleHandlers.get(IPC.APP.SET_DOCK_BADGE)!;
    await handler({}, 3);
    expect(app.setBadgeCount).toHaveBeenCalledWith(3);

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  // --- Auto-update ---

  it('GET_UPDATE_SETTINGS delegates to autoUpdateService', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_UPDATE_SETTINGS)!;
    const result = await handler({});
    expect(autoUpdateService.getSettings).toHaveBeenCalled();
    expect(result).toEqual({ autoUpdate: true });
  });

  it('SAVE_UPDATE_SETTINGS starts periodic checks when autoUpdate enabled', async () => {
    const handler = handleHandlers.get(IPC.APP.SAVE_UPDATE_SETTINGS)!;
    await handler({}, { autoUpdate: true });
    expect(autoUpdateService.saveSettings).toHaveBeenCalledWith({ autoUpdate: true });
    expect(autoUpdateService.startPeriodicChecks).toHaveBeenCalled();
  });

  it('SAVE_UPDATE_SETTINGS stops periodic checks when autoUpdate disabled', async () => {
    const handler = handleHandlers.get(IPC.APP.SAVE_UPDATE_SETTINGS)!;
    await handler({}, { autoUpdate: false });
    expect(autoUpdateService.stopPeriodicChecks).toHaveBeenCalled();
  });

  it('CHECK_FOR_UPDATES delegates to autoUpdateService.checkForUpdates(true)', async () => {
    const handler = handleHandlers.get(IPC.APP.CHECK_FOR_UPDATES)!;
    await handler({});
    expect(autoUpdateService.checkForUpdates).toHaveBeenCalledWith(true);
  });

  it('GET_UPDATE_STATUS delegates to autoUpdateService.getStatus', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_UPDATE_STATUS)!;
    const result = await handler({});
    expect(autoUpdateService.getStatus).toHaveBeenCalled();
    expect(result).toEqual({ state: 'idle' });
  });

  it('APPLY_UPDATE delegates to autoUpdateService.applyUpdate', async () => {
    const handler = handleHandlers.get(IPC.APP.APPLY_UPDATE)!;
    await handler({});
    expect(autoUpdateService.applyUpdate).toHaveBeenCalled();
  });

  it('GET_PENDING_RELEASE_NOTES delegates to autoUpdateService', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_PENDING_RELEASE_NOTES)!;
    const result = await handler({});
    expect(autoUpdateService.getPendingReleaseNotes).toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('CLEAR_PENDING_RELEASE_NOTES delegates to autoUpdateService', async () => {
    const handler = handleHandlers.get(IPC.APP.CLEAR_PENDING_RELEASE_NOTES)!;
    await handler({});
    expect(autoUpdateService.clearPendingReleaseNotes).toHaveBeenCalled();
  });

  it('GET_VERSION_HISTORY delegates to autoUpdateService', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_VERSION_HISTORY)!;
    const result = await handler({});
    expect(autoUpdateService.getVersionHistory).toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  // --- Sound Packs ---

  it('GET_SOUND_SETTINGS delegates to soundService', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_SOUND_SETTINGS)!;
    const result = await handler({});
    expect(soundService.getSettings).toHaveBeenCalled();
    expect(result).toEqual({ packId: 'default', enabled: true });
  });

  it('SAVE_SOUND_SETTINGS delegates to soundService.saveSettings', async () => {
    const handler = handleHandlers.get(IPC.APP.SAVE_SOUND_SETTINGS)!;
    await handler({}, { packId: 'custom', enabled: false });
    expect(soundService.saveSettings).toHaveBeenCalledWith({ packId: 'custom', enabled: false });
  });

  it('LIST_SOUND_PACKS delegates to soundService.getAllSoundPacks', async () => {
    const handler = handleHandlers.get(IPC.APP.LIST_SOUND_PACKS)!;
    const result = await handler({});
    expect(soundService.getAllSoundPacks).toHaveBeenCalled();
    expect(result).toEqual([{ id: 'default', name: 'Default' }]);
  });

  it('IMPORT_SOUND_PACK delegates to soundService.importSoundPack', async () => {
    const handler = handleHandlers.get(IPC.APP.IMPORT_SOUND_PACK)!;
    const result = await handler({});
    expect(soundService.importSoundPack).toHaveBeenCalled();
    expect(result).toEqual({ id: 'custom', name: 'Custom' });
  });

  it('DELETE_SOUND_PACK delegates to soundService.deleteSoundPack', async () => {
    const handler = handleHandlers.get(IPC.APP.DELETE_SOUND_PACK)!;
    await handler({}, 'custom');
    expect(soundService.deleteSoundPack).toHaveBeenCalledWith('custom');
  });

  it('GET_SOUND_DATA delegates to soundService.getSoundData', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_SOUND_DATA)!;
    const result = await handler({}, 'default', 'agent-complete');
    expect(soundService.getSoundData).toHaveBeenCalledWith('default', 'agent-complete');
    expect(result).toBe('base64-audio');
  });

  // --- Logging ---

  it('LOG_WRITE delegates to logService.log via on()', () => {
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

  it('SAVE_LOG_SETTINGS delegates to logSettings.saveSettings', async () => {
    const handler = handleHandlers.get(IPC.LOG.SAVE_LOG_SETTINGS)!;
    await handler({}, { enabled: false, namespaces: {} });
    expect(logSettings.saveSettings).toHaveBeenCalledWith({ enabled: false, namespaces: {} });
  });

  it('GET_LOG_NAMESPACES delegates to logService.getNamespaces', async () => {
    const handler = handleHandlers.get(IPC.LOG.GET_LOG_NAMESPACES)!;
    const result = await handler({});
    expect(logService.getNamespaces).toHaveBeenCalled();
    expect(result).toEqual(['app:test', 'core:ipc']);
  });

  it('GET_LOG_PATH delegates to logService.getLogPath', async () => {
    const handler = handleHandlers.get(IPC.LOG.GET_LOG_PATH)!;
    const result = await handler({});
    expect(logService.getLogPath).toHaveBeenCalled();
    expect(result).toBe('/tmp/app.log');
  });

  // --- Clubhouse Mode ---

  it('GET_CLUBHOUSE_MODE_SETTINGS delegates to clubhouseModeSettings', async () => {
    const handler = handleHandlers.get(IPC.APP.GET_CLUBHOUSE_MODE_SETTINGS)!;
    const result = await handler({});
    expect(clubhouseModeSettings.getSettings).toHaveBeenCalled();
    expect(result).toEqual({ enabled: false });
  });

  it('SAVE_CLUBHOUSE_MODE_SETTINGS enables templates and exclusions on first enable', async () => {
    vi.mocked(clubhouseModeSettings.isClubhouseModeEnabled).mockReturnValueOnce(false);
    vi.mocked(clubhouseModeSettings.isClubhouseModeEnabled).mockReturnValueOnce(true);

    const handler = handleHandlers.get(IPC.APP.SAVE_CLUBHOUSE_MODE_SETTINGS)!;
    await handler({}, { enabled: true }, '/project');

    expect(clubhouseModeSettings.saveSettings).toHaveBeenCalledWith({ enabled: true });
    expect(ensureDefaultTemplates).toHaveBeenCalledWith('/project');
    expect(enableExclusions).toHaveBeenCalledWith('/project', expect.anything());
  });

  it('SAVE_CLUBHOUSE_MODE_SETTINGS removes exclusions on disable', async () => {
    vi.mocked(clubhouseModeSettings.isClubhouseModeEnabled).mockReturnValueOnce(true);
    vi.mocked(clubhouseModeSettings.isClubhouseModeEnabled).mockReturnValueOnce(false);

    const handler = handleHandlers.get(IPC.APP.SAVE_CLUBHOUSE_MODE_SETTINGS)!;
    await handler({}, { enabled: false }, '/project');

    expect(disableExclusions).toHaveBeenCalledWith('/project');
  });

  it('SAVE_CLUBHOUSE_MODE_SETTINGS does not touch exclusions when state unchanged', async () => {
    vi.mocked(clubhouseModeSettings.isClubhouseModeEnabled).mockReturnValueOnce(false);
    vi.mocked(clubhouseModeSettings.isClubhouseModeEnabled).mockReturnValueOnce(false);

    const handler = handleHandlers.get(IPC.APP.SAVE_CLUBHOUSE_MODE_SETTINGS)!;
    await handler({}, { enabled: false }, '/project');

    expect(ensureDefaultTemplates).not.toHaveBeenCalled();
    expect(enableExclusions).not.toHaveBeenCalled();
    expect(disableExclusions).not.toHaveBeenCalled();
  });

  it('SAVE_CLUBHOUSE_MODE_SETTINGS gracefully handles resolveOrchestrator failure on enable', async () => {
    vi.mocked(clubhouseModeSettings.isClubhouseModeEnabled).mockReturnValueOnce(false);
    vi.mocked(clubhouseModeSettings.isClubhouseModeEnabled).mockReturnValueOnce(true);
    vi.mocked(resolveOrchestrator).mockImplementationOnce(() => { throw new Error('no orchestrator'); });

    const handler = handleHandlers.get(IPC.APP.SAVE_CLUBHOUSE_MODE_SETTINGS)!;
    // Should not throw
    await handler({}, { enabled: true }, '/project');
    expect(ensureDefaultTemplates).toHaveBeenCalledWith('/project');
  });
});
