import type { ITerminalOptions } from '@xterm/xterm';

/**
 * xterm options for a terminal attached to a PTY on this machine. On Windows
 * this tells xterm the pty is ConPTY (or winpty) so it does not reflow on
 * resize on top of ConPTY's own reflow (#2320). Empty elsewhere.
 *
 * Remote (Annex) terminals must not use this: their PTY runs on the
 * satellite, whose platform is not known here.
 */
export function localWindowsPtyOptions(): Pick<ITerminalOptions, 'windowsPty'> {
  const info = window.clubhouse.windowsPty;
  return info ? { windowsPty: { ...info } } : {};
}
