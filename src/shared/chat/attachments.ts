/**
 * Composer attachments: limits shared by the composer (renderer) and the
 * SEND_MESSAGE handler (main), which re-checks everything.
 *
 * Attachments travel as contract ContentBlocks: images as `{ type: 'image',
 * mimeType, path }` (or `data` for a pasted image, which main saves to a file
 * first so transcripts stay small) and other files as `{ type: 'file', path }`.
 * Every driver takes these: Claude reads image paths and passes file paths as
 * text, Codex sends localImage and mention inputs, ACP sends file:// links.
 */

/** Image types every provider accepts (Claude's list is the narrowest). */
export const CHAT_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Claude rejects images over 5 MB. */
export const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CHAT_ATTACHMENTS_MAX = 10;

export function isChatImageType(mimeType: string): boolean {
  return CHAT_IMAGE_TYPES.includes(mimeType);
}
