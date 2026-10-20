/**
 * The Windows pty backend and build number, passed to xterm.js as its
 * `windowsPty` option (#2320).
 *
 * ConPTY reflows and repaints on resize itself. Without the hint xterm also
 * reflows its own buffer, so lines are overwritten or land in scrollback
 * twice. Main knows the backend node-pty picks; it passes it to each window
 * as a launch argument so preload can expose it synchronously, before any
 * terminal is created.
 */
export interface WindowsPtyInfo {
  backend: 'conpty' | 'winpty';
  /** Windows build number, e.g. 22631. Omitted when it cannot be read. */
  buildNumber?: number;
}

export const WINDOWS_PTY_ARG = '--clubhouse-windows-pty=';

export function windowsPtyArg(info: WindowsPtyInfo): string {
  return `${WINDOWS_PTY_ARG}${info.backend}:${info.buildNumber ?? 0}`;
}

export function parseWindowsPtyArg(argv: readonly string[]): WindowsPtyInfo | undefined {
  const arg = argv.find((a) => a.startsWith(WINDOWS_PTY_ARG));
  if (!arg) return undefined;
  const [backend, build] = arg.slice(WINDOWS_PTY_ARG.length).split(':');
  if (backend !== 'conpty' && backend !== 'winpty') return undefined;
  const buildNumber = Number(build);
  return Number.isInteger(buildNumber) && buildNumber > 0 ? { backend, buildNumber } : { backend };
}
