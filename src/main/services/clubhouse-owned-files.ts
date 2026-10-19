/**
 * Clubhouse writes its own config into an agent's worktree when it starts the
 * agent: the MCP bridge entry (`.mcp.json` and the like) and, with the hook
 * server on, its hook entries (`.claude/settings.local.json` and the like).
 * Outside Clubhouse mode nothing git-excludes these files, so `git status`
 * shows them and a helper that did nothing read as having uncommitted work.
 *
 * Why the dispose checks filter instead of adding info/exclude entries:
 * `info/exclude` lives in the repository's common git dir, so a pattern added
 * for one worktree hides the same path in the user's main checkout and in every
 * other worktree. A project's own untracked `.mcp.json` would vanish from
 * `git status` everywhere. Excluding also does nothing for a project that
 * commits its own `.mcp.json`, where Clubhouse's entry shows as a modification.
 *
 * So a changed path counts as Clubhouse's only when all of these hold:
 *   - it is one of the config files Clubhouse writes (CLUBHOUSE_WRITTEN_FILES);
 *   - git reports it as untracked, added or modified, never deleted, renamed
 *     or conflicted;
 *   - with Clubhouse's own entries taken out of both, the file on disk equals
 *     the committed file (HEAD), or is empty when HEAD has no such file.
 * Anything else in the file (a server the user added, a permission, a changed
 * key, text that does not parse) keeps it counted as work, so a real edit
 * still holds a dispose.
 *
 * "Clubhouse's own entries" is matched strictly here, apart from the looser
 * matchers the config pipeline uses to clean up: a hook counts only when its
 * command is exactly the curl command buildHookCurlCommand writes, and it is
 * removed hook by hook, so a user's hook sharing a group with Clubhouse's
 * stays. The MCP entry counts only under the `clubhouse` key, in the shape
 * bridgeServerDef writes. A wrong "ours" here would let a dispose delete work.
 */
import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  CLUBHOUSE_FALLBACK_AGENT_ID_ENV,
  CLUBHOUSE_FALLBACK_PORT_ENV,
  stripClubhouseMcpToml,
} from './clubhouse-mcp/injection';

/**
 * Worktree-relative paths (git's `/` separators) of every config file a
 * provider has Clubhouse write: each provider's `conventions.mcpConfigFile`
 * and its hooks file (`configDir` + `hooksFile ?? localSettingsFile`).
 * clubhouse-owned-files.test.ts checks this against the providers.
 */
export const CLUBHOUSE_WRITTEN_FILES: readonly string[] = [
  '.mcp.json',                    // Claude Code MCP
  '.claude/settings.local.json',  // Claude Code hooks
  '.codex/config.toml',           // Codex MCP
  '.codex/hooks.json',            // Codex hooks
  '.github/mcp.json',             // Copilot MCP
  '.github/hooks/hooks.json',     // Copilot hooks
];

/** A changed path as git status reports it; `status` is the trimmed XY code. */
export interface ChangedPath {
  path: string;
  status: string;
}

/** Room for a long file list from `git status`; execFile's default is 1 MB. */
const STATUS_MAX_BUFFER = 64 * 1024 * 1024;

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf-8', maxBuffer: STATUS_MAX_BUFFER }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** The committed text of `rel` at HEAD, or null when HEAD has no such file. */
async function committedText(cwd: string, rel: string): Promise<string | null> {
  try {
    return await git(['show', `HEAD:${rel}`], cwd);
  } catch {
    // telemetry-exempt: no HEAD, or no such file at HEAD; both mean "not committed"
    return null;
  }
}

/** JSON with sorted keys, so key order never reads as a change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

// ── Strict matchers ──────────────────────────────────────────────────────

const ENV_PORT = String.raw`(?:\$\{CLUBHOUSE_HOOK_PORT\}|%CLUBHOUSE_HOOK_PORT%|\d{1,5})`;
const EVENT_SUFFIX = String.raw`(?:/[A-Za-z]+)?`;
/**
 * The command buildHookCurlCommand writes, POSIX and Windows forms, for the
 * hook server on 127.0.0.1. The agent id and nonce are always environment
 * references; only the port may be a literal (Clubhouse baked it before).
 */
const CLUBHOUSE_HOOK_COMMANDS = [
  new RegExp(
    String.raw`^cat \| curl -s -X POST http://127\.0\.0\.1:${ENV_PORT}/hook/\$\{CLUBHOUSE_AGENT_ID\}${EVENT_SUFFIX}` +
    String.raw` -H 'Content-Type: application/json' -H "X-Clubhouse-Nonce: \$\{CLUBHOUSE_HOOK_NONCE\}" --data-binary @- \|\| true$`,
  ),
  new RegExp(
    String.raw`^curl -s -X POST http://127\.0\.0\.1:${ENV_PORT}/hook/%CLUBHOUSE_AGENT_ID%${EVENT_SUFFIX}` +
    String.raw` -H "Content-Type: application/json" -H "X-Clubhouse-Nonce: %CLUBHOUSE_HOOK_NONCE%" -d @- \|\| \(exit /b 0\)$`,
  ),
];

export function isClubhouseHookCommand(command: unknown): boolean {
  return typeof command === 'string' && CLUBHOUSE_HOOK_COMMANDS.some((re) => re.test(command));
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(obj).every((k) => allowed.includes(k));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One hook exactly as a provider's writeHooksConfig writes it: Claude Code and
 * Codex `{ type, command, async?, timeout }`, Copilot `{ type, bash, timeoutSec }`.
 */
export function isStrictClubhouseHook(hook: unknown): boolean {
  if (!isRecord(hook) || hook.type !== 'command') return false;
  if ('bash' in hook) {
    return hasOnlyKeys(hook, ['type', 'bash', 'timeoutSec']) && isClubhouseHookCommand(hook.bash);
  }
  return hasOnlyKeys(hook, ['type', 'command', 'async', 'timeout']) && isClubhouseHookCommand(hook.command);
}

/**
 * `settings` without Clubhouse's hooks, hook by hook: a group keeps any hook
 * that isn't Clubhouse's, and is dropped only when nothing but Clubhouse's
 * hooks (and an empty matcher) is left in it.
 */
export function stripClubhouseHooksStrict(settings: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(settings.hooks)) return settings;
  const cleaned: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) {
      cleaned[event] = entries;
      continue;
    }
    const kept: unknown[] = [];
    for (const entry of entries) {
      if (isRecord(entry) && Array.isArray(entry.hooks)) {
        const userHooks = entry.hooks.filter((h) => !isStrictClubhouseHook(h));
        const onlyOurs = userHooks.length === 0
          && hasOnlyKeys(entry, ['hooks', 'matcher'])
          && (entry.matcher === undefined || entry.matcher === '');
        if (onlyOurs) continue;
        kept.push(userHooks.length === entry.hooks.length ? entry : { ...entry, hooks: userHooks });
      } else if (!isStrictClubhouseHook(entry)) {
        kept.push(entry);
      }
    }
    if (kept.length > 0) cleaned[event] = kept;
  }
  const result = { ...settings };
  if (Object.keys(cleaned).length > 0) result.hooks = cleaned;
  else delete result.hooks;
  return result;
}

/** The bridge entry exactly as bridgeServerDef writes it. */
export function isStrictClubhouseMcpEntry(entry: unknown): boolean {
  if (!isRecord(entry) || entry.command !== 'node') return false;
  if (!hasOnlyKeys(entry, ['command', 'args', 'env', 'env_vars'])) return false;
  const args = entry.args;
  if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== 'string') return false;
  if (!/(^|[\\/])clubhouse-mcp-bridge\.js$/.test(args[0])) return false;
  if (entry.env !== undefined) {
    if (!isRecord(entry.env) || !hasOnlyKeys(entry.env, [CLUBHOUSE_FALLBACK_PORT_ENV, CLUBHOUSE_FALLBACK_AGENT_ID_ENV])) return false;
  }
  if (entry.env_vars !== undefined) {
    if (!Array.isArray(entry.env_vars) || !entry.env_vars.every((v) => typeof v === 'string' && v.startsWith('CLUBHOUSE_'))) return false;
  }
  return true;
}

/** `config` without the Clubhouse bridge entry, which Clubhouse writes only under `clubhouse`. */
function stripClubhouseMcpStrict(config: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(config.mcpServers) || !isStrictClubhouseMcpEntry(config.mcpServers.clubhouse)) return config;
  const { clubhouse: _ours, ...servers } = config.mcpServers;
  return { ...config, mcpServers: servers };
}

/** A JSON config without Clubhouse's MCP and hook entries, or null when it doesn't parse as an object. */
function userJson(text: string, committed: boolean): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // telemetry-exempt: not JSON, so it is not a file Clubhouse wrote; it stays counted
    return null;
  }
  if (!isRecord(parsed)) return null;
  const rest = stripClubhouseHooksStrict(stripClubhouseMcpStrict(parsed));
  const servers = rest.mcpServers;
  if (isRecord(servers) && Object.keys(servers).length === 0) delete rest.mcpServers;
  // Clubhouse starts a new Copilot hooks file with `version: 1`.
  if (!committed && rest.version === 1) delete rest.version;
  return canonical(rest);
}

/** A TOML config without Clubhouse's MCP section, blank lines and trailing spaces ignored. */
function userToml(text: string): string {
  return stripClubhouseMcpToml(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** Whether every difference between the committed `rel` and the one on disk is Clubhouse's own entries. */
async function onlyClubhouseChanges(cwd: string, rel: string): Promise<boolean> {
  let current: string;
  try {
    current = await fsp.readFile(path.join(cwd, ...rel.split('/')), 'utf-8');
  } catch {
    // telemetry-exempt: unreadable, so it can't be shown to be Clubhouse's; it stays counted
    return false;
  }
  const base = await committedText(cwd, rel);
  if (rel.endsWith('.toml')) return userToml(current) === userToml(base ?? '');
  const now = userJson(current, base !== null);
  if (now === null) return false;
  const before = base === null ? canonical({}) : userJson(base, true);
  return before !== null && now === before;
}

function mayBeClubhouseOwned(change: ChangedPath): boolean {
  if (!CLUBHOUSE_WRITTEN_FILES.includes(change.path)) return false;
  return change.status === '??' || /^[MA]{1,2}$/.test(change.status);
}

/**
 * `changes` without the paths whose only change is Clubhouse's own config (see
 * the top of this file). `cwd` is the worktree the paths are relative to.
 */
export async function withoutClubhouseOwnedChanges<T extends ChangedPath>(cwd: string, changes: T[]): Promise<T[]> {
  if (!changes.some(mayBeClubhouseOwned)) return changes;
  const owned = await Promise.all(changes.map((c) => (mayBeClubhouseOwned(c) ? onlyClubhouseChanges(cwd, c.path) : false)));
  return changes.filter((_, i) => !owned[i]);
}

/** Parse `git status --porcelain` lines into changed paths. */
export function parsePorcelain(status: string): ChangedPath[] {
  return porcelainLines(status).map((line) => ({
    path: line.slice(3),
    status: line.slice(0, 2).trim(),
  }));
}

function porcelainLines(status: string): string[] {
  return status.split('\n').filter((line) => line.trim());
}

/** Whether an untracked folder git reports as a whole (`?? .claude/`) may hold a file Clubhouse writes. */
function holdsClubhouseFile(line: string): boolean {
  if (!line.startsWith('?? ') || !line.endsWith('/')) return false;
  const dir = line.slice(3);
  return CLUBHOUSE_WRITTEN_FILES.some((file) => file.startsWith(dir));
}

/**
 * `git status --porcelain` lines for the worktree at `cwd`, without the ones
 * that are only Clubhouse's config. Untracked folders are listed as git
 * normally does (one line each); only a folder that may hold one of
 * Clubhouse's files (.claude/, .codex/, .github/) is listed file by file, so
 * Clubhouse's file can be told apart from the user's next to it. Throws when
 * git fails: callers must not read that as a clean worktree.
 */
export async function uncommittedPorcelain(cwd: string): Promise<string[]> {
  const lines = porcelainLines(await git(['status', '--porcelain'], cwd));
  const expanded: string[] = [];
  for (const line of lines) {
    if (holdsClubhouseFile(line)) {
      const dir = line.slice(3);
      expanded.push(...porcelainLines(await git(['status', '--porcelain', '--untracked-files=all', '--', dir], cwd)));
    } else {
      expanded.push(line);
    }
  }
  const changes = expanded.map((line) => ({ line, path: line.slice(3), status: line.slice(0, 2).trim() }));
  return (await withoutClubhouseOwnedChanges(cwd, changes)).map((c) => c.line);
}
