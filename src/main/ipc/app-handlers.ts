import { execSync } from 'child_process';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { ArchInfo, BadgeSettings, LogEntry, LoggingSettings, NotificationSettings } from '../../shared/types';
import * as notificationService from '../services/notification-service';
import * as themeService from '../services/theme-service';
import * as orchestratorSettings from '../services/orchestrator-settings';
import * as headlessSettings from '../services/headless-settings';
import * as badgeSettings from '../services/badge-settings';
import * as autoUpdateService from '../services/auto-update-service';
import * as logService from '../services/log-service';
import * as logSettings from '../services/log-settings';
import { UpdateSettings } from '../../shared/types';

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

  ipcMain.handle(IPC.APP.SAVE_NOTIFICATION_SETTINGS, (_event, settings: NotificationSettings) => {
    notificationService.saveSettings(settings);
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

  ipcMain.handle(IPC.APP.SAVE_THEME, (_event, settings: { themeId: string }) => {
    themeService.saveSettings(settings as any);
  });

  // Update the Windows title bar overlay colors when the theme changes
  ipcMain.handle(IPC.APP.UPDATE_TITLE_BAR_OVERLAY, (_event, colors: { color: string; symbolColor: string }) => {
    if (process.platform !== 'win32') return;
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (win) {
      win.setTitleBarOverlay({
        color: colors.color,
        symbolColor: colors.symbolColor,
      });
    }
  });

  ipcMain.handle(IPC.APP.GET_ORCHESTRATOR_SETTINGS, () => {
    return orchestratorSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_ORCHESTRATOR_SETTINGS, (_event, settings: orchestratorSettings.OrchestratorSettings) => {
    orchestratorSettings.saveSettings(settings);
  });

  ipcMain.handle(IPC.APP.GET_HEADLESS_SETTINGS, () => {
    return headlessSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_HEADLESS_SETTINGS, (_event, settings: headlessSettings.HeadlessSettings) => {
    headlessSettings.saveSettings(settings);
  });

  ipcMain.handle(IPC.APP.GET_BADGE_SETTINGS, () => {
    return badgeSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_BADGE_SETTINGS, (_event, settings: BadgeSettings) => {
    badgeSettings.saveSettings(settings);
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

  ipcMain.handle(IPC.APP.SAVE_UPDATE_SETTINGS, (_event, settings: UpdateSettings) => {
    autoUpdateService.saveSettings(settings);
    if (settings.autoUpdate) {
      autoUpdateService.startPeriodicChecks();
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

  ipcMain.handle(IPC.APP.GET_PENDING_RELEASE_NOTES, () => {
    return autoUpdateService.getPendingReleaseNotes();
  });

  ipcMain.handle(IPC.APP.CLEAR_PENDING_RELEASE_NOTES, () => {
    autoUpdateService.clearPendingReleaseNotes();
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

  ipcMain.handle(IPC.LOG.SAVE_LOG_SETTINGS, (_event, settings: LoggingSettings) => {
    logSettings.saveSettings(settings);
  });

  ipcMain.handle(IPC.LOG.GET_LOG_NAMESPACES, () => {
    return logService.getNamespaces();
  });

  ipcMain.handle(IPC.LOG.GET_LOG_PATH, () => {
    return logService.getLogPath();
  });
}
