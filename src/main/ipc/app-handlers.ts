import { execSync } from 'child_process';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { ArchInfo, BadgeSettings, LogEntry, LoggingSettings, NotificationSettings } from '../../shared/types';
import * as notificationService from '../services/notification-service';
import * as themeService from '../services/theme-service';
import * as orchestratorSettings from '../services/orchestrator-settings';
import * as headlessSettings from '../services/headless-settings';
import * as clubhouseModeSettings from '../services/clubhouse-mode-settings';
import * as badgeSettings from '../services/badge-settings';
import { clipboardSettings } from './settings-handlers';
import * as autoUpdateService from '../services/auto-update-service';
import * as soundService from '../services/sound-service';
import * as sessionSettings from '../services/session-settings';
import * as logService from '../services/log-service';
import * as logSettings from '../services/log-settings';
import { ClipboardSettings, ClubhouseModeSettings, SoundEvent, SoundSettings, UpdateSettings } from '../../shared/types';
import { ensureDefaultTemplates, enableExclusions, disableExclusions } from '../services/materialization-service';
import { resolveOrchestrator } from '../services/agent-system';
import * as annexServer from '../services/annex-server';

export function registerAppHandlers(): void {
  ipcMain.handle(IPC.APP.OPEN_EXTERNAL_URL, (_event, url: string) => {
    return shell.openExternal(url);
  });

  ipcMain.handle(IPC.APP.GET_VERSION, () => {
    return app.getVersion();
  });

  ipcMain.handle(IPC.APP.GET_ARCH_INFO, (): ArchInfo => {
    let rosetta = false;
    if (process.platform === 'darwin' && process.arch === 'x64') {
      try {
        const result = execSync('sysctl -n sysctl.proc_translated', { encoding: 'utf8' }).trim();
        rosetta = result === '1';
      } catch {
        // sysctl key doesn't exist on Intel Macs — not Rosetta
      }
    }
    return { arch: process.arch, platform: process.platform, rosetta };
  });

  ipcMain.handle(IPC.APP.GET_NOTIFICATION_SETTINGS, () => {
    return notificationService.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_NOTIFICATION_SETTINGS, async (_event, settings: NotificationSettings) => {
    await notificationService.saveSettings(settings);
  });

  ipcMain.handle(IPC.APP.SEND_NOTIFICATION, (_event, title: string, body: string, silent: boolean, agentId?: string, projectId?: string) => {
    notificationService.sendNotification(title, body, silent, agentId, projectId);
  });

  ipcMain.handle(IPC.APP.CLOSE_NOTIFICATION, (_event, agentId: string, projectId: string) => {
    notificationService.closeNotification(agentId, projectId);
  });

  ipcMain.handle(IPC.APP.GET_THEME, () => {
    return themeService.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_THEME, async (_event, settings: { themeId: string }) => {
    await themeService.saveSettings(settings as any);
    annexServer.broadcastThemeChanged();
  });

  // Update the Windows title bar overlay colors on ALL windows when the theme changes
  ipcMain.handle(IPC.APP.UPDATE_TITLE_BAR_OVERLAY, (_event, colors: { color: string; symbolColor: string }) => {
    if (process.platform !== 'win32') return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.setTitleBarOverlay({
          color: colors.color,
          symbolColor: colors.symbolColor,
        });
      }
    }
  });

  ipcMain.handle(IPC.APP.GET_ORCHESTRATOR_SETTINGS, () => {
    return orchestratorSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_ORCHESTRATOR_SETTINGS, async (_event, settings: orchestratorSettings.OrchestratorSettings) => {
    await orchestratorSettings.saveSettings(settings);
  });

  ipcMain.handle(IPC.APP.GET_HEADLESS_SETTINGS, () => {
    return headlessSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_HEADLESS_SETTINGS, async (_event, settings: headlessSettings.HeadlessSettings) => {
    await headlessSettings.saveSettings(settings);
  });

  ipcMain.handle(IPC.APP.GET_BADGE_SETTINGS, () => {
    return badgeSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_BADGE_SETTINGS, async (_event, settings: BadgeSettings) => {
    await badgeSettings.saveSettings(settings);
  });

  // Clipboard settings are now managed via createManagedSettings() in settings-handlers.ts.
  // Legacy IPC channels preserved for backward compatibility with any external consumers.
  ipcMain.handle(IPC.APP.GET_CLIPBOARD_SETTINGS, () => {
    return clipboardSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_CLIPBOARD_SETTINGS, async (_event, settings: ClipboardSettings) => {
    await clipboardSettings.saveSettings(settings);
  });

  ipcMain.handle(IPC.APP.SET_DOCK_BADGE, (_event, count: number) => {
    if (process.platform === 'darwin') {
      app.dock.setBadge(count > 0 ? String(count) : '');
    } else {
      app.setBadgeCount(count);
    }
  });

  // --- Auto-update ---
  ipcMain.handle(IPC.APP.GET_UPDATE_SETTINGS, () => {
    return autoUpdateService.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_UPDATE_SETTINGS, async (_event, settings: UpdateSettings) => {
    await autoUpdateService.saveSettings(settings);
    if (settings.autoUpdate) {
      await autoUpdateService.startPeriodicChecks();
    } else {
      autoUpdateService.stopPeriodicChecks();
    }
  });

  ipcMain.handle(IPC.APP.CHECK_FOR_UPDATES, () => {
    return autoUpdateService.checkForUpdates(true);
  });

  ipcMain.handle(IPC.APP.GET_UPDATE_STATUS, () => {
    return autoUpdateService.getStatus();
  });

  ipcMain.handle(IPC.APP.APPLY_UPDATE, () => {
    return autoUpdateService.applyUpdate();
  });

  ipcMain.handle(IPC.APP.GET_PENDING_RELEASE_NOTES, async () => {
    return autoUpdateService.getPendingReleaseNotes();
  });

  ipcMain.handle(IPC.APP.CLEAR_PENDING_RELEASE_NOTES, async () => {
    return autoUpdateService.clearPendingReleaseNotes();
  });

  ipcMain.handle(IPC.APP.GET_VERSION_HISTORY, () => {
    return autoUpdateService.getVersionHistory();
  });

  // --- Logging ---
  ipcMain.on(IPC.LOG.LOG_WRITE, (_event, entry: LogEntry) => {
    logService.log(entry);
  });

  ipcMain.handle(IPC.LOG.GET_LOG_SETTINGS, () => {
    return logSettings.getSettings();
  });

  ipcMain.handle(IPC.LOG.SAVE_LOG_SETTINGS, async (_event, settings: LoggingSettings) => {
    await logSettings.saveSettings(settings);
  });

  ipcMain.handle(IPC.LOG.GET_LOG_NAMESPACES, () => {
    return logService.getNamespaces();
  });

  ipcMain.handle(IPC.LOG.GET_LOG_PATH, () => {
    return logService.getLogPath();
  });

  // --- Sound Packs ---
  ipcMain.handle(IPC.APP.GET_SOUND_SETTINGS, () => {
    return soundService.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_SOUND_SETTINGS, async (_event, settings: SoundSettings) => {
    await soundService.saveSettings(settings);
  });

  ipcMain.handle(IPC.APP.LIST_SOUND_PACKS, () => {
    return soundService.getAllSoundPacks();
  });

  ipcMain.handle(IPC.APP.IMPORT_SOUND_PACK, () => {
    return soundService.importSoundPack();
  });

  ipcMain.handle(IPC.APP.DELETE_SOUND_PACK, (_event, packId: string) => {
    return soundService.deleteSoundPack(packId);
  });

  ipcMain.handle(IPC.APP.GET_SOUND_DATA, (_event, packId: string, event: SoundEvent) => {
    return soundService.getSoundData(packId, event);
  });

  // --- Session Settings ---
  ipcMain.handle(IPC.APP.GET_SESSION_SETTINGS, () => {
    return sessionSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_SESSION_SETTINGS, async (_event, settings: sessionSettings.SessionSettings) => {
    await sessionSettings.saveSettings(settings);
  });

  // --- Clubhouse Mode ---
  ipcMain.handle(IPC.APP.GET_CLUBHOUSE_MODE_SETTINGS, () => {
    return clubhouseModeSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_CLUBHOUSE_MODE_SETTINGS, async (_event, settings: ClubhouseModeSettings, projectPath?: string) => {
    const previousEnabled = projectPath
      ? clubhouseModeSettings.isClubhouseModeEnabled(projectPath)
      : clubhouseModeSettings.getSettings().enabled;

    await clubhouseModeSettings.saveSettings(settings);

    const nowEnabled = projectPath
      ? clubhouseModeSettings.isClubhouseModeEnabled(projectPath)
      : settings.enabled;

    // On first enable: create default templates and enable git excludes
    if (!previousEnabled && nowEnabled && projectPath) {
      await ensureDefaultTemplates(projectPath);
      try {
        const provider = await resolveOrchestrator(projectPath);
        enableExclusions(projectPath, provider);
      } catch {
        // Orchestrator not available
      }
    }

    // On disable: remove git excludes
    if (previousEnabled && !nowEnabled && projectPath) {
      await disableExclusions(projectPath);
    }
  });
}
