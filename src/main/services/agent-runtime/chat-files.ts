/**
 * File chips in chat (experimental `richChatContent`, #2350).
 *
 * The renderer finds path-like text in agent messages and tool output and asks
 * here which of them are real files. Main resolves each one, symlinks
 * included (relative paths against the agent's working folder), and answers
 * for any regular file the user can read, wherever it is: an agent with a
 * terminal could copy it into the project anyway, so a folder allowlist only
 * added friction (#2478). Previews are read here too, non-blocking, with size
 * caps and byte sniffing; the renderer gets text or bytes, never something it
 * could load by path.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ChatFileInfo, ChatFileKind, ChatFilePreview, ChatFileUnavailable, ChatLocalImageResult } from '../../../shared/chat';
import { CHAT_FILE_PREVIEW_MEDIA_MAX_BYTES, CHAT_FILE_PREVIEW_PDF_MAX_BYTES, CHAT_FILE_PREVIEW_TEXT_MAX_BYTES, CHAT_MEDIA_MAX_BYTES, CHAT_MEDIA_MAX_PIXELS, mediaDimensions, sniffMediaType } from '../../../shared/chat';
import { agentRegistry } from '../agent-registry';
import { resolveLocalPath, storeMedia } from './chat-media';
import { agentMediaDir } from './chat-transcript';
import { agentSessionOutputRoots } from './session-output';

/** More candidates than this in one request are ignored. */
export const MAX_STAT_PATHS = 200;
const MAX_PATH_LENGTH = 1024;
const HEAD_BYTES = 4096;

const VIDEO_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/mp4', '.ogv': 'video/ogg' };
const AUDIO_TYPES: Record<string, string> = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.flac': 'audio/flac', '.opus': 'audio/ogg' };

/** How long an agent's folders are reused: a message's lookups share one answer. */
const FOLDERS_TTL_MS = 5_000;
const foldersCache = new Map<string, { at: number; folders: Promise<string[]> }>();

/**
 * Where an agent works: its working folder or worktree first (relative paths
 * resolve against it), then its project, its media folder, and the live
 * session's own output folder (#2422). Not a limit on what chat may show
 * (#2478): Annex hands these to phones as `contentRoots`, so older phones
 * know which absolute paths to link.
 */
export function agentFolders(agentId: string): Promise<string[]> {
  const hit = foldersCache.get(agentId);
  if (hit && Date.now() - hit.at < FOLDERS_TTL_MS) return hit.folders;
  const folders = findAgentFolders(agentId);
  foldersCache.set(agentId, { at: Date.now(), folders });
  return folders;
}

/** For tests. */
export function clearAgentFoldersCache(): void {
  foldersCache.clear();
}

async function findAgentFolders(agentId: string): Promise<string[]> {
  let project: string | undefined;
  let cwd: string | undefined;
  const live = agentRegistry.get(agentId);
  if (live) {
    project = live.projectPath;
    cwd = live.cwd;
  } else {
    // A sleeping agent: find it in its project's durable config. Loaded on use:
    // both modules start services when imported.
    const projectStore = await import('../project-store');
    const { getDurableConfig } = await import('../agent-config');
    for (const candidate of await projectStore.list().catch((): Awaited<ReturnType<typeof projectStore.list>> => [])) {
      if (!candidate.path) continue;
      const config = await getDurableConfig(candidate.path, agentId).catch((): null => null);
      if (!config) continue;
      project = candidate.path;
      cwd = config.worktreePath;
      break;
    }
  }
  if (!project || !path.isAbsolute(project)) return [];
  const folders = [project];
  // First, so relative paths resolve against it.
  if (cwd && path.isAbsolute(cwd)) folders.unshift(cwd);
  folders.push(agentMediaDir(agentId));
  folders.push(...await agentSessionOutputRoots(agentId));
  return [...new Set(folders)];
}

/** The folder an agent's relative paths resolve against, if it has one. */
async function agentBase(agentId: string): Promise<string | undefined> {
  return (await agentFolders(agentId))[0];
}

/** Strip a `:line[:col]` suffix the renderer may have left on, and a `file://` prefix. */
function cleanCandidate(raw: string): string {
  let p = raw.trim();
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      // telemetry-exempt: a malformed file: URL just isn't a path.
      return '';
    }
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  }
  p = p.replace(/:(\d+)(:\d+)?$/, '');
  // `~/x`: the user's home.
  if (/^~[\\/]/.test(p)) p = path.join(os.homedir(), p.slice(2));
  return p;
}

async function readHead(handle: fsp.FileHandle, size: number): Promise<Uint8Array> {
  const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
  const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
  return new Uint8Array(buf.subarray(0, bytesRead));
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** True when the bytes start with a PDF header. */
export function isPdfHeader(head: Uint8Array): boolean {
  return head.length >= PDF_MAGIC.length && PDF_MAGIC.every((b, i) => head[i] === b);
}

/**
 * What a file holds, from its bytes (images, PDF, text) and then its
 * extension (video, audio). PDF comes before text: one whose first 4 KB has
 * no NUL byte would otherwise show as `%PDF-…` text.
 */
function kindOf(real: string, head: Uint8Array): { kind: ChatFileKind; mimeType?: string } {
  const image = sniffMediaType(head);
  if (image) return { kind: 'image', mimeType: image };
  if (isPdfHeader(head)) return { kind: 'pdf', mimeType: 'application/pdf' };
  const ext = path.extname(real).toLowerCase();
  if (VIDEO_TYPES[ext]) return { kind: 'video', mimeType: VIDEO_TYPES[ext] };
  if (AUDIO_TYPES[ext]) return { kind: 'audio', mimeType: AUDIO_TYPES[ext] };
  // Text: no NUL bytes at the start. Good enough to choose a preview.
  if (!head.includes(0)) return { kind: 'text' };
  return { kind: 'other' };
}

/** True when a file of this kind and size is over its preview's cap. Text never is: it's cut short. */
function overPreviewCap(kind: ChatFileKind, size: number): boolean {
  if (kind === 'image') return size > CHAT_MEDIA_MAX_BYTES;
  if (kind === 'video' || kind === 'audio') return size > CHAT_FILE_PREVIEW_MEDIA_MAX_BYTES;
  if (kind === 'pdf') return size > CHAT_FILE_PREVIEW_PDF_MAX_BYTES;
  return false;
}

type Opened = { handle: fsp.FileHandle; size: number };

/**
 * Open a resolved path for reading without following a swap or blocking on a
 * FIFO, or say why not.
 */
async function openFile(real: string): Promise<Opened | { reason: ChatFileUnavailable }> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch (err) {
    // telemetry-exempt: becomes the chip's reason.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { reason: 'missing' };
    // Windows refuses to open a folder (EISDIR, EACCES or EPERM); elsewhere it opens and fails the check below.
    if (code === 'EISDIR' || await fsp.stat(real).then((st) => st.isDirectory(), () => false)) return { reason: 'folder' };
    return { reason: 'unreadable' };
  }
  const st = await handle.stat().catch((): null => null);
  if (!st?.isFile()) {
    await handle.close();
    return { reason: st?.isDirectory() ? 'folder' : 'not-a-file' };
  }
  return { handle, size: st.size };
}

/** Resolve and open a path an agent named, or say why it can't be shown. */
async function openChatPath(agentId: string, candidate: string): Promise<(Opened & { real: string }) | { reason: ChatFileUnavailable }> {
  if (typeof candidate !== 'string' || !candidate || candidate.length > MAX_PATH_LENGTH) return { reason: 'missing' };
  const cleaned = cleanCandidate(candidate);
  const real = cleaned ? await resolveLocalPath(cleaned, path.isAbsolute(cleaned) ? undefined : await agentBase(agentId)) : undefined;
  if (!real) return { reason: 'missing' };
  const opened = await openFile(real);
  return 'reason' in opened ? opened : { ...opened, real };
}

/**
 * What each candidate path is: a file's kind and size, or why it can't be
 * shown. Relative paths resolve against the agent's cwd; any other readable
 * file counts, wherever it is.
 */
export async function statChatPaths(agentId: string, candidates: readonly string[]): Promise<ChatFileInfo[]> {
  const out: ChatFileInfo[] = [];
  for (const candidate of candidates.slice(0, MAX_STAT_PATHS)) {
    const opened = await openChatPath(agentId, candidate);
    if ('reason' in opened) { out.push({ path: candidate, exists: false, reason: opened.reason }); continue; }
    try {
      const { kind } = kindOf(opened.real, await readHead(opened.handle, opened.size));
      out.push({ path: candidate, exists: true, kind, size: opened.size, name: path.basename(opened.real), ...(overPreviewCap(kind, opened.size) && { tooLarge: true }) });
    } finally {
      await opened.handle.close();
    }
  }
  return out;
}

/** A file's preview: capped text, or image, media or PDF bytes under their caps; else just its kind. */
export async function readChatFilePreview(agentId: string, candidate: string): Promise<ChatFilePreview> {
  if (!candidate || candidate.length > MAX_PATH_LENGTH) throw new Error('Not a file path');
  const opened = await openChatPath(agentId, candidate);
  if ('reason' in opened) throw new Error('That file is not available');
  const { handle, size, real } = opened;
  try {
    const name = path.basename(real);
    const { kind, mimeType } = kindOf(real, await readHead(handle, size));
    const readUpTo = async (cap: number) => {
      const buf = Buffer.alloc(Math.min(size, cap));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead);
    };
    if (kind === 'text') {
      const bytes = await readUpTo(CHAT_FILE_PREVIEW_TEXT_MAX_BYTES);
      return { kind, name, size, text: bytes.toString('utf-8'), truncated: size > bytes.length };
    }
    if (kind === 'image' && size <= CHAT_MEDIA_MAX_BYTES) {
      const data = new Uint8Array(await readUpTo(CHAT_MEDIA_MAX_BYTES));
      // Sniff the whole read again: the type comes from the bytes we return.
      const sniffed = sniffMediaType(data);
      // A small file can declare a huge canvas; the renderer would try to decode it.
      const dims = sniffed ? mediaDimensions(data, sniffed) : undefined;
      if (sniffed && !(dims && dims.width * dims.height > CHAT_MEDIA_MAX_PIXELS)) return { kind, name, size, mimeType: sniffed, data };
    }
    if ((kind === 'video' || kind === 'audio') && mimeType && size <= CHAT_FILE_PREVIEW_MEDIA_MAX_BYTES) {
      return { kind, name, size, mimeType, data: new Uint8Array(await readUpTo(CHAT_FILE_PREVIEW_MEDIA_MAX_BYTES)) };
    }
    if (kind === 'pdf' && size <= CHAT_FILE_PREVIEW_PDF_MAX_BYTES) {
      const data = new Uint8Array(await readUpTo(CHAT_FILE_PREVIEW_PDF_MAX_BYTES));
      // Check the bytes returned: the file may have changed since its head was read.
      if (isPdfHeader(data)) return { kind, name, size, mimeType: 'application/pdf', data };
    }
    return { kind, name, size, tooLarge: kind !== 'other' };
  } finally {
    await handle.close();
  }
}

/** The real path of a file an agent named, for Reveal and Open in Files. Throws when there's nothing there. */
export async function resolveChatFile(agentId: string, candidate: string): Promise<string> {
  if (!candidate || candidate.length > MAX_PATH_LENGTH) throw new Error('Not a file path');
  const cleaned = cleanCandidate(candidate);
  const real = cleaned ? await resolveLocalPath(cleaned, path.isAbsolute(cleaned) ? undefined : await agentBase(agentId)) : undefined;
  if (!real) throw new Error('That file is not available');
  return real;
}

/** `%20` and the like decoded, or undefined when there's nothing to decode (or it won't). */
function percentDecoded(p: string): string | undefined {
  if (!/%[0-9A-Fa-f]{2}/.test(p)) return undefined;
  try {
    const decoded = decodeURIComponent(p);
    return decoded !== p ? decoded : undefined;
  } catch {
    // telemetry-exempt: a stray % is part of the name.
    return undefined;
  }
}

/**
 * A local image named in agent markdown (`![alt](src)`, #2422), stored in the
 * agent's media folder so the renderer can show it by reference. `src` is the
 * image's address as written: a path (relative ones resolve against the
 * agent's cwd), a `file:` URL, either possibly percent-encoded. It may be
 * anywhere the user can read (#2478). Answers why not when the file is
 * missing, not an image the chat shows, or over the size caps.
 */
export async function importChatImage(agentId: string, src: string): Promise<ChatLocalImageResult> {
  // Each read can hold up to the image cap in memory: a message with many images takes turns.
  while (importsRunning >= MAX_CONCURRENT_IMPORTS) await new Promise<void>((resolve) => importWaiters.push(resolve));
  importsRunning++;
  try {
    return await importOne(agentId, src);
  } finally {
    importsRunning--;
    importWaiters.shift()?.();
  }
}

/** Local image imports read at most this many files at once. */
const MAX_CONCURRENT_IMPORTS = 2;
let importsRunning = 0;
const importWaiters: Array<() => void> = [];

async function importOne(agentId: string, src: string): Promise<ChatLocalImageResult> {
  if (!src || src.length > MAX_PATH_LENGTH) return { ok: false, reason: 'missing' };
  const cleaned = cleanCandidate(src);
  if (!cleaned) return { ok: false, reason: 'missing' };
  const base = path.isAbsolute(cleaned) ? undefined : await agentBase(agentId);
  let real = await resolveLocalPath(cleaned, base);
  // Markdown writes spaces as %20; file: URLs were decoded already.
  const decoded = !real && !/^file:/i.test(src.trim()) ? percentDecoded(cleaned) : undefined;
  if (decoded) real = await resolveLocalPath(decoded, base);
  if (!real) return { ok: false, reason: 'missing' };
  const opened = await openFile(real);
  if ('reason' in opened) return { ok: false, reason: opened.reason === 'missing' || opened.reason === 'unreadable' ? 'missing' : 'unsupported' };
  let data: Uint8Array;
  try {
    if (opened.size === 0) return { ok: false, reason: 'unsupported' };
    if (opened.size > CHAT_MEDIA_MAX_BYTES) return { ok: false, reason: 'too-large' };
    const buf = Buffer.alloc(opened.size);
    const { bytesRead } = await opened.handle.read(buf, 0, buf.length, 0);
    data = new Uint8Array(buf.subarray(0, bytesRead));
  } finally {
    await opened.handle.close();
  }
  const sniffed = sniffMediaType(data);
  if (!sniffed) return { ok: false, reason: 'unsupported' };
  const dims = mediaDimensions(data, sniffed);
  if (dims && dims.width * dims.height > CHAT_MEDIA_MAX_PIXELS) return { ok: false, reason: 'too-large' };
  const image = await storeMedia(agentId, data).catch((): undefined => undefined);
  if (!image?.mediaRef) return { ok: false, reason: 'unavailable' };
  return { ok: true, mediaRef: image.mediaRef, mimeType: image.mimeType, ...(image.width && image.height && { width: image.width, height: image.height }) };
}
