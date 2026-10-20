import { execSync, execFile } from 'child_process';

let cachedShellEnv: Record<string, string> | null = null;

/** Parse raw `env` output into a key-value record */
function parseEnvOutput(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      env[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return env;
}

/** Source the user's login shell to get the full environment.
 *  Packaged macOS apps launched from Finder/Dock only get a minimal PATH.
 *  On Windows this isn't needed — the full environment is already available. */
function getShellEnv(): Record<string, string> {
  if (cachedShellEnv) return cachedShellEnv;

  if (process.platform === 'win32') {
    cachedShellEnv = cleanInheritedEnv({ ...process.env } as Record<string, string>);
    return cachedShellEnv;
  }

  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const raw = execSync(`${shell} -ilc 'env'`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    cachedShellEnv = cleanInheritedEnv({ ...process.env, ...parseEnvOutput(raw) } as Record<string, string>);
  } catch {
    cachedShellEnv = cleanInheritedEnv({ ...process.env } as Record<string, string>);
  }
  return cachedShellEnv;
}

/**
 * Returns the user's full shell environment, minus inherited Claude Code
 * host-session variables: use for spawning processes. Callers that merge in
 * overrides should still pass the result through cleanSpawnEnv.
 */
export function getShellEnvironment(): Record<string, string> {
  return getShellEnv();
}

/** Pre-warm the shell environment cache asynchronously.
 *  Call this early in app startup so the cache is populated before the first
 *  agent wake. Uses execFile (non-blocking) instead of execSync so it doesn't
 *  block the main process during startup. */
export function preWarmShellEnvironment(): void {
  if (cachedShellEnv || process.platform === 'win32') {
    // Already cached or not needed on Windows
    if (!cachedShellEnv && process.platform === 'win32') {
      cachedShellEnv = cleanInheritedEnv({ ...process.env } as Record<string, string>);
    }
    return;
  }

  const shell = process.env.SHELL || '/bin/zsh';
  execFile(shell, ['-ilc', 'env'], { encoding: 'utf-8', timeout: 5000 }, (err, stdout) => {
    // Don't overwrite if getShellEnv() was called synchronously while we were waiting
    if (cachedShellEnv) return;
    if (err) {
      cachedShellEnv = cleanInheritedEnv({ ...process.env } as Record<string, string>);
    } else {
      cachedShellEnv = cleanInheritedEnv({ ...process.env, ...parseEnvOutput(stdout) } as Record<string, string>);
    }
  });
}

/** Clear the cached shell environment so the next getShellEnvironment() call
 *  re-sources the user's login shell.  Useful when env vars may have changed
 *  since the app launched (e.g. user added an API key to their shell config). */
export function invalidateShellEnvironmentCache(): void {
  cachedShellEnv = null;
}

/**
 * Variables a Claude Code host session sets in its own environment. When
 * Clubhouse is launched from inside a Claude Code session (`npm start` in a
 * Claude Code terminal, or the app opened from a Claude desktop session), it
 * inherits them, and every agent it spawns would inherit them too. They
 * describe the host session, not the user's setup, so they are stripped from
 * every env Clubhouse builds for a child process.
 *
 * Exact names only, plus the prefixes below. User configuration the CLI reads
 * (CLAUDE_CONFIG_DIR, ANTHROPIC_*, CLAUDE_CODE_USE_BEDROCK / _VERTEX and their
 * region and model vars, CLAUDE_CODE_MAX_OUTPUT_TOKENS, proxies) must survive,
 * so this is deliberately not a CLAUDE_CODE_* wildcard.
 */
export const HOST_SESSION_ENV_VARS: readonly string[] = [
  // Nested-agent markers: the CLI refuses to start, or starts as a child of
  // the host, when it sees these.
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',

  // Session markers: they tie the agent to the host's session. An inherited
  // CLAUDE_CODE_CHILD_SESSION turns transcript saving off, which breaks
  // terminal-to-chat resume.
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_PID',

  // Host identity: the host app's binary, version, account and auth wiring.
  // The agent must use its own login (or CLAUDE_CONFIG_DIR profile).
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'CLAUDE_CODE_ACCOUNT_UUID',
  'CLAUDE_CODE_USER_EMAIL',

  // Host tool config: switches the host chose for its own session. They
  // change which tools and output the agent gets. The Agent SDK sets its own
  // CLAUDE_AGENT_SDK_VERSION / CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING when
  // Clubhouse's chat driver needs them.
  'CLAUDE_CODE_TERMINAL_MCP_TOOLS',
  'CLAUDE_CODE_REPORT_FINDINGS',
  'CLAUDE_CODE_STARTUP_FAILURE_RESULTS',
  'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES',
  'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_DISABLE_CRON',
  'CLAUDE_CODE_EAGER_FLUSH',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_AGENT_SDK_MCP_NO_PREFIX',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_PREVIEW_CLASSIFIER_FLOOR',
  'CLAUDE_EFFORT',
];

/**
 * Prefixes of host-session variables. CLAUDE_CODE_MESSAGING_* is the host's
 * IPC socket and token: an agent must never be able to reach the host's
 * messaging channel.
 */
export const HOST_SESSION_ENV_PREFIXES: readonly string[] = ['CLAUDE_CODE_MESSAGING_'];

const HOST_SESSION_ENV_SET = new Set(HOST_SESSION_ENV_VARS);

/** Whether `key` names a host-session variable (case-insensitive, for Windows). */
export function isHostSessionEnvVar(key: string): boolean {
  const upper = key.toUpperCase();
  return HOST_SESSION_ENV_SET.has(upper) || HOST_SESSION_ENV_PREFIXES.some((p) => upper.startsWith(p));
}

/**
 * Remove inherited Claude Code host-session variables (see
 * HOST_SESSION_ENV_VARS). Mutates and returns the given env object.
 */
export function cleanSpawnEnv<T extends Record<string, string | undefined>>(env: T): T {
  for (const key of Object.keys(env)) {
    if (isHostSessionEnvVar(key)) delete env[key];
  }
  return env;
}

/**
 * Per-agent variables Clubhouse sets on the CLI it spawns for one agent: its
 * identity, its MCP/hook nonce and the local ports it reports to. The nonce
 * authenticates MCP and hook calls as that agent, so it lives only in that
 * agent's process environment, never in a file (#2222).
 *
 * When Clubhouse itself runs under an agent (dogfooding: `npm start` in an
 * agent's terminal) it inherits that agent's values. They must not reach any
 * child Clubhouse spawns, so they are stripped from the inherited base env
 * (see cleanInheritedEnv). They are deliberately not in HOST_SESSION_ENV_VARS:
 * cleanSpawnEnv runs on envs that already carry the spawned agent's own
 * values, and those must survive.
 */
export const INHERITED_AGENT_ENV_VARS: readonly string[] = [
  'CLUBHOUSE_AGENT_ID',
  'CLUBHOUSE_HOOK_NONCE',
  'CLUBHOUSE_MCP_PORT',
  'CLUBHOUSE_HOOK_PORT',
];

const INHERITED_AGENT_ENV_SET = new Set(INHERITED_AGENT_ENV_VARS);

/**
 * Clean an env inherited from Clubhouse's own process (or login shell) before
 * any per-child overrides are merged in: removes host-session variables and
 * another agent's identity and nonce (INHERITED_AGENT_ENV_VARS). Mutates and
 * returns the given env object.
 */
export function cleanInheritedEnv<T extends Record<string, string | undefined>>(env: T): T {
  cleanSpawnEnv(env);
  for (const key of Object.keys(env)) {
    if (INHERITED_AGENT_ENV_SET.has(key.toUpperCase())) delete env[key];
  }
  return env;
}

/**
 * Env for a piped CLI child (chat drivers): the login shell's env plus
 * overrides, minus nested-agent markers. Overrides alone are not enough: a CLI
 * spawned without HOME, PATH or USER can't find its own login (Copilot answers
 * `session/new` with "Authentication required").
 */
export function buildCliSpawnEnv(extra?: Record<string, string>): Record<string, string> {
  return cleanSpawnEnv({ ...getShellEnvironment(), ...extra });
}

/** Vars a CLI needs to find its own install and login. */
const CLI_LOGIN_ENV_KEYS = ['HOME', 'PATH', 'USER', 'SHELL'] as const;

/**
 * Log-safe description of a child env: counts and key names, never values.
 * `missing` lists login-critical vars that are absent; non-empty there is the
 * usual cause of a CLI that works in the terminal but not in chat.
 */
export function summarizeSpawnEnv(env: Record<string, string | undefined>): { keyCount: number; missing: string[] } {
  const keys = Object.keys(env).filter((k) => env[k] !== undefined);
  const present = new Set(process.platform === 'win32' ? keys.map((k) => k.toUpperCase()) : keys);
  const critical = process.platform === 'win32' ? ['PATH', 'USERPROFILE'] : CLI_LOGIN_ENV_KEYS;
  return { keyCount: keys.length, missing: critical.filter((k) => !present.has(k)) };
}

/** Returns the platform-appropriate default shell. */
export function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/zsh';
}
