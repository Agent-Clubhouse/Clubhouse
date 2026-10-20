import * as os from 'os';
import { type WindowsPtyInfo, windowsPtyArg } from '../../shared/windows-pty';

/** node-pty uses ConPTY from this build on when `useConpty` is unset. */
const CONPTY_MIN_BUILD = 18309;

/**
 * The backend node-pty picks for pty-manager's spawns (which never set
 * `useConpty`), using the same build-number parse as node-pty's
 * `WindowsPtyAgent`. Undefined off Windows.
 */
export function detectWindowsPty(
  platform: NodeJS.Platform = process.platform,
  release: string = os.release(),
): WindowsPtyInfo | undefined {
  if (platform !== 'win32') return undefined;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(release);
  const buildNumber = match ? parseInt(match[3], 10) : 0;
  const backend = buildNumber >= CONPTY_MIN_BUILD ? 'conpty' : 'winpty';
  return buildNumber > 0 ? { backend, buildNumber } : { backend };
}

/** Launch arguments that hand the pty backend to a window's preload. */
export function windowsPtyLaunchArgs(): string[] {
  const info = detectWindowsPty();
  return info ? [windowsPtyArg(info)] : [];
}
