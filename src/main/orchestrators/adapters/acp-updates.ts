import {
  ACP_SESSION_UPDATE_KINDS,
  ACP_TOOL_CALL_STATUSES,
  ACP_TOOL_KINDS,
  type SessionUpdate,
  type SessionUpdateKind,
  type ToolKind,
} from './acp-schema';

export type ParsedSessionUpdate =
  | { result: 'valid'; update: SessionUpdate }
  /** A variant this schema version doesn't know, or a known one missing required fields. */
  | { result: 'skipped'; kind: string; reason: string; raw: unknown };

const KNOWN_KINDS = new Set<string>(ACP_SESSION_UPDATE_KINDS);
const TOOL_KINDS = new Set<string>(ACP_TOOL_KINDS);
const TOOL_STATUSES = new Set<string>(ACP_TOOL_CALL_STATUSES);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isContentBlock(v: unknown): boolean {
  return isObject(v) && typeof v.type === 'string';
}

/** Fields each known variant requires (beyond `sessionUpdate`), per schema v1.26.0. */
const REQUIRED: Record<SessionUpdateKind, (u: Record<string, unknown>) => string | null> = {
  user_message_chunk: (u) => (isContentBlock(u.content) ? null : 'content'),
  agent_message_chunk: (u) => (isContentBlock(u.content) ? null : 'content'),
  agent_thought_chunk: (u) => (isContentBlock(u.content) ? null : 'content'),
  tool_call: (u) => (typeof u.toolCallId !== 'string' ? 'toolCallId' : typeof u.title !== 'string' ? 'title' : null),
  tool_call_update: (u) => (typeof u.toolCallId === 'string' ? null : 'toolCallId'),
  plan: (u) => (Array.isArray(u.entries) ? null : 'entries'),
  available_commands_update: (u) => (Array.isArray(u.availableCommands) ? null : 'availableCommands'),
  current_mode_update: (u) => (typeof u.currentModeId === 'string' ? null : 'currentModeId'),
  config_option_update: (u) => (Array.isArray(u.configOptions) ? null : 'configOptions'),
  session_info_update: () => null,
  usage_update: (u) => (typeof u.used !== 'number' ? 'used' : typeof u.size !== 'number' ? 'size' : null),
  notice: (u) => (typeof u.severity !== 'string' ? 'severity' : typeof u.title !== 'string' ? 'title' : null),
  compaction_update: (u) => (typeof u.compactionId !== 'string' ? 'compactionId' : typeof u.status !== 'string' ? 'status' : null),
  compaction_summary_chunk: (u) => (typeof u.compactionId !== 'string' ? 'compactionId' : isContentBlock(u.content) ? null : 'content'),
};

/**
 * Validate a `session/update` payload's `update` field.
 *
 * Unknown variants and malformed known ones come back as `skipped` so the
 * caller can log and skip them instead of crashing the stream; ACP agents add
 * variants between schema versions. Unknown enum values inside a known
 * variant degrade the way the schema's `x-deserialize-default-on-error`
 * suggests: an unknown tool kind becomes `other`, an unknown status is dropped.
 */
export function parseSessionUpdate(raw: unknown): ParsedSessionUpdate {
  if (!isObject(raw) || typeof raw.sessionUpdate !== 'string') {
    return { result: 'skipped', kind: '(missing)', reason: 'update has no sessionUpdate discriminator', raw };
  }
  const kind = raw.sessionUpdate;
  if (!KNOWN_KINDS.has(kind)) {
    return { result: 'skipped', kind, reason: 'unknown sessionUpdate variant', raw };
  }
  const missing = REQUIRED[kind as SessionUpdateKind](raw);
  if (missing) {
    return { result: 'skipped', kind, reason: `missing or invalid required field '${missing}'`, raw };
  }

  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const update = { ...raw };
    if (update.kind != null && !TOOL_KINDS.has(update.kind as string)) update.kind = 'other' as ToolKind;
    if (update.status != null && !TOOL_STATUSES.has(update.status as string)) {
      delete update.status;
    }
    return { result: 'valid', update: update as unknown as SessionUpdate };
  }

  return { result: 'valid', update: raw as unknown as SessionUpdate };
}
