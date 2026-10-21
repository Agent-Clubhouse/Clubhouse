/**
 * Coalesced helper updates (#2414): a burst of helper and Clubhouse messages
 * for one parent reaches it as one delivery, with one section per message, in
 * order, each with its own prefix. The chat runtime's queue, the renderer's
 * mirror of it and the main-process delivery window all build the text here,
 * so they agree.
 */

import type { ContentBlock } from './events';

function header(count: number): string {
  return `${count} helper updates, oldest first:`;
}

function sectionLabel(index: number, count: number): string {
  return `--- ${index + 1} of ${count} ---`;
}

/** Several update texts as one message. A single text comes back as is. */
export function coalesceUpdateTexts(texts: string[]): string {
  if (texts.length === 1) return texts[0];
  const sections = texts.map((text, i) => `${sectionLabel(i, texts.length)}\n${text}`);
  return [header(texts.length), ...sections].join('\n\n');
}

/**
 * Several messages' content as one message. Text-only messages become one
 * text block; anything else keeps its blocks, each message after its label.
 */
export function coalesceUpdateContent(parts: ContentBlock[][]): ContentBlock[] {
  if (parts.length === 1) return parts[0];
  const textOnly = parts.every((blocks) => blocks.every((b) => b.type === 'text'));
  if (textOnly) {
    const texts = parts.map((blocks) => blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n'));
    return [{ type: 'text', text: coalesceUpdateTexts(texts) }];
  }
  const out: ContentBlock[] = [{ type: 'text', text: header(parts.length) }];
  parts.forEach((blocks, i) => {
    out.push({ type: 'text', text: sectionLabel(i, parts.length) }, ...blocks);
  });
  return out;
}
