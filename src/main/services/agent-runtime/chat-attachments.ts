/**
 * Staged composer attachments (see src/shared/chat/attachments.ts).
 *
 * stageAttachmentPath() takes a path the preload resolved from a File the
 * user dropped or picked (page code can't reach that channel with a path of
 * its own); stageAttachmentData() takes pasted image bytes and saves them
 * under `<userData>/chat-attachments/<agent>/`. Both check the file and
 * return an opaque id. resolveAttachments() turns ids into content blocks at
 * send time, re-checking each file, and refuses images unless the runtime
 * reports `capabilities.images: true`; an image the user has on disk then
 * goes as a file path instead.
 *
 * Saved pasted images are deleted after SAVED_ATTACHMENT_TTL_MS. Transcripts
 * keep their paths, which then dangle; that's fine because history only
 * shows the file name and the CLIs keep their own copy of what was sent.
 */

import { app } from 'electron';
import { randomUUID } from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { ChatCapabilities, ContentBlock, StagedChatAttachment } from '../../../shared/chat';
import { CHAT_ATTACHMENTS_MAX, CHAT_FILE_MAX_BYTES, CHAT_IMAGE_MAX_BYTES } from '../../../shared/chat';

export const SAVED_ATTACHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Staged ids outlive a draft that sits for a while, not forever. */
export const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
const STAGED_MAX = 500;

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

interface Staged extends StagedChatAttachment {
  agentId: string;
  /** Real path, symlinks resolved. */
  path: string;
  at: number;
}

const staged = new Map<string, Staged>();

export function attachmentsDir(agentId: string): string {
  return path.join(app.getPath('userData'), 'chat-attachments', agentId.replace(/[^A-Za-z0-9._-]/g, '_'));
}

/** Image type from the first bytes, or undefined. */
export function sniffImage(head: Uint8Array): string | undefined {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

async function readHead(file: string): Promise<Uint8Array> {
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buf, 0, 16, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function prune(now = Date.now()): void {
  for (const [id, s] of staged) if (now - s.at > STAGED_TTL_MS) staged.delete(id);
  while (staged.size >= STAGED_MAX) staged.delete(staged.keys().next().value as string);
}

function remember(entry: Omit<Staged, 'id' | 'at'>): StagedChatAttachment {
  prune();
  const id = randomUUID();
  staged.set(id, { ...entry, id, at: Date.now() });
  // The renderer gets the id and what to show, never the path.
  return { id, name: entry.name, kind: entry.kind, ...(entry.mimeType ? { mimeType: entry.mimeType } : {}), size: entry.size, pasted: entry.pasted };
}

/** What a real path holds: an image within the cap, or a file within its cap. Rejects anything else. */
async function inspect(real: string): Promise<{ kind: 'image' | 'file'; mimeType?: string; size: number }> {
  const st = await fsp.stat(real);
  if (!st.isFile()) throw new Error(`Can't attach ${path.basename(real)}: only files can be attached`);
  const mimeType = st.size <= CHAT_IMAGE_MAX_BYTES ? sniffImage(await readHead(real)) : undefined;
  if (mimeType) return { kind: 'image', mimeType, size: st.size };
  if (st.size > CHAT_FILE_MAX_BYTES) throw new Error(`Can't attach ${path.basename(real)}: files must be 20 MB or smaller`);
  return { kind: 'file', size: st.size };
}

/** Stage a dropped or picked file. `filePath` comes from the preload's webUtils.getPathForFile. */
export async function stageAttachmentPath(agentId: string, filePath: string, name?: string): Promise<StagedChatAttachment> {
  if (!filePath || filePath.includes('\0') || !path.isAbsolute(filePath)) throw new Error('Attachment path must be an absolute path');
  let real: string;
  try {
    real = await fsp.realpath(filePath);
  } catch {
    throw new Error(`Can't attach ${path.basename(filePath)}: it no longer exists`);
  }
  const info = await inspect(real);
  return remember({ agentId, path: real, name: name || path.basename(filePath), pasted: false, ...info });
}

/** Stage pasted image bytes: they must be a supported image within the cap. Saved to a file now so transcripts hold a path. */
export async function stageAttachmentData(agentId: string, data: Uint8Array, name?: string): Promise<StagedChatAttachment> {
  if (!data.byteLength) throw new Error('The pasted image is empty');
  if (data.byteLength > CHAT_IMAGE_MAX_BYTES) throw new Error('Images must be 3.75 MB or smaller');
  const mimeType = sniffImage(data.subarray(0, 16));
  if (!mimeType) throw new Error('Only PNG, JPEG, GIF or WebP images can be pasted');
  const dir = attachmentsDir(agentId);
  await fsp.mkdir(dir, { recursive: true });
  await pruneSaved(dir);
  const file = path.join(dir, `${randomUUID()}.${EXTENSIONS[mimeType]}`);
  await fsp.writeFile(file, data);
  return remember({ agentId, path: await fsp.realpath(file), name: name || `pasted.${EXTENSIONS[mimeType]}`, kind: 'image', mimeType, size: data.byteLength, pasted: true });
}

async function pruneSaved(dir: string): Promise<void> {
  const cutoff = Date.now() - SAVED_ATTACHMENT_TTL_MS;
  for (const name of await fsp.readdir(dir).catch((): string[] => [])) {
    const file = path.join(dir, name);
    const st = await fsp.stat(file).catch((): null => null);
    if (st?.isFile() && st.mtimeMs < cutoff) await fsp.rm(file, { force: true });
  }
}

/** Content blocks for staged ids, re-checking each file. Images need `caps.images === true`. */
export async function resolveAttachments(agentId: string, ids: string[], caps: ChatCapabilities | undefined): Promise<ContentBlock[]> {
  if (ids.length > CHAT_ATTACHMENTS_MAX) throw new Error(`Attach at most ${CHAT_ATTACHMENTS_MAX} files at a time`);
  const out: ContentBlock[] = [];
  for (const id of ids) {
    const s = staged.get(id);
    if (!s || s.agentId !== agentId || Date.now() - s.at > STAGED_TTL_MS) throw new Error('An attachment expired; attach it again');
    // The file may have changed since it was staged: check it again.
    const real = await fsp.realpath(s.path).catch((): null => null);
    if (real !== s.path) throw new Error(`Can't attach ${s.name}: it moved or was deleted`);
    const now = await inspect(real);
    if (now.kind === 'image' && now.mimeType) {
      if (caps?.images === true) { out.push({ type: 'image', mimeType: now.mimeType, path: real }); continue; }
      if (s.pasted) throw new Error("This agent's chat can't take images");
    }
    out.push({ type: 'file', path: real });
  }
  return out;
}

/** For tests. */
export function clearStagedAttachments(): void {
  staged.clear();
}
