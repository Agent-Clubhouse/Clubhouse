/**
 * Composer attachments (see src/shared/chat/attachments.ts). Each file is
 * staged with main as soon as it's added; the composer keeps only the staged
 * id, its name and a small thumbnail, and sends the ids.
 */

import type { ContentBlock } from '../../../../shared/chat';

export interface ComposerAttachment {
  /** Staged id from main. */
  id: string;
  name: string;
  /** How it's shown: an image the agent will see, or a file it gets the path of. */
  kind: 'image' | 'file';
  /** Small data: URL thumbnail for images (the CSP allows data: images, not blob:). */
  preview?: string;
}

/** Images up to this size are their own thumbnail; larger ones are scaled down. */
const INLINE_PREVIEW_BYTES = 256 * 1024;
const THUMB_PX = 64;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

/** A thumbnail small enough to keep in the draft store, or undefined when it can't be made. */
async function thumbnail(file: File): Promise<string | undefined> {
  try {
    if (file.size <= INLINE_PREVIEW_BYTES) return await readAsDataUrl(file);
    if (typeof createImageBitmap !== 'function') return undefined;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, THUMB_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    // telemetry-exempt: a missing thumbnail only changes the chip's icon.
    return undefined;
  }
}

/**
 * Stage a pasted, dropped or picked file, or say why it can't be attached.
 * When the agent can't take images, an image on disk is shown (and sent) as
 * a file path the agent can open with its own tools.
 */
export async function attachmentFromFile(agentId: string, file: File, imagesAllowed: boolean): Promise<ComposerAttachment | { error: string }> {
  let staged;
  try {
    // Pasted images the agent can't take are refused before anything is saved.
    staged = await window.clubhouse.chat.stageAttachment(agentId, file, { imagesAllowed });
  } catch (err) {
    // telemetry-exempt: shown to the user next to the composer.
    const message = err instanceof Error ? err.message : String(err);
    return { error: message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  }
  if (staged.kind === 'image' && !imagesAllowed && staged.pasted) return { error: "This agent's chat can't take pasted images" };
  const kind = staged.kind === 'image' && imagesAllowed ? 'image' : 'file';
  const preview = kind === 'image' ? await thumbnail(file) : undefined;
  return { id: staged.id, name: staged.name, kind, ...(preview ? { preview } : {}) };
}

/** File name for an attachment block in a sent message. */
export function attachmentName(block: ContentBlock): string | null {
  const target = block.type === 'file' ? block.path : block.type === 'image' ? block.path ?? block.uri ?? '' : null;
  if (target === null) return null;
  return target.split(/[\\/]/).pop() || (block.type === 'image' ? 'image' : target);
}
