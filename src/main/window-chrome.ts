import type { BrowserWindowConstructorOptions } from 'electron';
import { getSettings as getExperimentalSettings } from './services/experimental-settings';
import { NEW_CHROME_FLAG } from '../shared/chrome-flag';

/**
 * Window chrome per platform (docs/chrome-redesign-spec.md §4.7).
 *
 * - macOS: `hiddenInset`, keeping the traffic lights.
 * - Windows: `titleBarOverlay`, the themed controls over the app's title bar.
 * - Linux: the native frame in the legacy layout. In the new layout, the same
 *   overlay as Windows, which removes the double title bar.
 */

let cachedNewChrome: boolean | undefined;

/**
 * Whether this session uses the new chrome layout (experimental flag). Read
 * once, so the main window and every popout agree even if the setting changes
 * mid-session; the switch takes effect on the next launch.
 */
export function newChromeEnabled(): boolean {
  if (cachedNewChrome === undefined) {
    try {
      cachedNewChrome = getExperimentalSettings()[NEW_CHROME_FLAG] === true;
    } catch {
      // Unreadable settings: start on the legacy layout, as the renderer would.
      cachedNewChrome = false;
    }
  }
  return cachedNewChrome;
}

/** Test hook: forget the cached flag. */
export function resetNewChromeCacheForTests(): void {
  cachedNewChrome = undefined;
}

/** Whether windows on this platform draw their controls as a title-bar overlay. */
export function usesTitleBarOverlay(platform: NodeJS.Platform, newChrome: boolean): boolean {
  return platform === 'win32' || (platform === 'linux' && newChrome);
}

export function titleBarOptions(
  platform: NodeJS.Platform,
  newChrome: boolean,
  colors: { mantle: string; text: string },
): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay'> {
  if (usesTitleBarOverlay(platform, newChrome)) {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: colors.mantle, symbolColor: colors.text, height: 38 },
    };
  }
  return { titleBarStyle: 'hiddenInset' };
}
