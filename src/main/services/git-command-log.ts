/**
 * Recent git commands agents ran through a shell tool, for the git watcher's
 * attribution (#2955). Fed from terminal hooks (hook-server) and chat
 * tool calls (git-watcher subscribes to the chat bus). Kept in memory for a
 * minute; nothing here touches the disk or spawns anything.
 */

export type GitVerb =
  | 'commit' | 'checkout' | 'switch' | 'push' | 'pull' | 'fetch'
  | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'reset' | 'am';

const VERBS: readonly GitVerb[] = [
  'commit', 'checkout', 'switch', 'push', 'pull', 'fetch',
  'merge', 'rebase', 'cherry-pick', 'revert', 'reset', 'am',
];

/** How long a git command counts toward attributing a ref change. */
export const GIT_ATTRIBUTION_WINDOW_MS = 60_000;

/** Enough for many busy agents within the window. */
const MAX_RECORDS = 500;

/**
 * `git`, then any global options (`-C dir`, `-c k=v`, `--no-pager`,
 * `--git-dir=x`), then the subcommand. Matches each git call in a chained
 * command such as `git add . && git commit -m x && git push`.
 */
const GIT_CALL_RE = /(?:^|[^\w.-])git(?:\.exe)?((?:\s+(?:-[cC]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w-]+(?:=\S+)?))*)\s+([a-z][a-z-]*)/g;

/** The git subcommands in a shell command that can move refs or HEAD. */
export function gitVerbsIn(command: string): GitVerb[] {
  const out = new Set<GitVerb>();
  for (const m of command.matchAll(GIT_CALL_RE)) {
    const verb = m[2] as GitVerb;
    if (VERBS.includes(verb)) out.add(verb);
  }
  return [...out];
}

/**
 * The shell command (and its cwd, when the tool says) in a tool call's input.
 * Claude, Copilot and Codex hooks use `{ command }`; Codex chat sends
 * `{ command, cwd }` where command may be an argv array.
 */
export function shellCommandFrom(input: unknown): { command: string; cwd?: string } | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  const raw = rec.command ?? rec.cmd;
  let command: string | null = null;
  if (typeof raw === 'string') command = raw;
  else if (Array.isArray(raw) && raw.every((p) => typeof p === 'string')) command = raw.join(' ');
  if (!command) return null;
  const cwd = typeof rec.cwd === 'string' && rec.cwd ? rec.cwd : undefined;
  return cwd ? { command, cwd } : { command };
}

export interface GitCommandRecord {
  agentId: string;
  verbs: readonly GitVerb[];
  /** The command's own cwd, when the tool reported one. */
  cwd?: string;
  at: number;
}

const records: GitCommandRecord[] = [];

function prune(now: number): void {
  let drop = 0;
  while (drop < records.length && now - records[drop].at > GIT_ATTRIBUTION_WINDOW_MS) drop++;
  if (records.length - drop > MAX_RECORDS) drop = records.length - MAX_RECORDS;
  if (drop > 0) records.splice(0, drop);
}

/** Note a tool call's input; records it only when it ran a ref-moving git command. */
export function noteAgentToolCall(agentId: string, input: unknown, at = Date.now()): void {
  const shell = shellCommandFrom(input);
  if (!shell) return;
  const verbs = gitVerbsIn(shell.command);
  if (verbs.length === 0) return;
  records.push({ agentId, verbs, at, ...(shell.cwd && { cwd: shell.cwd }) });
  prune(at);
}

/** Git commands within the attribution window, oldest first. */
export function recentGitCommands(now = Date.now()): readonly GitCommandRecord[] {
  prune(now);
  return records.filter((r) => now - r.at <= GIT_ATTRIBUTION_WINDOW_MS);
}

/** For tests. */
export function resetGitCommandLog(): void {
  records.length = 0;
}
