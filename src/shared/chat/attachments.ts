/**
 * Composer attachments, shared by the composer (renderer) and main.
 *
 * The renderer never sends paths or bytes with a message. It stages each
 * attachment first: dropped and picked files through the preload, which
 * resolves the path of a genuine OS-provided File itself, and pasted images
 * as bytes. Main checks the file, remembers it under an opaque id and
 * SEND_MESSAGE takes only those ids. So page code (a plugin, say) can't name
 * an arbitrary local file for an agent to read and upload.
 *
 * Main turns staged attachments into contract ContentBlocks every driver
 * takes: images as `{ type: 'image', mimeType, path }` (pasted ones saved to
 * a file first) and other files as `{ type: 'file', path }`.
 */

/** Image types every provider accepts (Claude's list is the narrowest). Main sniffs the bytes; the name doesn't count. */
export const CHAT_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Claude rejects images over 5 MB once base64-encoded (+33%), so raw bytes stop at 3.75 MB. */
export const CHAT_IMAGE_MAX_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);
/** Other files go to the agent as paths; this keeps it to things an agent can sensibly read. */
export const CHAT_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const CHAT_ATTACHMENTS_MAX = 10;

export function isChatImageType(mimeType: string): boolean {
  return CHAT_IMAGE_TYPES.includes(mimeType);
}

/** A file main has checked and will attach when its id is sent. */
export interface StagedChatAttachment {
  id: string;
  name: string;
  /** 'image' when the bytes are a supported image within the size cap. */
  kind: 'image' | 'file';
  /** Sniffed from the bytes, for images. */
  mimeType?: string;
  size: number;
  /** Pasted from the clipboard: there's no file of the user's to fall back to when the agent can't take images. */
  pasted: boolean;
}
