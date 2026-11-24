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
 * Clubhouse adds one named hook, `clubhouse-status`, and never touches other
 * names. Its answers never block or change a tool call: `allow` for
 * PreToolUse, `{}` elsewhere. The payload's `transcriptPath` is never read.
 *
 * POSIX only for now: the docs don't say which shell runs a command on
 * Windows, so a command line that echoes JSON there is unverified (#3802).
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
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

/**
 * Parse the workspace hooks file. Missing is `{}`. Anything that isn't a JSON
 * object (including a read error) throws, and the file is left as it is: an
 * ambiguous user file is never treated as empty and overwritten.
 */
async function readHooksDocument(filePath: string): Promise<{ doc: Record<string, unknown>; existed: boolean }> {
  let text: string;
  try {
    text = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { doc: {}, existed: false };
    throw new Error(`Cannot read Antigravity hooks at ${filePath}. Fix file access and restart the agent.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error(`Invalid JSON in Antigravity hooks at ${filePath}. Repair the file and restart the agent. Clubhouse did not modify it.`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid Antigravity hooks at ${filePath}. Expected an object of named hooks. Clubhouse did not modify it.`);
  }
  return { doc: parsed, existed: true };
}

/**
 * Merge `clubhouse-status` into `.agents/hooks.json`. Every other named hook,
 * and the file's other keys, stay as they are. Writes only on a change.
 * Snapshot and restore of the whole file belong to the config pipeline.
 */
export async function writeAntigravityHooks(cwd: string, hookUrl: string): Promise<void> {
  const filePath = antigravityHooksPath(cwd);
  const { doc } = await readHooksDocument(filePath);
  const ours = buildAntigravityStatusHook(hookUrl);
  const existing = doc[ANTIGRAVITY_STATUS_HOOK_NAME];
  if (isDeepStrictEqual(existing, ours)) return;
  if (existing !== undefined && !isClubhouseStatusHook(existing)) {
    throw new Error(`${filePath} already has a hook named "${ANTIGRAVITY_STATUS_HOOK_NAME}" that Clubhouse did not write. Rename it and restart the agent. Clubhouse did not modify the file.`);
  }
  const merged = { ...doc, [ANTIGRAVITY_STATUS_HOOK_NAME]: ours };
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
}

/**
 * Whether a `clubhouse-status` value is one Clubhouse wrote: every handler
 * command is a Clubhouse callback (it sends the per-launch nonce header).
 * A person's own hook under that name is never claimed.
 */
export function isClubhouseStatusHook(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const commands: unknown[] = [];
  for (const [key, entries] of Object.entries(value)) {
    if (!(ANTIGRAVITY_HOOK_EVENTS as readonly string[]).includes(key) || !Array.isArray(entries)) return false;
    for (const entry of entries) {
      if (!isPlainObject(entry)) return false;
      if (Array.isArray(entry.hooks)) commands.push(...entry.hooks.map((h) => (isPlainObject(h) ? h.command : undefined)));
      else commands.push(entry.command);
    }
  }
  return commands.length > 0 && commands.every((c) => typeof c === 'string' && c.includes('X-Clubhouse-Nonce') && c.includes('CLUBHOUSE_AGENT_ID'));
}

/** The document without Clubhouse's `clubhouse-status`; the same object when it has none (or the person's own). */
export function stripAntigravityStatusHook(doc: Record<string, unknown>): Record<string, unknown> {
  if (!isClubhouseStatusHook(doc[ANTIGRAVITY_STATUS_HOOK_NAME])) return doc;
  const { [ANTIGRAVITY_STATUS_HOOK_NAME]: _ours, ...rest } = doc;
  return rest;
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
