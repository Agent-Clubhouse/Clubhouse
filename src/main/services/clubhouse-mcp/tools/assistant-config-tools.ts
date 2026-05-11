import * as fsp from 'fs/promises';
import * as path from 'path';
import { app, BrowserWindow } from 'electron';
import { registerMcpCommand, toCommandId } from '../mcp-command-adapter';
import * as themeService from '../../theme-service';
import { BUILTIN_THEMES } from '../../../../renderer/themes';
import { getPluginThemes } from '../../plugin-theme-store';
import { IPC } from '../../../../shared/ipc-channels';
import { requireString } from './validation';

/** Keys the assistant is permitted to modify via update_settings. */
const SETTINGS_ALLOWLIST = new Set([
  'theme', 'themeId',
  'soundEnabled', 'soundVolume', 'soundPack',
  'notificationEnabled', 'notificationSound',
  'zoomLevel',
  'fontSize', 'fontFamily', 'uiFontFamily',
  'showMinimap', 'minimapScale',
  'sidebarWidth', 'sidebarCollapsed',
  'showLineNumbers', 'wordWrap', 'tabSize',
  'terminalFontSize', 'terminalFontFamily',
  'windowBounds',
  'locale', 'language',
  'autoUpdate', 'updateChannel',
  'telemetryEnabled',
]);

/** Register settings and theme read/write tools. */
export function registerConfigTools(): void {

// ── Plugin & Settings Tools ────────────────────────────────────────────────

registerMcpCommand({
  id: toCommandId('assistant', 'get_settings'),
  category: 'assistant',
  label: 'Get Settings',
  description: 'Get current Clubhouse app settings (theme, notifications, etc.).',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  targetKind: 'assistant',
  nameSuffix: 'get_settings',
  handler: async (_targetId, _agentId, _args) => {
    // Settings are managed via renderer stores. For the main process,
    // read the settings file from the standard location.
    try {
      const settingsPath = path.join(app.getPath('userData'), 'settings.json');
      const raw = await fsp.readFile(settingsPath, 'utf-8');
      return {
        content: [{ type: 'text', text: raw }],
      };
    } catch {
      return {
        content: [{ type: 'text', text: '{}' }],
      };
    }
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'list_themes'),
  category: 'assistant',
  label: 'List Themes',
  description:
    'List all available themes with their IDs, names, and types (dark/light). ' +
    'Use the theme ID with update_settings(key: "theme", value: "<id>") to change the theme.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  targetKind: 'assistant',
  nameSuffix: 'list_themes',
  handler: async () => {
    const currentSettings = themeService.getSettings() || { themeId: 'catppuccin-mocha' };

    // Combine builtin themes (available directly in main) with plugin-contributed
    // themes synced from the renderer via IPC.
    const builtinThemes = Object.values(BUILTIN_THEMES).map((t) => ({
      id: t.id,
      name: t.name,
      type: t.type,
    }));
    const pluginThemes = getPluginThemes() ?? [];
    const themes = [...builtinThemes, ...pluginThemes];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          currentTheme: currentSettings.themeId,
          availableThemes: themes,
        }, null, 2),
      }],
    };
  },
});

// ── Settings Write Tool ────────────────────────────────────────────────────

registerMcpCommand({
  id: toCommandId('assistant', 'update_settings'),
  category: 'assistant',
  label: 'Update Settings',
  description:
    'Update a Clubhouse app setting. Reads the current settings, merges the update, and writes back.',
  inputSchema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: `The settings key to update. Allowed keys: ${[...SETTINGS_ALLOWLIST].join(', ')}.`,
      },
      value: {
        type: 'string',
        description: 'The new value (as a JSON string for non-string values, e.g. "true", "42", or \'"dark"\').',
      },
    },
    required: ['key', 'value'],
  },
  targetKind: 'assistant',
  nameSuffix: 'update_settings',
  handler: async (_targetId, _agentId, args) => {
    const key = requireString(args, 'key');
    const rawValue = requireString(args, 'value');

    if (!SETTINGS_ALLOWLIST.has(key)) {
      return {
        content: [{ type: 'text', text: `Setting "${key}" is not in the allowed list. Allowed keys: ${[...SETTINGS_ALLOWLIST].join(', ')}.` }],
        isError: true,
      };
    }

    try {
      // Try to parse the value as JSON (for booleans, numbers, objects)
      let value: unknown;
      try {
        value = JSON.parse(rawValue);
      } catch {
        value = rawValue; // Use as plain string
      }

      // Theme changes use the dedicated theme service and notify the renderer
      if (key === 'theme' || key === 'themeId') {
        const themeId = String(value);
        await themeService.saveSettings({ themeId } as any);
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(IPC.APP.THEME_CHANGED);
        }
        return {
          content: [{ type: 'text', text: `Theme updated to "${themeId}". Applied immediately.` }],
        };
      }

      // All other settings go to the general settings file
      const settingsPath = path.join(app.getPath('userData'), 'settings.json');
      let settings: Record<string, unknown> = {};
      try {
        const raw = await fsp.readFile(settingsPath, 'utf-8');
        settings = JSON.parse(raw);
      } catch {
        // File doesn't exist or is invalid — start fresh
      }

      settings[key] = value;
      await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      return {
        content: [{ type: 'text', text: `Setting "${key}" updated to ${JSON.stringify(value)}.` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to update settings: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
});

}
