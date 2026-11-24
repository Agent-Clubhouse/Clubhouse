/**
 * Antigravity terminal status through hooks (#3795).
 *
 * From https://antigravity.google/docs/hooks/ (read 2026-11-23):
 * - Workspace hooks live in `.agents/hooks.json`: a map of hook names to event
 *   keys, each hook optionally `enabled`. Tool events (`PreToolUse`,
 *   `PostToolUse`) take `[{ matcher, hooks: [handler] }]`; other events take
 *   `[handler]`. A handler is `{ type: 'command', command, timeout }` (seconds).
 * - Handlers get camelCase JSON on stdin (`conversationId`, `toolCall`,
 *   `error`, `terminationReason`, ...) and answer JSON on stdout.
 *   `PreToolUse` must answer a `decision`; `allow` defers to the next hook or
 *   the default policy. `PostToolUse` answers `{}`. `Stop` continues only on
 *   `decision: "continue"`.
 * - Exit-code handling is not documented, so the command always exits 0 and
 *   always prints its answer, whatever the callback did.
 *
 * Clubhouse writes one named hook, `clubhouse-status`, only into a hooks
 * file it creates, and never edits a file that already exists. Its answers never block or change a tool call: `allow` for
 * PreToolUse, `{}` elsewhere. The payload's `transcriptPath` is never read.
 *
 * POSIX only for now: the docs don't say which shell runs a command on
 * Windows, so a command line that echoes JSON there is unverified (#3802).
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import type { NormalizedHookEvent } from '../types';
import { buildHookCurlCommand, validateHookUrl } from '../shared';
import { ANTIGRAVITY_PATHS, ANTIGRAVITY_STATUS_HOOK_NAME } from '../../../shared/providers/antigravity';

/** Seconds. Short, so a slow callback can't hold up a tool. */
export const ANTIGRAVITY_HOOK_TIMEOUT_SEC = 5;

export const ANTIGRAVITY_HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'] as const;
type HookEvent = (typeof ANTIGRAVITY_HOOK_EVENTS)[number];

/** Whether Clubhouse writes hooks on this platform. */
export function antigravityHooksSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

/** The answer each event's command prints. */
const ANSWERS: Record<HookEvent, string> = {
  SessionStart: '{}',
  PreToolUse: '{"decision":"allow"}',
  PostToolUse: '{}',
  Stop: '{}',
};

/**
 * The callback with its output discarded, then the fixed answer. The callback's
 * own `|| true` keeps the exit status 0 even when the app isn't listening.
 */
export function antigravityHookCommand(safeUrl: string, event: HookEvent): string {
  const curl = buildHookCurlCommand(safeUrl, `/${event}`);
  return `{ ${curl}; } >/dev/null 2>&1; printf '%s\\n' '${ANSWERS[event]}'`;
}

/** The `clubhouse-status` hook for `hookUrl`. */
export function buildAntigravityStatusHook(hookUrl: string): Record<string, unknown> {
  const safeUrl = validateHookUrl(hookUrl);
  const handler = (event: HookEvent) => ({ type: 'command', command: antigravityHookCommand(safeUrl, event), timeout: ANTIGRAVITY_HOOK_TIMEOUT_SEC });
  return {
    SessionStart: [handler('SessionStart')],
    PreToolUse: [{ matcher: '*', hooks: [handler('PreToolUse')] }],
    PostToolUse: [{ matcher: '*', hooks: [handler('PostToolUse')] }],
    Stop: [handler('Stop')],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function antigravityHooksPath(cwd: string): string {
  return path.join(cwd, ANTIGRAVITY_PATHS.hooks);
}

/** The exact file Clubhouse writes for `hookUrl`: its hook alone, two-space JSON, trailing newline. */
export function renderAntigravityHooksFile(hookUrl: string): string {
  return `${JSON.stringify({ [ANTIGRAVITY_STATUS_HOOK_NAME]: buildAntigravityStatusHook(hookUrl) }, null, 2)}\n`;
}

/** The callback URL in a generated SessionStart command, rebuilt with a placeholder port. */
const GENERATED_URL = /http:\/\/(127\.0\.0\.1|localhost):\$\{CLUBHOUSE_HOOK_PORT\}(\/[A-Za-z0-9/_-]*)\/\$\{CLUBHOUSE_AGENT_ID\}\/SessionStart /;

/**
 * Whether `text` is exactly a file Clubhouse generated, byte for byte, for
 * some valid callback URL. Ownership is proved by regenerating the bytes,
 * never by looking for marker strings, so a person's file (even one that
 * copies parts of ours, or adds a single space) is never claimed.
 */
export function isGeneratedAntigravityHooksFile(text: string): boolean {
  const match = GENERATED_URL.exec(text);
  if (!match) return false;
  const [, host, pathname] = match;
  try {
    return renderAntigravityHooksFile(validateHookUrl(`http://${host}:1${pathname}`)) === text;
  } catch {
    return false;
  }
}

/** Refuses a `.agents` folder or hooks file that is a symlink or resolves outside the worktree. */
async function assertContained(cwd: string, filePath: string): Promise<void> {
  const root = await fsp.realpath(cwd);
  for (const p of [path.dirname(filePath), filePath]) {
    let stat: import('fs').Stats;
    try {
      stat = await fsp.lstat(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw err;
    }
    if (stat.isSymbolicLink()) throw new Error(`${p} is a symbolic link. Clubhouse does not write through links. Antigravity hooks were not set up.`);
    const rel = path.relative(root, await fsp.realpath(p));
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${p} is outside the agent's folder. Antigravity hooks were not set up.`);
  }
}

export type AntigravityHooksWrite = 'created' | 'unchanged' | 'skipped_existing_file';

/**
 * Set up Clubhouse's status hook in `.agents/hooks.json`.
 *
 * Interim rule until a byte-preserving, receipt-backed merge exists (shared
 * with the MCP config, #3794): Clubhouse creates the file only when there is
 * none, with exactly its own bytes, and never edits a file that exists. A
 * person's existing hooks file is left untouched and the agent runs without
 * hook status (the reason is returned and logged by the caller).
 */
export async function writeAntigravityHooks(cwd: string, hookUrl: string): Promise<AntigravityHooksWrite> {
  const filePath = antigravityHooksPath(cwd);
  await assertContained(cwd, filePath);
  const ours = renderAntigravityHooksFile(hookUrl);
  let current: string | undefined;
  try {
    current = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new Error(`Cannot read Antigravity hooks at ${filePath}. Antigravity hooks were not set up.`);
  }
  if (current !== undefined) return current === ours ? 'unchanged' : 'skipped_existing_file';
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  // The folder may have been created just now; check again before writing.
  await assertContained(cwd, filePath);
  try {
    // 'wx': if the person creates the file meanwhile, theirs wins and nothing is written.
    await fsp.writeFile(filePath, ours, { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return 'skipped_existing_file';
    throw err;
  }
  return 'created';
}

/**
 * What cleanup may do with the current hooks file: delete it only when its
 * bytes are still exactly a file Clubhouse generated. Anything else, including
 * an edited copy, is kept as it is.
 */
export function antigravityHooksCleanup(text: string): 'delete' | 'keep' {
  return isGeneratedAntigravityHooksFile(text) ? 'delete' : 'keep';
}

/** Ids are passed as `--conversation <id>`; anything that could read as a flag is refused. */
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function validConversationId(value: unknown): string | undefined {
  return typeof value === 'string' && CONVERSATION_ID.test(value) ? value : undefined;
}

/**
 * A hook payload as Clubhouse's status hook reports it. The event name comes
 * from the callback URL (`hook_event_name`, set by the hook server), since
 * Antigravity's payload doesn't carry one.
 */
export function parseAntigravityHookEvent(raw: unknown): NormalizedHookEvent | null {
  if (!isPlainObject(raw)) return null;
  const event = raw.hook_event_name;
  const sessionId = validConversationId(raw.conversationId);
  const toolCall = isPlainObject(raw.toolCall) ? raw.toolCall : undefined;
  const toolName = typeof toolCall?.name === 'string' ? toolCall.name : undefined;
  const toolInput = isPlainObject(toolCall?.args) ? toolCall.args : undefined;
  const base = sessionId ? { sessionId } : {};
  switch (event) {
    case 'SessionStart':
      // Status-neutral: records the conversation id for resume.
      return sessionId ? { kind: 'notification', ...base } : null;
    case 'PreToolUse':
      return { kind: 'pre_tool', toolName, toolInput, ...base };
    case 'PostToolUse': {
      const error = raw.error;
      const failed = error !== undefined && error !== null && error !== '' && error !== false;
      return failed
        ? { kind: 'tool_error', toolName, toolInput, message: typeof error === 'string' ? error : undefined, ...base }
        : { kind: 'post_tool', toolName, toolInput, ...base };
    }
    case 'Stop': {
      const error = raw.error;
      const failed = typeof error === 'string' ? error.length > 0 : !!error;
      return {
        kind: 'stop',
        outcome: failed ? 'failed' : 'completed',
        message: typeof raw.terminationReason === 'string' ? raw.terminationReason : undefined,
        ...base,
      };
    }
    default:
      return null;
  }
}
