/**
 * Composer attachments (see src/shared/chat/attachments.ts). Dropped and
 * picked files carry a local path; pasted images don't, so they go inline and
 * main saves them to a file before the runtime sees them.
 */

import type { ContentBlock } from '../../../../shared/chat';
import { CHAT_IMAGE_MAX_BYTES, isChatImageType } from '../../../../shared/chat';

export interface ComposerAttachment {
  id: string;
  name: string;
  /** What's sent: an image block, or a file block carrying its path. */
  block: Extract<ContentBlock, { type: 'image' } | { type: 'file' }>;
  /** data: URL thumbnail for images (the CSP allows data: images, not blob:). */
  preview?: string;
}

let nextId = 0;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

function localPath(file: File): string {
  try {
    return window.clubhouse.getPathForFile(file) || '';
  } catch {
    // telemetry-exempt: no path just means the file is attached inline or refused with a message.
    return '';
  }
}

/**
 * Turn a pasted, dropped or picked file into an attachment, or a reason it
 * can't be attached. When the agent can't take images, an image on disk goes
 * as a file path the agent can open with its own tools.
 */
export async function attachmentFromFile(file: File, imagesAllowed: boolean): Promise<ComposerAttachment | { error: string }> {
  const filePath = localPath(file);
  const name = file.name || (filePath ? filePath.split(/[\\/]/).pop() ?? filePath : 'pasted image');
  const id = `att-${++nextId}`;
  if (imagesAllowed && isChatImageType(file.type)) {
    if (file.size > CHAT_IMAGE_MAX_BYTES) return { error: `${name} is over 5 MB` };
    const preview = await readAsDataUrl(file);
    const block: ComposerAttachment['block'] = filePath
      ? { type: 'image', mimeType: file.type, path: filePath }
      : { type: 'image', mimeType: file.type, data: preview.slice(preview.indexOf(',') + 1) };
    return { id, name, block, preview };
  }
  if (filePath) return { id, name, block: { type: 'file', path: filePath } };
  if (file.type.startsWith('image/')) {
    return { error: imagesAllowed ? `${name} isn't a PNG, JPEG, GIF or WebP image` : "This agent's chat can't take pasted images" };
  }
  return { error: `Can't attach ${name}: only files on disk can be attached` };
}

/** File name for an attachment block in a sent message. */
export function attachmentName(block: ContentBlock): string | null {
  const target = block.type === 'file' ? block.path : block.type === 'image' ? block.path ?? block.uri ?? '' : null;
  if (target === null) return null;
  return target.split(/[\\/]/).pop() || (block.type === 'image' ? 'image' : target);
}
