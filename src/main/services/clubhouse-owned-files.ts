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
 */
import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { stripClubhouseMcp, stripClubhouseMcpToml } from './clubhouse-mcp/injection';
import { stripClubhouseHooks } from './config-pipeline';

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

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf-8' }, (error, stdout) => {
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

/** A JSON config without Clubhouse's MCP and hook entries, or null when it doesn't parse as an object. */
function userJson(text: string, committed: boolean): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // telemetry-exempt: not JSON, so it is not a file Clubhouse wrote; it stays counted
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rest = stripClubhouseHooks(stripClubhouseMcp(parsed as Record<string, unknown>));
  const servers = rest.mcpServers;
  if (servers && typeof servers === 'object' && Object.keys(servers).length === 0) delete rest.mcpServers;
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
  return status.split('\n').filter((line) => line.trim()).map((line) => ({
    path: line.slice(3),
    status: line.slice(0, 2).trim(),
  }));
}
