import { execSync } from 'child_process';
import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { ArchInfo, BadgeSettings, LogEntry, LoggingSettings, NotificationSettings } from '../../shared/types';
import * as notificationService from '../services/notification-service';
import * as themeService from '../services/theme-service';
import * as orchestratorSettings from '../services/orchestrator-settings';
import * as headlessSettings from '../services/headless-settings';
import * as freeAgentSettings from '../services/free-agent-settings';
import * as clubhouseModeSettings from '../services/clubhouse-mode-settings';
import * as badgeSettings from '../services/badge-settings';
import { clipboardSettings } from './settings-handlers';
import * as autoUpdateService from '../services/auto-update-service';
import * as soundService from '../services/sound-service';
import * as sessionSettings from '../services/session-settings';
import * as logService from '../services/log-service';
import * as logSettings from '../services/log-settings';
import { isPreviewEligible } from '../services/preview-eligible';
import { ClipboardSettings, ClubhouseModeSettings, ExperimentalSettings, SoundEvent, SoundSettings, UpdateSettings } from '../../shared/types';
import { ensureDefaultTemplates, enableExclusions, disableExclusions } from '../services/materialization-service';
import { resolveOrchestrator } from '../services/agent-system';
import * as annexServer from '../services/annex-server';
import * as experimentalSettings from '../services/experimental-settings';
import { withValidatedArgs, stringArg, objectArg, numberArg, booleanArg } from './validation';
import { onMcpSettingsChanged } from './mcp-binding-handlers';
import { getLiveAgentsForUpdate, loadPendingResume, clearPendingResume, captureSessionState } from '../services/restart-session-service';
import * as ptyManager from '../services/pty-manager';
import * as agentSystem from '../services/agent-system';

export function registerAppHandlers(): void {
  ipcMain.handle(IPC.APP.OPEN_EXTERNAL_URL, withValidatedArgs(
    [stringArg()],
    (_event, url) => {
      return shell.openExternal(url);
    },
  ));

  ipcMain.handle(IPC.APP.GET_VERSION, () => {
    return app.getVersion();
  });

  ipcMain.handle(IPC.APP.IS_PREVIEW_ELIGIBLE, () => {
    return isPreviewEligible();
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

  ipcMain.handle(IPC.APP.SAVE_NOTIFICATION_SETTINGS, withValidatedArgs(
    [objectArg<NotificationSettings>()],
    async (_event, settings) => {
      await notificationService.saveSettings(settings);
    },
  ));

  ipcMain.handle(IPC.APP.SEND_NOTIFICATION, withValidatedArgs(
    [stringArg(), stringArg({ minLength: 0 }), booleanArg(), stringArg({ optional: true }), stringArg({ optional: true })],
    (_event, title, body, silent, agentId, projectId) => {
      notificationService.sendNotification(title, body, silent, agentId, projectId);
    },
  ));

  ipcMain.handle(IPC.APP.CLOSE_NOTIFICATION, withValidatedArgs(
    [stringArg(), stringArg()],
    (_event, agentId, projectId) => {
      notificationService.closeNotification(agentId, projectId);
    },
  ));

  ipcMain.handle(IPC.APP.GET_THEME, () => {
    return themeService.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_THEME, withValidatedArgs(
    [objectArg<{ themeId: string }>({
      validate: (v, name) => {
        if (typeof v.themeId !== 'string' || !v.themeId) throw new Error(`${name}.themeId must be a non-empty string`);
      },
    })],
    async (_event, settings) => {
      await themeService.saveSettings(settings as any);
      annexServer.broadcastThemeChanged();
    },
  ));

  // Update the Windows title bar overlay colors on ALL windows when the theme changes
  ipcMain.handle(IPC.APP.UPDATE_TITLE_BAR_OVERLAY, withValidatedArgs(
    [objectArg<{ color: string; symbolColor: string }>({
      validate: (v, name) => {
        if (typeof v.color !== 'string') throw new Error(`${name}.color must be a string`);
        if (typeof v.symbolColor !== 'string') throw new Error(`${name}.symbolColor must be a string`);
      },
    })],
    (_event, colors) => {
      if (process.platform !== 'win32') return;
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.setTitleBarOverlay({
            color: colors.color,
            symbolColor: colors.symbolColor,
          });
        }
      }
    },
  ));

  ipcMain.handle(IPC.APP.GET_ORCHESTRATOR_SETTINGS, () => {
    return orchestratorSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_ORCHESTRATOR_SETTINGS, withValidatedArgs(
    [objectArg<orchestratorSettings.OrchestratorSettings>()],
    async (_event, settings) => {
      await orchestratorSettings.saveSettings(settings);
    },
  ));

  ipcMain.handle(IPC.APP.GET_HEADLESS_SETTINGS, () => {
    return headlessSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_HEADLESS_SETTINGS, withValidatedArgs(
    [objectArg<headlessSettings.HeadlessSettings>()],
    async (_event, settings) => {
      await headlessSettings.saveSettings(settings);
    },
  ));

  ipcMain.handle(IPC.APP.GET_FREE_AGENT_SETTINGS, () => {
    return freeAgentSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_FREE_AGENT_SETTINGS, withValidatedArgs(
    [objectArg<freeAgentSettings.FreeAgentSettings>()],
    async (_event, settings) => {
      await freeAgentSettings.saveSettings(settings);
    },
  ));

  ipcMain.handle(IPC.APP.GET_BADGE_SETTINGS, () => {
    return badgeSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_BADGE_SETTINGS, withValidatedArgs(
    [objectArg<BadgeSettings>()],
    async (_event, settings) => {
      await badgeSettings.saveSettings(settings);
    },
  ));

  // Clipboard settings are now managed via createManagedSettings() in settings-handlers.ts.
  // Legacy IPC channels preserved for backward compatibility with any external consumers.
  ipcMain.handle(IPC.APP.GET_CLIPBOARD_SETTINGS, () => {
    return clipboardSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_CLIPBOARD_SETTINGS, withValidatedArgs(
    [objectArg<ClipboardSettings>()],
    async (_event, settings) => {
      await clipboardSettings.saveSettings(settings);
    },
  ));

  // Read image from the system clipboard using Electron's native API.
  // navigator.clipboard.read() is unreliable for images in Electron,
  // so we use the main-process clipboard module directly.
  ipcMain.handle(IPC.APP.READ_CLIPBOARD_IMAGE, () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const png = image.toPNG();
    return { base64: png.toString('base64'), mimeType: 'image/png' };
  });

  ipcMain.handle(IPC.APP.SET_DOCK_BADGE, withValidatedArgs(
    [numberArg({ integer: true, min: 0 })],
    (_event, count) => {
      if (process.platform === 'darwin') {
        app.dock.setBadge(count > 0 ? String(count) : '');
      } else {
        app.setBadgeCount(count);
      }
    },
  ));

  // --- Auto-update ---
  ipcMain.handle(IPC.APP.GET_UPDATE_SETTINGS, () => {
    return autoUpdateService.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_UPDATE_SETTINGS, withValidatedArgs(
    [objectArg<UpdateSettings>()],
    async (_event, settings) => {
      await autoUpdateService.saveSettings(settings);
      if (settings.autoUpdate) {
        await autoUpdateService.startPeriodicChecks();
      } else {
        autoUpdateService.stopPeriodicChecks();
      }
    },
  ));

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
  ipcMain.on(IPC.LOG.LOG_WRITE, withValidatedArgs(
    [objectArg<LogEntry>()],
    (_event, entry) => {
      logService.log(entry);
    },
  ));

  ipcMain.handle(IPC.LOG.GET_LOG_SETTINGS, () => {
    return logSettings.getSettings();
  });

  ipcMain.handle(IPC.LOG.SAVE_LOG_SETTINGS, withValidatedArgs(
    [objectArg<LoggingSettings>()],
    async (_event, settings) => {
      await logSettings.saveSettings(settings);
    },
  ));

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

  ipcMain.handle(IPC.APP.SAVE_SOUND_SETTINGS, withValidatedArgs(
    [objectArg<SoundSettings>()],
    async (_event, settings) => {
      await soundService.saveSettings(settings);
    },
  ));

  ipcMain.handle(IPC.APP.LIST_SOUND_PACKS, () => {
    return soundService.getAllSoundPacks();
  });

  ipcMain.handle(IPC.APP.IMPORT_SOUND_PACK, () => {
    return soundService.importSoundPack();
  });

  ipcMain.handle(IPC.APP.DELETE_SOUND_PACK, withValidatedArgs(
    [stringArg()],
    (_event, packId) => {
      return soundService.deleteSoundPack(packId);
    },
  ));

  ipcMain.handle(IPC.APP.GET_SOUND_DATA, withValidatedArgs(
    [stringArg(), stringArg()],
    (_event, packId, event) => {
      return soundService.getSoundData(packId, event as SoundEvent);
    },
  ));

  // --- Session Settings ---
  ipcMain.handle(IPC.APP.GET_SESSION_SETTINGS, () => {
    return sessionSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_SESSION_SETTINGS, withValidatedArgs(
    [objectArg<sessionSettings.SessionSettings>()],
    async (_event, settings) => {
      await sessionSettings.saveSettings(settings);
    },
  ));

  // --- Clubhouse Mode ---
  ipcMain.handle(IPC.APP.GET_CLUBHOUSE_MODE_SETTINGS, () => {
    return clubhouseModeSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_CLUBHOUSE_MODE_SETTINGS, withValidatedArgs(
    [objectArg<ClubhouseModeSettings>(), stringArg({ optional: true })],
    async (_event, settings, projectPath) => {
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

      // Clubhouse Mode affects MCP fallback — lazily start bridge if needed
      onMcpSettingsChanged();
    },
  ));

  // --- App Restart ---
  ipcMain.handle(IPC.APP.RESTART, () => {
    app.relaunch();
    app.exit(0);
  });

  // --- Experimental Settings ---
  ipcMain.handle(IPC.APP.GET_EXPERIMENTAL_SETTINGS, () => {
    return experimentalSettings.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_EXPERIMENTAL_SETTINGS, withValidatedArgs(
    [objectArg<ExperimentalSettings>()],
    async (_event, settings) => {
      await experimentalSettings.saveSettings(settings);
    },
  ));

  // --- Session resume on update ---

  ipcMain.handle(IPC.APP.GET_LIVE_AGENTS_FOR_UPDATE, () => {
    return getLiveAgentsForUpdate();
  });

  ipcMain.handle(IPC.APP.GET_PENDING_RESUMES, async () => {
    // Read-once: load the state, then clear the file so it won't be
    // re-read on a subsequent call or crash-restart loop.
    const state = await loadPendingResume();
    if (state) {
      await clearPendingResume();
    }
    return state;
  });

  ipcMain.handle(IPC.APP.RESUME_MANUAL_AGENT, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ optional: true })],
    async (_event, agentId, projectPath, sessionId) => {
      await agentSystem.spawnAgent({
        agentId,
        projectPath,
        cwd: projectPath,
        kind: 'durable',
        resume: true,
        sessionId: sessionId || undefined,
      });
    },
  ));

  ipcMain.handle(IPC.APP.RESOLVE_WORKING_AGENT, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, agentId, action) => {
      if (action === 'interrupt') {
        ptyManager.write(agentId, '\x03');
      } else if (action === 'kill') {
        ptyManager.kill(agentId);
      }
    },
  ));

  ipcMain.handle(IPC.APP.CONFIRM_UPDATE_RESTART, withValidatedArgs(
    [objectArg<{ agentNames: Record<string, string>; agentMeta?: Record<string, unknown> }>()],
    async (_event, data) => {
      const agentNames = new Map(Object.entries(data.agentNames));

      let agentMeta: Map<string, { kind: 'durable' | 'quick'; mission?: string; model?: string; worktreePath?: string; permissionMode?: import('../../shared/types').FreeAgentPermissionMode }> | undefined;
      if (data.agentMeta) {
        agentMeta = new Map(Object.entries(data.agentMeta)) as typeof agentMeta;
      }

      await captureSessionState(agentNames, agentMeta);

      const { restoreAll } = await import('../services/config-pipeline');
      const { flushAllAgentConfigs } = await import('../services/agent-config');
      await flushAllAgentConfigs();
      restoreAll();

      await autoUpdateService.applyUpdate();
    },
  ));

  // Dev-only: simulate update restart to test session resume flow.
  // Guarded by app.isPackaged — this handler is a no-op in production builds.
  if (!app.isPackaged) {
    ipcMain.handle(IPC.APP.DEV_SIMULATE_UPDATE_RESTART, withValidatedArgs(
      [objectArg<{ agentNames: Record<string, string>; agentMeta?: Record<string, unknown> }>()],
      async (_event, data) => {
        const agentNames = new Map(Object.entries(data.agentNames));

        let agentMeta: Map<string, { kind: 'durable' | 'quick'; mission?: string; model?: string; worktreePath?: string; permissionMode?: import('../../shared/types').FreeAgentPermissionMode }> | undefined;
        if (data.agentMeta) {
          agentMeta = new Map(Object.entries(data.agentMeta)) as typeof agentMeta;
        }

        await captureSessionState(agentNames, agentMeta);

        const { restoreAll } = await import('../services/config-pipeline');
        const { flushAllAgentConfigs } = await import('../services/agent-config');
        await flushAllAgentConfigs();
        restoreAll();

        // In dev mode, app.relaunch() + app.exit() kills the Forge dev server.
        // Instead, kill all PTY sessions and reload the renderer window —
        // this simulates the "restart" without killing the parent process.
        const { killAll } = await import('../services/pty-manager');
        await killAll();

        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.reload();
        }
      },
    ));
  }
}
