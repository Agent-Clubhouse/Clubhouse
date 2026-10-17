/**
 * Validates composer attachments before they reach a chat runtime. The
 * renderer is not trusted to have checked: types, sizes and paths are all
 * re-checked here, and images are refused when the driver can't take them.
 * Pasted images arrive inline and are saved under
 * `<userData>/chat-attachments/<agent>/` so the transcript records a path,
 * not megabytes of base64.
 */

import { app } from 'electron';
import { randomUUID } from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { ChatCapabilities, ContentBlock } from '../../../shared/chat';
import { CHAT_ATTACHMENTS_MAX, CHAT_IMAGE_MAX_BYTES, isChatImageType } from '../../../shared/chat';

/** Saved pasted images older than this are deleted when the agent saves a new one. */
export const SAVED_ATTACHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export function attachmentsDir(agentId: string): string {
  return path.join(app.getPath('userData'), 'chat-attachments', agentId.replace(/[^A-Za-z0-9._-]/g, '_'));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Attachment must be an object');
  return value as Record<string, unknown>;
}

function absolutePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error('Attachment path must be an absolute path');
  }
  return path.normalize(value);
}

async function savePasted(agentId: string, mimeType: string, data: Buffer): Promise<string> {
  const dir = attachmentsDir(agentId);
  await fsp.mkdir(dir, { recursive: true });
  await pruneSaved(dir);
  const file = path.join(dir, `${randomUUID()}.${EXTENSIONS[mimeType]}`);
  await fsp.writeFile(file, data);
  return file;
}

async function pruneSaved(dir: string): Promise<void> {
  const cutoff = Date.now() - SAVED_ATTACHMENT_TTL_MS;
  for (const name of await fsp.readdir(dir).catch((): string[] => [])) {
    const file = path.join(dir, name);
    const st = await fsp.stat(file).catch((): null => null);
    if (st?.isFile() && st.mtimeMs < cutoff) await fsp.rm(file, { force: true });
  }
}

async function image(agentId: string, block: Record<string, unknown>, caps: ChatCapabilities | undefined): Promise<ContentBlock> {
  if (caps && !caps.images) throw new Error("This agent's chat can't take images");
  const mimeType = block.mimeType;
  if (typeof mimeType !== 'string' || !isChatImageType(mimeType)) throw new Error('Images must be PNG, JPEG, GIF or WebP');
  if (typeof block.data === 'string') {
    const data = Buffer.from(block.data, 'base64');
    if (!data.length) throw new Error('The pasted image is empty');
    if (data.length > CHAT_IMAGE_MAX_BYTES) throw new Error('Images must be 5 MB or smaller');
    return { type: 'image', mimeType, path: await savePasted(agentId, mimeType, data) };
  }
  const file = absolutePath(block.path);
  const st = await fsp.stat(file).catch((): null => null);
  if (!st?.isFile()) throw new Error(`Can't attach ${path.basename(file)}: it isn't a file`);
  if (st.size > CHAT_IMAGE_MAX_BYTES) throw new Error(`Can't attach ${path.basename(file)}: images must be 5 MB or smaller`);
  return { type: 'image', mimeType, path: file };
}

async function file(block: Record<string, unknown>): Promise<ContentBlock> {
  const target = absolutePath(block.path);
  if (!(await fsp.stat(target).catch((): null => null))) throw new Error(`Can't attach ${path.basename(target)}: it no longer exists`);
  return { type: 'file', path: target };
}

/** Check attachments from the renderer and turn them into content blocks for the runtime. */
export async function prepareAttachments(agentId: string, attachments: unknown[], caps: ChatCapabilities | undefined): Promise<ContentBlock[]> {
  if (attachments.length > CHAT_ATTACHMENTS_MAX) throw new Error(`Attach at most ${CHAT_ATTACHMENTS_MAX} files at a time`);
  const out: ContentBlock[] = [];
  for (const raw of attachments) {
    const block = record(raw);
    if (block.type === 'image') out.push(await image(agentId, block, caps));
    else if (block.type === 'file') out.push(await file(block));
    else throw new Error('Attachments must be images or files');
  }
  return out;
}
