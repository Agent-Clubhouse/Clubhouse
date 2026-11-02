/**
 * Keeps a chat event small enough for a phone, by what it means rather than by
 * cutting JSON (#2673). The event in the transcript and the live call are never
 * changed: only what goes over Annex is. Clubhouse Go tested the conditions here on
 * build 147: a preview must keep the call's id and final status, and must replace
 * the content rather than append. 147 ignores unknown fields, so the notice that
 * output is missing has to be in the text it draws.
 */

import type { ChatEvent, ToolCallContent } from '../../shared/chat';

/** A tool update over this gets a preview. Tunable: nothing here has been measured against real output sizes. */
export const TOOL_EVENT_MAX_BYTES = 1024 * 1024;
/** The most of any one block of output in a preview. */
const TOOL_BLOCK_PREVIEW_BYTES = 256 * 1024;
const TOOL_BLOCK_PREVIEW_MIN_BYTES = 1024;
/** A terminal block's command, and a path, in a preview. */
const TOOL_COMMAND_PREVIEW_BYTES = 16 * 1024;
const TOOL_PATH_PREVIEW_BYTES = 1024;
const DIFF_PREVIEW_NOTE = '[Clubhouse: this change is too large to show as a diff here. Open it on the desktop for all of it.]';
/** Blocks kept in a preview. A call with more has them summed up. */
const TOOL_BLOCKS_MAX = 64;
/** How far to look for a line break to cut at. */
const LINE_SEARCH_CHARS = 4096;

const bytesOf = (text: string): number => Buffer.byteLength(text);
/** A string's size as sent, escapes included, without its quotes: control characters take six bytes each. */
const encodedBytesOf = (text: string): number => Buffer.byteLength(JSON.stringify(text)) - 2;

/** Where `text` can be cut so the part before it is at most `maxBytes`: never inside a character or an escape sequence. */
function headEnd(text: string, maxBytes: number): number {
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && encodedBytesOf(text.slice(0, end)) > maxBytes) end = Math.floor(end * 0.9);
  const line = text.lastIndexOf('\n', end - 1);
  if (line >= 0 && end - line < LINE_SEARCH_CHARS) return line + 1;
  // A surrogate pair's first half, or an escape sequence not yet finished.
  if (end > 0 && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
  const escape = text.lastIndexOf('\x1b', end - 1);
  if (escape >= 0 && end - escape < 64 && !/[@-~]/.test(text.slice(escape + 2, end))) end = escape;
  return end;
}

/** Where to start the last part of `text`, so it's at most `maxBytes`, on the same terms. */
function tailStart(text: string, maxBytes: number): number {
  let start = Math.max(0, text.length - maxBytes);
  while (start < text.length && encodedBytesOf(text.slice(start)) > maxBytes) start = text.length - Math.floor((text.length - start) * 0.9);
  const line = text.indexOf('\n', start);
  if (line >= 0 && line - start < LINE_SEARCH_CHARS) return line + 1;
  if (text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start++;
  // An escape sequence already begun: start after it.
  const escape = text.lastIndexOf('\x1b', start - 1);
  if (escape >= 0 && start - escape < 64 && !/[@-~]/.test(text.slice(escape + 2, start))) {
    const rest = text.slice(start, start + 64).search(/[@-~]/);
    if (rest >= 0) start += rest + 1;
  }
  return start;
}

/** The start and end of `text`, with a plain note between them saying how much is missing. */
export function previewText(text: string, maxBytes: number): string {
  if (encodedBytesOf(text) <= maxBytes) return text;
  const head = text.slice(0, headEnd(text, Math.floor(maxBytes * 0.75)));
  const tail = text.slice(tailStart(text, Math.floor(maxBytes * 0.2)));
  const omitted = bytesOf(text) - bytesOf(head) - bytesOf(tail);
  return `${head}\n[Clubhouse: ${omitted} bytes of this output are omitted here. Open it on the desktop for all of it.]\n${tail}`;
}

function previewBlock(block: ToolCallContent, maxBytes: number): ToolCallContent {
  if (block.type === 'text') return { ...block, text: previewText(block.text, maxBytes) };
  if (block.type === 'terminal') {
    return {
      ...block,
      ...(block.command !== undefined && { command: previewText(block.command, Math.min(TOOL_COMMAND_PREVIEW_BYTES, maxBytes)) }),
      ...(block.cwd !== undefined && { cwd: previewText(block.cwd, TOOL_PATH_PREVIEW_BYTES) }),
      output: previewText(block.output, maxBytes),
    };
  }
  const full = block.unifiedDiff ?? block.newText ?? block.oldText ?? '';
  const size = [block.path, block.unifiedDiff, block.oldText, block.newText].reduce((sum, part) => sum + encodedBytesOf(part ?? ''), 0);
  if (size <= maxBytes) return block;
  // Half a diff would read as the change itself, so it says what it is rather than staying a diff. The note
  // is always there: which side is shown depends on what the provider sent, and the rest can go uncut.
  return { type: 'text', text: `${previewText(block.path, TOOL_PATH_PREVIEW_BYTES)}\n${DIFF_PREVIEW_NOTE}\n${previewText(full, maxBytes)}` };
}

/**
 * A note in the content: 147 ignores `truncated`, so only text can say it. Its tool cards
 * are collapsed, so this is seen when one's opened. It isn't an always-visible warning.
 */
const TOOL_PREVIEW_NOTE = '[Clubhouse: this is a preview. This tool call is too large to show in full here. Open it on the desktop for all of it.]';
const toolPreviewNote = (): ToolCallContent => ({ type: 'text', text: TOOL_PREVIEW_NOTE });

function previewContent(content: ToolCallContent[], totalBytes = TOOL_EVENT_MAX_BYTES / 2): ToolCallContent[] {
  const kept = content.slice(0, TOOL_BLOCKS_MAX);
  const perBlock = Math.max(TOOL_BLOCK_PREVIEW_MIN_BYTES, Math.min(TOOL_BLOCK_PREVIEW_BYTES, Math.floor(totalBytes / kept.length)));
  const previews = kept.map((block) => previewBlock(block, perBlock));
  if (content.length > kept.length) {
    previews.push({ type: 'text', text: `[Clubhouse: ${content.length - kept.length} more blocks of output are omitted here. Open it on the desktop for all of it.]` });
  }
  return previews;
}

/** Which update carries each tool call's appended note, by seq, so replaying it gives the same frame. */
const appendedNotes = new Map<string, number>();
const APPENDED_NOTES_MAX = 2000;

/**
 * Is this the update that appends a call's note? Each one appended would add to the
 * card, so a call gets one. After a restart, or once forgotten, the next to ask carries
 * it, so a call can show one more note, but never one per update.
 */
function carriesAppendedNote(event: Extract<ChatEvent, { type: 'tool_call_update' }>): boolean {
  const key = JSON.stringify([event.agentId, event.sessionId, event.data.toolCallId]);
  const seq = appendedNotes.get(key);
  if (seq !== undefined) return seq === event.seq;
  appendedNotes.set(key, event.seq);
  if (appendedNotes.size > APPENDED_NOTES_MAX) appendedNotes.delete(appendedNotes.keys().next().value!);
  return true;
}

/** A session ended, so its calls won't get more updates. */
export function forgetAppendedNotes(agentId: string, sessionId: string): void {
  const prefix = JSON.stringify([agentId, sessionId]).slice(0, -1);
  for (const key of appendedNotes.keys()) {
    if (key.startsWith(`${prefix},`)) appendedNotes.delete(key);
  }
}

/** For tests: as if this process had just started. */
export function _forgetAppendedNotesForTest(): void {
  appendedNotes.clear();
}

function withNoteIfUncut(content: ToolCallContent[]): ToolCallContent[] {
  const previews = previewContent(content);
  return JSON.stringify(previews) === JSON.stringify(content) ? [toolPreviewNote(), ...previews] : previews;
}

/**
 * A tool update or permission request as a preview, if it's over its limit. `originalBytes` is
 * the encoded size of the whole event, known by the caller, who has it to hand.
 */
export function boundChatEvent(event: ChatEvent, originalBytes: number): ChatEvent {
  if (event.type === 'permission_request') {
    return originalBytes > PERMISSION_INPUT_MAX_BYTES ? permissionPreview(event, PERMISSION_INPUT_MAX_BYTES, originalBytes) : event;
  }
  if (event.type === 'tool_call') {
    if (originalBytes <= PERMISSION_INPUT_MAX_BYTES) return event;
    const { rawInput, content, ...data } = event.data;
    const fields = smallFields(rawInput, SMALL_FIELD_BYTES);
    return { ...event, data: {
      ...data,
      ...(data.title && { title: previewText(data.title, SMALL_FIELD_BYTES) }),
      content: [toolPreviewNote(), ...previewContent(content ?? [], PERMISSION_INPUT_MAX_BYTES / 2)],
      ...(fields && { rawInput: fields }),
      truncated: { originalBytes },
    } as typeof event.data };
  }
  if (event.type !== 'tool_call_update' || originalBytes <= TOOL_EVENT_MAX_BYTES) return event;
  const { rawOutput, ...data } = event.data;
  const bounded = {
    ...data,
    ...(data.content
      // Replaces what's there, so a block cut short has its note in it, and one that wasn't gets this.
      ? { content: withNoteIfUncut(data.content), contentMode: 'replace' as const }
      // Nothing to replace, and what it already shows stays. Appended, so only once for a call.
      : carriesAppendedNote(event) && { content: [toolPreviewNote()], contentMode: 'append' as const }),
    ...(data.title && { title: previewText(data.title, 1024) }),
    ...(data.error && { error: previewText(data.error, 16 * 1024) }),
    // A small rawOutput can stay. It's the one field with no shape to preview by.
    ...(rawOutput !== undefined && bytesOf(JSON.stringify(rawOutput) ?? '') <= 16 * 1024 && { rawOutput }),
    truncated: { originalBytes },
  };
  return { ...event, data: bounded };
}

/** The most of a permission request's input a phone gets. Past it, it can't approve. Sized from real tool calls: none of 150,174 in one user's Claude transcripts were over it. */
export const PERMISSION_INPUT_MAX_BYTES = 256 * 1024;
/** The most across all a chat's pending permissions. Past it, each gets a share, and none is dropped. */
export const PERMISSIONS_TOTAL_MAX_BYTES = 1024 * 1024;
const PERMISSION_INPUT_MIN_BYTES = 4 * 1024;
/** The most tool input on frames that don't draw an approval card: `hook:event`, `permission:request` and the catalog. */
export const OUTER_TOOL_INPUT_MAX_BYTES = 64 * 1024;
const SMALL_FIELD_BYTES = 1024;

/**
 * First in `description` and in `content`, because 147 ignores unknown fields and
 * shows only the start of what it draws.
 */
export const INCOMPLETE_INPUT_WARNING = 'Incomplete input: this request is too large to show in full here. Review it on the desktop to approve it. You can still deny it here.';
/** For a request a phone has no way to deny, where saying it could would be untrue. */
export const INCOMPLETE_INPUT_WARNING_DESKTOP_ONLY = 'Incomplete input: this request is too large to show in full here. Review it on the desktop.';

/** Whether phones may offer persistent approvals: capabilities' `permissions.persistentApprovals`. */
export const MOBILE_PERSISTENT_APPROVALS = true;

/** Does a phone have a deny it supports and has enabled, among these options? */
export function hasSupportedDeny(options: readonly { kind: string }[], persistentApprovals = MOBILE_PERSISTENT_APPROVALS): boolean {
  return options.some((o) => o.kind === 'reject_once' || o.kind === 'cancel_turn' || (o.kind === 'reject_always' && persistentApprovals));
}

/** The warning for these options. */
export function incompleteInputWarning(options: readonly { kind: string }[], persistentApprovals = MOBILE_PERSISTENT_APPROVALS): string {
  return hasSupportedDeny(options, persistentApprovals) ? INCOMPLETE_INPUT_WARNING : INCOMPLETE_INPUT_WARNING_DESKTOP_ONLY;
}

/** Requests a phone has been shown a preview of. Approving one is refused, even if it would fit now. */
const sentIncomplete = new Set<string>();
const SENT_INCOMPLETE_MAX = 1000;
/**
 * The record covers requests from this moment on: from when this process started,
 * or when it last forgot one. For anything older it can't say what a phone was
 * shown, so that isn't taken as complete.
 */
let recordedSince = Date.now();

function rememberIncomplete(requestId: string): void {
  sentIncomplete.add(requestId);
  if (sentIncomplete.size <= SENT_INCOMPLETE_MAX) return;
  sentIncomplete.delete(sentIncomplete.values().next().value!);
  recordedSince = Date.now();
}

/** For tests: as if this process had just started. */
export function _forgetSentPermissionsForTest(since = Date.now()): void {
  sentIncomplete.clear();
  recordedSince = since;
}

type PermissionRequest = Extract<ChatEvent, { type: 'permission_request' }>;

/**
 * Can't it be shown that a phone has this whole request? Follows what was sent, not
 * what its screen shows, and fails closed: approving needs evidence. `event` must be
 * the original, from the transcript, so its size is the real one, options included.
 * A preview is never evidence of itself. A request at the floor is whole on every
 * path, however many are pending. Anything larger is whole only if the record covers
 * it, so one left pending across a restart, whose preview nobody remembers, is
 * refused. `liveOptions` are what the agent would act on: a phone was shown the
 * event's, so if they differ, it hasn't seen what it would be approving.
 */
export function isIncompletePermission(event: PermissionRequest, liveOptions?: readonly PermissionRequest['data']['options'][number][]): boolean {
  if (sentIncomplete.has(event.data.requestId) || 'truncated' in event.data) return true;
  if (liveOptions && JSON.stringify(liveOptions) !== JSON.stringify(event.data.options)) return true;
  const bytes = bytesOf(JSON.stringify(event.data));
  if (bytes <= PERMISSION_INPUT_MIN_BYTES) return false;
  return bytes > PERMISSION_INPUT_MAX_BYTES || event.ts < recordedSince;
}

/** A permission request's size as a closed set: enough to judge the caps, and nothing about the input. */
export function toolInputSizeBucket(bytes: number): '<=64k' | '<=256k' | '<=1m' | '>1m' {
  if (bytes <= OUTER_TOOL_INPUT_MAX_BYTES) return '<=64k';
  if (bytes <= PERMISSION_INPUT_MAX_BYTES) return '<=256k';
  return bytes <= 1024 * 1024 ? '<=1m' : '>1m';
}

/** The small plain fields of a tool's input, such as its path, up to `maxBytes`. */
function smallFields(input: unknown, maxBytes: number): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const kept: Record<string, unknown> = {};
  let used = 2;
  for (const [key, value] of Object.entries(input)) {
    const small = typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && bytesOf(value) <= SMALL_FIELD_BYTES);
    if (!small) continue;
    const cost = bytesOf(JSON.stringify(key)) + bytesOf(JSON.stringify(value)) + 2;
    if (used + cost > maxBytes) break;
    kept[key] = value;
    used += cost;
  }
  return kept;
}

function permissionSourceText(data: PermissionRequest['data']): string {
  if (!data.content?.length) return JSON.stringify(data.rawInput, null, 2) ?? '';
  return data.content.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'terminal') return block.output;
    return `${block.path}\n${block.unifiedDiff ?? block.newText ?? block.oldText ?? ''}`;
  }).join('\n');
}

function permissionPreview(event: PermissionRequest, maxBytes: number, originalBytes: number): PermissionRequest {
  rememberIncomplete(event.data.requestId);
  const warning = incompleteInputWarning(event.data.options);
  const room = Math.max(512, maxBytes - 2 * bytesOf(warning) - 2 * SMALL_FIELD_BYTES);
  const { rawInput, ...data } = event.data;
  const about = previewText(data.description ?? data.title, SMALL_FIELD_BYTES);
  const fields = smallFields(rawInput, SMALL_FIELD_BYTES);
  return {
    ...event,
    data: {
      ...data,
      title: previewText(data.title, SMALL_FIELD_BYTES),
      description: `${warning} ${about}`,
      content: [{ type: 'text', text: `${warning}\n\n${previewText(permissionSourceText(event.data), room)}` }],
      ...(fields && { rawInput: fields }),
      truncated: { originalBytes },
    } as PermissionRequest['data'],
  };
}

/** A chat's pending permissions as a phone gets them: each within its cap, all within the total, and none dropped. */
export function boundPendingPermissions(events: PermissionRequest[]): PermissionRequest[] {
  let remaining = PERMISSIONS_TOTAL_MAX_BYTES;
  return events.map((event, i) => {
    const share = Math.max(PERMISSION_INPUT_MIN_BYTES, Math.floor(remaining / (events.length - i)));
    const allowed = Math.min(PERMISSION_INPUT_MAX_BYTES, share);
    const bytes = bytesOf(JSON.stringify(event.data));
    const bounded = bytes <= allowed ? event : permissionPreview(event, allowed, bytes);
    remaining -= bounded === event ? bytes : bytesOf(JSON.stringify(bounded.data));
    return bounded;
  });
}

/** Tool input for a frame that draws no approval card, with what's small kept and a note of its size. */
export function boundToolInput(input: Record<string, unknown> | undefined): { toolInput: Record<string, unknown> | undefined; toolInputTruncated?: { originalBytes: number } } {
  const bytes = bytesOf(JSON.stringify(input) ?? '');
  if (bytes <= OUTER_TOOL_INPUT_MAX_BYTES) return { toolInput: input };
  return { toolInput: smallFields(input, OUTER_TOOL_INPUT_MAX_BYTES - 1024), toolInputTruncated: { originalBytes: bytes } };
}
