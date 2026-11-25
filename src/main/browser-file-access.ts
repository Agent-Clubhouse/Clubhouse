/**
 * Whether Browser webviews may load file:// URLs (#3869).
 *
 * The one control is the Browser plugin's "Allow file:// URLs" setting
 * (Settings > Plugins > Browser). Its value is saved per scope in the host
 * plugin KV store as `settings-<scope>-browser.json`, where scope is `app` or a
 * project id. The renderer applies the setting for its own scope; the main
 * process can't tell which scope a webview belongs to, so it allows file://
 * when the setting is on in any scope and blocks it otherwise.
 *
 * Reads are synchronous because will-attach-webview and the navigation events
 * must decide before they return. They only happen for file:// targets, which
 * are rare. Any read or parse failure counts as "off".
 *
 * The retired `allowLocalFileWebviews` key in security-settings.json is not
 * read. Saved values stay on disk.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getGlobalPluginDataDir } from './services/plugin-storage';

/** The Browser plugin's setting key. Must match the plugin manifest. */
export const BROWSER_FILE_SETTING_KEY = 'allowFileProtocol';

/** The place users change it, for log and error text. */
export const BROWSER_FILE_SETTING_LOCATION = 'Settings > Plugins > Browser > Allow file:// URLs';

// Exact names only: `app` or a generated project id (`proj_<digits>_<base36>`).
// A looser pattern would read another plugin's file, such as `settings-app-my-browser.json`.
const BROWSER_SETTINGS_FILE = /^settings-(app|proj_[A-Za-z0-9_]+)-browser\.json$/;

export function browserSettingsKvDir(): string {
  return path.join(getGlobalPluginDataDir(), '_system', 'kv');
}

export function isBrowserFileAccessAllowed(kvDir: string = browserSettingsKvDir()): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(kvDir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!BROWSER_SETTINGS_FILE.test(name)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(kvDir, name), 'utf-8')) as unknown;
      if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>)[BROWSER_FILE_SETTING_KEY] === true) {
        return true;
      }
    } catch {
      // Unreadable or corrupt: treat this scope as off.
    }
  }
  return false;
}
