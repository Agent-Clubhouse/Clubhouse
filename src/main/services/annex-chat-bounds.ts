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
/** Blocks kept in a preview. A call with more has them summed up. */
const TOOL_BLOCKS_MAX = 64;
/** How far to look for a line break to cut at. */
const LINE_SEARCH_CHARS = 4096;

const bytesOf = (text: string): number => Buffer.byteLength(text);

/** Where `text` can be cut so the part before it is at most `maxBytes`: never inside a character or an escape sequence. */
function headEnd(text: string, maxBytes: number): number {
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && bytesOf(text.slice(0, end)) > maxBytes) end = Math.floor(end * 0.9);
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
  while (start < text.length && bytesOf(text.slice(start)) > maxBytes) start = text.length - Math.floor((text.length - start) * 0.9);
  const line = text.indexOf('\n', start);
  if (line >= 0 && line - start < LINE_SEARCH_CHARS) return line + 1;
  if (text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start++;
  return start;
}

/** The start and end of `text`, with a plain note between them saying how much is missing. */
export function previewText(text: string, maxBytes: number): string {
  if (bytesOf(text) <= maxBytes) return text;
  const head = text.slice(0, headEnd(text, Math.floor(maxBytes * 0.75)));
  const tail = text.slice(tailStart(text, Math.floor(maxBytes * 0.2)));
  const omitted = bytesOf(text) - bytesOf(head) - bytesOf(tail);
  return `${head}\n[Clubhouse: ${omitted} bytes of this output are omitted here. Open it on the desktop for all of it.]\n${tail}`;
}

function previewBlock(block: ToolCallContent, maxBytes: number): ToolCallContent {
  if (block.type === 'text') return { ...block, text: previewText(block.text, maxBytes) };
  if (block.type === 'terminal') return { ...block, output: previewText(block.output, maxBytes) };
  const full = block.unifiedDiff ?? block.newText ?? block.oldText ?? '';
  if (bytesOf(full) + bytesOf(block.oldText ?? '') + bytesOf(block.newText ?? '') <= maxBytes) return block;
  // Half a diff would read as the change itself, so it says what it is rather than staying a diff.
  return { type: 'text', text: `${block.path}\n${previewText(full, maxBytes)}` };
}

function previewContent(content: ToolCallContent[]): ToolCallContent[] {
  const kept = content.slice(0, TOOL_BLOCKS_MAX);
  const perBlock = Math.max(TOOL_BLOCK_PREVIEW_MIN_BYTES, Math.min(TOOL_BLOCK_PREVIEW_BYTES, Math.floor(TOOL_EVENT_MAX_BYTES / 2 / kept.length)));
  const previews = kept.map((block) => previewBlock(block, perBlock));
  if (content.length > kept.length) {
    previews.push({ type: 'text', text: `[Clubhouse: ${content.length - kept.length} more blocks of output are omitted here. Open it on the desktop for all of it.]` });
  }
  return previews;
}

/**
 * A tool update as a preview, if it's over TOOL_EVENT_MAX_BYTES. `originalBytes` is
 * the encoded size of the whole event, known by the caller, who has it to hand.
 */
export function boundChatEvent(event: ChatEvent, originalBytes: number): ChatEvent {
  if (event.type !== 'tool_call_update' || originalBytes <= TOOL_EVENT_MAX_BYTES) return event;
  const { rawOutput, ...data } = event.data;
  const bounded = {
    ...data,
    ...(data.content && { content: previewContent(data.content), contentMode: 'replace' as const }),
    ...(data.title && { title: previewText(data.title, 1024) }),
    ...(data.error && { error: previewText(data.error, 16 * 1024) }),
    // A small rawOutput can stay. It's the one field with no shape to preview by.
    ...(rawOutput !== undefined && bytesOf(JSON.stringify(rawOutput) ?? '') <= 16 * 1024 && { rawOutput }),
    truncated: { originalBytes },
  };
  return { ...event, data: bounded };
}
