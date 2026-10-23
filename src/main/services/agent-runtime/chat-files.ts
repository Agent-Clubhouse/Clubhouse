/**
 * File chips in chat (experimental `richChatContent`, #2350).
 *
 * The renderer finds path-like text in agent messages and tool output and asks
 * here which of them are real files. Main resolves each against the agent's
 * own roots (its cwd or worktree and its project, plus its chat media folder
 * and its CLI's session-output folder), symlinks included, and answers only
 * for files inside them. Previews are read
 * here too, with size caps and byte sniffing; the renderer gets text or bytes,
 * never something it could load by path.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ChatFileInfo, ChatFileKind, ChatFilePreview, ChatLocalImageResult } from '../../../shared/chat';
import { CHAT_FILE_PREVIEW_MEDIA_MAX_BYTES, CHAT_FILE_PREVIEW_TEXT_MAX_BYTES, CHAT_MEDIA_MAX_BYTES, CHAT_MEDIA_MAX_PIXELS, mediaDimensions, sniffMediaType } from '../../../shared/chat';
import { agentRegistry } from '../agent-registry';
import { checkAllowedPath, resolveAllowedPath, storeMedia } from './chat-media';
import { agentMediaDir } from './chat-transcript';
import { agentSessionOutputRoots, inSessionOutputArea } from './session-output';

/** More candidates than this in one request are ignored. */
export const MAX_STAT_PATHS = 200;
const MAX_PATH_LENGTH = 1024;
const HEAD_BYTES = 4096;

const VIDEO_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/mp4', '.ogv': 'video/ogg' };
const AUDIO_TYPES: Record<string, string> = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.flac': 'audio/flac', '.opus': 'audio/ogg' };

/** How long an agent's roots are reused: a message's lookups share one answer. */
const ROOTS_TTL_MS = 5_000;
const rootsCache = new Map<string, { at: number; roots: Promise<string[]> }>();

/** True when `p` is `root` or lexically inside it. */
function within(p: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Roots an agent's paths may resolve in: where it runs, its project, its
 * media folder, and the live session's own output folder (#2422). The
 * working folder counts only inside the project: a worktree path read from a
 * project's agent config can't widen the allowlist.
 */
export function agentRoots(agentId: string): Promise<string[]> {
  const hit = rootsCache.get(agentId);
  if (hit && Date.now() - hit.at < ROOTS_TTL_MS) return hit.roots;
  const roots = findAgentRoots(agentId);
  rootsCache.set(agentId, { at: Date.now(), roots });
  return roots;
}

/** For tests. */
export function clearAgentRootsCache(): void {
  rootsCache.clear();
}

async function findAgentRoots(agentId: string): Promise<string[]> {
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
  const roots = [project];
  // First, so relative paths resolve against it.
  if (cwd && path.isAbsolute(cwd) && within(cwd, project)) roots.unshift(cwd);
  roots.push(agentMediaDir(agentId));
  roots.push(...await agentSessionOutputRoots(agentId));
  return [...new Set(roots)];
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
  // `~/x`: the user's home (the allowlist still decides).
  if (/^~[\\/]/.test(p)) p = path.join(os.homedir(), p.slice(2));
  return p;
}

async function readHead(handle: fsp.FileHandle, size: number): Promise<Uint8Array> {
  const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
  const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
  return new Uint8Array(buf.subarray(0, bytesRead));
}

/** What a file holds, from its bytes (images, text) and then its extension (video, audio). */
function kindOf(real: string, head: Uint8Array): { kind: ChatFileKind; mimeType?: string } {
  const image = sniffMediaType(head);
  if (image) return { kind: 'image', mimeType: image };
  const ext = path.extname(real).toLowerCase();
  if (VIDEO_TYPES[ext]) return { kind: 'video', mimeType: VIDEO_TYPES[ext] };
  if (AUDIO_TYPES[ext]) return { kind: 'audio', mimeType: AUDIO_TYPES[ext] };
  // Text: no NUL bytes at the start. Good enough to choose a preview.
  if (!head.includes(0)) return { kind: 'text' };
  return { kind: 'other' };
}

/** Open a resolved path for reading without following a swap or blocking on a FIFO. */
async function openFile(real: string): Promise<{ handle: fsp.FileHandle; size: number } | undefined> {
  const handle = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)).catch((): null => null);
  if (!handle) return undefined;
  const st = await handle.stat().catch((): null => null);
  if (!st?.isFile()) { await handle.close(); return undefined; }
  return { handle, size: st.size };
}

/**
 * Which candidate paths are files inside the agent's roots. Relative paths
 * resolve against the agent's cwd. Paths it can't confirm come back with
 * `exists: false` and nothing else.
 */
export async function statChatPaths(agentId: string, candidates: readonly string[]): Promise<ChatFileInfo[]> {
  const roots = await agentRoots(agentId);
  const out: ChatFileInfo[] = [];
  for (const candidate of candidates.slice(0, MAX_STAT_PATHS)) {
    const missing: ChatFileInfo = { path: candidate, exists: false };
    if (typeof candidate !== 'string' || !candidate || candidate.length > MAX_PATH_LENGTH) { out.push(missing); continue; }
    const real = roots.length ? await resolveAllowedPath(cleanCandidate(candidate), roots) : undefined;
    const opened = real ? await openFile(real) : undefined;
    if (!real || !opened) { out.push(missing); continue; }
    try {
      const { kind } = kindOf(real, await readHead(opened.handle, opened.size));
      out.push({ path: candidate, exists: true, kind, size: opened.size, name: path.basename(real) });
    } finally {
      await opened.handle.close();
    }
  }
  return out;
}

/** A file's preview: capped text, or image or media bytes under their caps; else just its kind. */
export async function readChatFilePreview(agentId: string, candidate: string): Promise<ChatFilePreview> {
  if (!candidate || candidate.length > MAX_PATH_LENGTH) throw new Error('Not a file path');
  const real = await resolveAllowedPath(cleanCandidate(candidate), await agentRoots(agentId));
  const opened = real ? await openFile(real) : undefined;
  if (!real || !opened) throw new Error('That file is not available');
  const { handle, size } = opened;
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
    return { kind, name, size, tooLarge: kind !== 'other' };
  } finally {
    await handle.close();
  }
}

/** The real path of an allowed file, for Reveal and Open in Files. Throws when it isn't one. */
export async function resolveChatFile(agentId: string, candidate: string): Promise<string> {
  if (!candidate || candidate.length > MAX_PATH_LENGTH) throw new Error('Not a file path');
  const real = await resolveAllowedPath(cleanCandidate(candidate), await agentRoots(agentId));
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
 * agent's cwd), a `file:` URL, either possibly percent-encoded. Answers why
 * not when the file is outside the agent's roots, missing, not an image the
 * chat shows, or over the size caps.
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
  const roots = await agentRoots(agentId);
  const cleaned = cleanCandidate(src);
  if (!cleaned) return { ok: false, reason: 'missing' };
  let checked = await checkAllowedPath(cleaned, roots);
  // Markdown writes spaces as %20; file: URLs were decoded already.
  const decoded = !/^file:/i.test(src.trim()) ? percentDecoded(cleaned) : undefined;
  if ('denied' in checked && decoded) {
    const second = await checkAllowedPath(decoded, roots);
    if ('real' in second || checked.denied === 'outside') checked = second;
  }
  if ('denied' in checked) {
    // A screenshot from a session that is no longer live: say so rather than "outside the project".
    if (checked.denied === 'outside' && [cleaned, decoded].some((p) => p && inSessionOutputArea(agentId, p))) return { ok: false, reason: 'session-ended' };
    return { ok: false, reason: checked.denied };
  }
  const opened = await openFile(checked.real);
  if (!opened) return { ok: false, reason: 'missing' };
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
