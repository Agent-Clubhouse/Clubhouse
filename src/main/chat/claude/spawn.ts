import { spawn, type ChildProcess } from 'child_process';
import { resolveStructuredSpawn } from '../../orchestrators/adapters/structured-spawn';
import { cleanSpawnEnv, getShellEnvironment } from '../../util/shell';

/** Env for a chat-driven `claude`: the login shell's env plus overrides, minus inherited Claude markers. */
export function buildClaudeEnv(extra?: Record<string, string>): Record<string, string> {
  return cleanSpawnEnv({ ...getShellEnvironment(), ...extra });
}

/**
 * Spawn `claude` with piped stdio. Uses the structured spawn rules, so npm's
 * `claude.cmd` shim runs through cmd.exe on Windows and a command prefix is
 * honored.
 */
export function spawnClaude(opts: {
  binary: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  commandPrefix?: string;
}): ChildProcess {
  const cmd = resolveStructuredSpawn(opts.binary, opts.args, opts.commandPrefix);
  return spawn(cmd.binary, cmd.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: cmd.windowsVerbatimArguments,
  });
}
