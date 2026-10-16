import { winQuoteArg } from '../../util/shell';
import { validateCommandPrefix } from '../../services/command-prefix-validation';

export interface StructuredSpawnCommand {
  binary: string;
  args: string[];
  /** Pass through to child_process.spawn — set when the line is pre-quoted for cmd.exe. */
  windowsVerbatimArguments?: boolean;
}

/** Batch shims (npm's `codex.cmd`, `copilot.cmd`, …) that only cmd.exe can run. */
const WINDOWS_BATCH_RE = /\.(cmd|bat)$/i;

/**
 * Resolve how a structured adapter spawns its CLI.
 *
 * - POSIX with a command prefix: `sh -c '<prefix> && exec "$@"'`, so the
 *   prefix runs first and exec hands the process over to the agent binary.
 * - Windows with a `.cmd`/`.bat` shim or a command prefix: route through
 *   `cmd.exe /d /s /c "<line>"`.  Since CVE-2024-27980 Node refuses to spawn
 *   batch files without a shell (EINVAL), and there is no `sh` for the
 *   prefix.  Each argument is quoted with winQuoteArg and passed verbatim,
 *   matching headless-manager's Windows launch.
 * - Otherwise the binary is spawned directly.
 */
export function resolveStructuredSpawn(
  binary: string,
  args: string[],
  commandPrefix?: string,
): StructuredSpawnCommand {
  if (process.platform === 'win32') {
    if (!commandPrefix && !WINDOWS_BATCH_RE.test(binary)) {
      return { binary, args };
    }
    // cmd.exe ends the command at a line break even inside quotes, which would
    // silently truncate the launch — fail loudly instead.
    if ([binary, ...args].some((a) => /[\r\n]/.test(a))) {
      throw new Error('Cannot launch a Windows batch shim with an argument containing a line break');
    }
    const cmdLine = [binary, ...args].map((a) => winQuoteArg(a)).join(' ');
    const fullCmd = commandPrefix ? `${validateCommandPrefix(commandPrefix)} & ${cmdLine}` : cmdLine;
    return {
      binary: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${fullCmd}"`],
      windowsVerbatimArguments: true,
    };
  }

  if (commandPrefix) {
    return {
      binary: 'sh',
      args: ['-c', `${validateCommandPrefix(commandPrefix)} && exec "$@"`, '_', binary, ...args],
    };
  }

  return { binary, args };
}
