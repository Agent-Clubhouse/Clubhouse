import * as os from 'os';
import * as path from 'path';

/**
 * Where Copilot keeps its sessions: `$COPILOT_HOME/session-state`, defaulting
 * to `~/.copilot/session-state` (the user's home on Windows too). A leading
 * `~` is expanded and blanks are ignored, as `resolveCopilotHome` does for the
 * terminal path: a profile's `COPILOT_HOME=~/x` must not make every session
 * look missing (#2296). Read from the env the CLI runs with.
 */
export function copilotSessionStateDir(env: Record<string, string | undefined>): string {
  const configured = [env.COPILOT_HOME, env.GH_COPILOT_CONFIG_DIR]
    .map((v) => v?.trim())
    .find((v): v is string => !!v);
  return path.join(expandHome(configured) ?? path.join(os.homedir(), '.copilot'), 'session-state');
}

function expandHome(p: string | undefined): string | undefined {
  if (p === '~') return os.homedir();
  if (p?.startsWith('~/') || p?.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}
