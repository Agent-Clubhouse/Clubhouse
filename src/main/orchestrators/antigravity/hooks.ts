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
 * Clubhouse writes one named hook, `clubhouse-status`, as a receipt-backed
 * member of the file (workspace-json), and never touches other names. Its answers never block or change a tool call: `allow` for
 * PreToolUse, `{}` elsewhere. The payload's `transcriptPath` is never read.
 *
 * POSIX only for now: the docs don't say which shell runs a command on
 * Windows, so a command line that echoes JSON there is unverified (#3802).
 */

import * as path from 'path';
import type { NormalizedHookEvent } from '../types';
import { buildHookCurlCommand, validateHookUrl } from '../shared';
import { ANTIGRAVITY_PATHS, ANTIGRAVITY_STATUS_HOOK_NAME } from '../../../shared/providers/antigravity';
import { insertOwnedMember, removeOwnedMember, type FileOptions, type RemoveResult } from './workspace-json';

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

/** Whether `file` is a worktree's `.agents/hooks.json`. */
export function isAntigravityHooksPath(file: string): boolean {
  const resolved = path.resolve(file);
  return path.basename(resolved) === 'hooks.json' && path.basename(path.dirname(resolved)) === ANTIGRAVITY_PATHS.configDir;
}

/**
 * Set up Clubhouse's `clubhouse-status` hook in `.agents/hooks.json`, through
 * the shared receipt-backed editor (workspace-json): every other byte of the
 * file is kept, a symlinked or escaping path is refused, a concurrent edit
 * refuses rather than overwrites, and a `clubhouse-status` that Clubhouse has
 * no committed receipt for (a person's own hook, or an exact copy of ours) is
 * a collision, never adopted. Throws AntigravityWorkspaceError on refusal,
 * with the file left as it was.
 */
export async function writeAntigravityHooks(cwd: string, hookUrl: string, options: FileOptions = {}): Promise<{ created: boolean }> {
  const { created } = await insertOwnedMember(cwd, ANTIGRAVITY_PATHS.hooks, {
    container: null,
    key: ANTIGRAVITY_STATUS_HOOK_NAME,
    valueJsonText: JSON.stringify(buildAntigravityStatusHook(hookUrl)),
  }, options);
  return { created };
}

/**
 * Remove Clubhouse's hook, by receipt only. Edits elsewhere in the file are
 * kept; a file Clubhouse created that nobody touched is deleted; anything it
 * can't prove it owns is left and reported for repair.
 */
export function removeAntigravityHooks(cwd: string, options: FileOptions = {}): Promise<RemoveResult> {
  return removeOwnedMember(cwd, ANTIGRAVITY_PATHS.hooks, { container: null, key: ANTIGRAVITY_STATUS_HOOK_NAME }, options);
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
