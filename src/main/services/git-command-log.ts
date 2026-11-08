/**
 * Recent git commands agents ran through a shell tool, for the git watcher's
 * attribution (#2955). Fed from terminal hooks (hook-server) and chat
 * tool calls (git-watcher subscribes to the chat bus). Kept in memory for a
 * minute; nothing here touches the disk or spawns anything.
 */

import * as path from 'path';

export type GitVerb =
  | 'commit' | 'checkout' | 'switch' | 'push' | 'pull' | 'fetch'
  | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'reset' | 'am';

const VERBS: readonly string[] = [
  'commit', 'checkout', 'switch', 'push', 'pull', 'fetch',
  'merge', 'rebase', 'cherry-pick', 'revert', 'reset', 'am',
];

/** How long a git command counts toward attributing a ref change. */
export const GIT_ATTRIBUTION_WINDOW_MS = 60_000;

/** Longer commands are cut here before parsing; git calls past it are not seen. */
export const MAX_COMMAND_LENGTH = 4096;

/** Enough for many busy agents within the window. */
const MAX_RECORDS = 500;

/** Global options whose value is the next word (`git --git-dir x status`). */
const VALUE_OPTIONS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source']);

export interface GitCall {
  verb: GitVerb;
  /** The `-C <dir>` the call ran in, as written (relative to the shell's cwd). */
  dir?: string;
}

function unquote(token: string): string {
  const q = token[0];
  return (q === '"' || q === '\'') && token.length >= 2 && token.endsWith(q) ? token.slice(1, -1) : token;
}

function isGitToken(token: string): boolean {
  const t = token.toLowerCase();
  return t === 'git' || t === 'git.exe' || t.endsWith('/git') || t.endsWith('\\git') || t.endsWith('/git.exe') || t.endsWith('\\git.exe');
}

/**
 * The ref-moving git calls in a shell command, in order. Splits on shell
 * separators, finds `git` in each part, skips its global options (noting
 * `-C`), and takes the next word as the subcommand. Linear in the input;
 * no backtracking regex.
 */
export function gitCallsIn(command: string): GitCall[] {
  const text = command.length > MAX_COMMAND_LENGTH ? command.slice(0, MAX_COMMAND_LENGTH) : command;
  const out: GitCall[] = [];
  for (const part of text.split(/&&|\|\||[;|\n()]/)) {
    const tokens = part.split(/\s+/).filter(Boolean).map(unquote);
    let i = tokens.findIndex(isGitToken);
    if (i < 0) continue;
    let dir: string | undefined;
    for (i++; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '-C') {
        const next = tokens[++i];
        if (next) dir = dir && !path.isAbsolute(next) ? path.join(dir, next) : next;
        continue;
      }
      if (VALUE_OPTIONS.has(t)) {
        i++;
        continue;
      }
      if (t.startsWith('-')) continue;
      if (VERBS.includes(t)) out.push({ verb: t as GitVerb, ...(dir && { dir }) });
      break;
    }
  }
  return out;
}

/** The git subcommands in a shell command that can move refs or HEAD. */
export function gitVerbsIn(command: string): GitVerb[] {
  return [...new Set(gitCallsIn(command).map((c) => c.verb))];
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
  verb: GitVerb;
  /** Where the call ran: the tool's or hook's cwd, joined with any `-C`. Unset when nothing said. */
  cwd?: string;
  at: number;
  /**
   * The tool call's id, or else its command text: a call is noted once
   * though its pre and post hooks both carry it.
   */
  callKey: string;
  /** The kinds of change this call has been credited for; each kind takes it once. */
  credited: string[];
}

const records: GitCommandRecord[] = [];

function prune(now: number): void {
  let drop = 0;
  while (drop < records.length && now - records[drop].at > GIT_ATTRIBUTION_WINDOW_MS) drop++;
  if (records.length - drop > MAX_RECORDS) drop = records.length - MAX_RECORDS;
  if (drop > 0) records.splice(0, drop);
}

function callCwd(base: string | undefined, dir: string | undefined): string | undefined {
  if (!dir) return base;
  if (base) return path.resolve(base, dir);
  return path.isAbsolute(dir) ? dir : undefined;
}

/**
 * Note a tool call's input; records each ref-moving git call in it. `cwd` is
 * where the shell ran when the caller knows (a hook payload's cwd); the
 * input's own cwd wins. A call is noted once per `callId` (the tool call's
 * id), or without one, once per command text within the window.
 */
export function noteAgentToolCall(
  agentId: string,
  input: unknown,
  opts: { cwd?: string; callId?: string; at?: number } = {},
): void {
  const shell = shellCommandFrom(input);
  if (!shell) return;
  const calls = gitCallsIn(shell.command);
  if (calls.length === 0) return;
  const at = opts.at ?? Date.now();
  prune(at);
  const callKey = opts.callId ? `id:${opts.callId}` : `cmd:${shell.command.slice(0, MAX_COMMAND_LENGTH)}`;
  if (records.some((r) => r.agentId === agentId && r.callKey === callKey)) return;
  const base = shell.cwd ?? opts.cwd;
  for (const call of calls) {
    const cwd = callCwd(base, call.dir);
    records.push({ agentId, verb: call.verb, at, callKey, credited: [], ...(cwd && { cwd }) });
  }
}

/** Git calls within the attribution window and not after `now`, oldest first. */
export function recentGitCommands(now = Date.now()): readonly GitCommandRecord[] {
  prune(now);
  return records.filter((r) => r.at <= now && now - r.at <= GIT_ATTRIBUTION_WINDOW_MS);
}

/** For tests. */
export function resetGitCommandLog(): void {
  records.length = 0;
}
