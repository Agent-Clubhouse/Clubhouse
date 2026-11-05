/**
 * Ordered block payloads to one instruction text (#2819). Pure and byte-stable:
 * the same blocks in the same order give the same bytes. Only content is taken,
 * so a block's name or role can't affect anything. No headings or markers are
 * added, and wildcards stay as written: expanding them per agent is activation's.
 *
 * Failures name a position and never the text.
 */

import { MAX_BLOCK_BYTES } from './validation';

export const BLOCK_SEPARATOR = '\n\n';
export const MAX_COMPOSED_BYTES = 2 * 1024 * 1024;

export type ComposedInstructions =
  | { ok: true; text: string; bytes: number }
  | { ok: false; code: 'block_too_large'; index: number }
  | { ok: false; code: 'composed_too_large' };

/** What composing blocks of these sizes comes to, for checking without their text. */
export function composedBytes(blockBytes: readonly number[]): number {
  const separators = Math.max(0, blockBytes.length - 1) * Buffer.byteLength(BLOCK_SEPARATOR, 'utf8');
  return blockBytes.reduce((total, bytes) => total + bytes, separators);
}

export function composeInstructions(blocks: ReadonlyArray<{ content: string }>): ComposedInstructions {
  const sizes = blocks.map((block) => Buffer.byteLength(block.content, 'utf8'));
  const oversized = sizes.findIndex((bytes) => bytes > MAX_BLOCK_BYTES);
  if (oversized >= 0) return { ok: false, code: 'block_too_large', index: oversized };
  const bytes = composedBytes(sizes);
  if (bytes > MAX_COMPOSED_BYTES) return { ok: false, code: 'composed_too_large' };
  return { ok: true, text: blocks.map((block) => block.content).join(BLOCK_SEPARATOR), bytes };
}
