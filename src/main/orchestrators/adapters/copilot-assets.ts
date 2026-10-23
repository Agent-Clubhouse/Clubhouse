/**
 * Copilot binary tool results (#2421).
 *
 * A Copilot tool that returns an image (view, screenshot) reports it in
 * `rawOutput.binaryResultsForLlm` as `{ type: 'image', assetId: 'sha256:…',
 * mimeType, byteLength }`, without the bytes. Copilot persists the bytes once,
 * as a `session.binary_asset` event (base64 `data`) in the session's journal,
 * `<session-state>/<sessionId>/events.jsonl`, written just before the tool's
 * `tool.execution_complete`. The asset id is the sha256 of the decoded bytes.
 *
 * Only the agent's own session journal is read: the directory comes from the
 * session id main already tracks, must be a direct child of the session-state
 * folder after symlinks, and the journal must be a regular file. Nothing the
 * agent wrote (a `description` path, say) is ever used as a path.
 *
 * Journals grow large, so reads are async and bounded: each lookup scans only
 * what was appended since the last one (at most SCAN_BUDGET_BYTES, from the
 * end), keeping an index of where each asset's line is.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import type { ChatMediaAssetResult } from '../../../shared/chat/runtime';
import { CHAT_MEDIA_MAX_BYTES, isMediaAssetId } from '../../../shared/chat/media';

/** A plain token: anything else can't be Copilot's session id and is never used as a path. */
export const COPILOT_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Most journal bytes one lookup reads while indexing. */
const SCAN_BUDGET_BYTES = 64 * 1024 * 1024;
/** A long unscanned journal is read from the end in growing windows, up to the budget. */
const TAIL_WINDOWS_BYTES: readonly number[] = [4 * 1024 * 1024, 16 * 1024 * 1024];
const CHUNK_BYTES = 1024 * 1024;
/** How much of a line's start is kept to recognise an asset line. */
const HEAD_BYTES = 4096;
/** An asset line holds at most the image cap as base64, plus the event's other fields. */
const MAX_ASSET_LINE_BYTES = Math.ceil(CHAT_MEDIA_MAX_BYTES / 3) * 4 + 64 * 1024;
/** Assets indexed per session; the oldest are forgotten first. */
const MAX_INDEXED_ASSETS = 1024;
/** Sessions whose journal index is kept. */
const MAX_SESSIONS = 4;
/** Waits before looking again for an asset not in the journal yet. */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [150, 400];
/**
 * Lookups run on the agent's event chain. After this many misses in a row
 * that waiting didn't fix, a session stops waiting (the journal format may
 * have changed), so chat never stalls on every image.
 */
const MAX_FRUITLESS_RETRIES = 2;

const ASSET_LINE_PREFIX = Buffer.from('{"type":"session.binary_asset"');
const ASSET_ID_IN_HEAD = /"assetId":"(sha256:[0-9a-f]{64})"/;

export type CopilotAssetFailure =
  | 'bad_asset_id'
  | 'no_session'
  | 'session_dir_rejected'
  | 'journal_unreadable'
  | 'not_found'
  | 'too_large'
  | 'malformed'
  | 'hash_mismatch';

interface JournalIndex {
  dev: bigint;
  ino: bigint;
  /** Bytes indexed so far: the end of the last complete line seen. */
  scannedTo: number;
  assets: Map<string, { start: number; end: number }>;
}

function fail(reason: CopilotAssetFailure): ChatMediaAssetResult {
  return { ok: false, reason };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface CopilotAssetReaderOptions {
  retryDelaysMs?: readonly number[];
  /** Bytes one lookup may scan (tests shrink it). */
  scanBudgetBytes?: number;
}

/** Reads Copilot binary assets out of one session-state folder's journals. */
export class CopilotAssetReader {
  private readonly indexes = new Map<string, JournalIndex>();
  /** Per session: misses in a row that waiting didn't fix. */
  private readonly fruitless = new Map<string, number>();
  /** One lookup at a time: they share the index. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly retryDelaysMs: readonly number[];
  private readonly scanBudget: number;

  constructor(private readonly stateDir: string, opts: CopilotAssetReaderOptions = {}) {
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.scanBudget = opts.scanBudgetBytes ?? SCAN_BUDGET_BYTES;
  }

  read(sessionId: string | null | undefined, assetId: string): Promise<ChatMediaAssetResult> {
    const next = this.chain.then(() => this.readWithRetry(sessionId, assetId));
    this.chain = next.catch((): void => undefined);
    return next;
  }

  private async readWithRetry(sessionId: string | null | undefined, assetId: string): Promise<ChatMediaAssetResult> {
    if (!isMediaAssetId(assetId)) return fail('bad_asset_id');
    if (!sessionId || !COPILOT_SESSION_ID_RE.test(sessionId)) return fail('no_session');
    let result = await this.readOnce(sessionId, assetId);
    // The tool's result can reach us before Copilot's journal write does.
    if (!result.ok && result.reason === 'not_found' && (this.fruitless.get(sessionId) ?? 0) < MAX_FRUITLESS_RETRIES) {
      for (const delay of this.retryDelaysMs) {
        await sleep(delay);
        result = await this.readOnce(sessionId, assetId);
        if (result.ok || result.reason !== 'not_found') break;
      }
      if (!result.ok && result.reason === 'not_found') this.fruitless.set(sessionId, (this.fruitless.get(sessionId) ?? 0) + 1);
    }
    if (result.ok) this.fruitless.delete(sessionId);
    while (this.fruitless.size > MAX_SESSIONS) this.fruitless.delete(this.fruitless.keys().next().value!);
    return result;
  }

  /** The session's journal, opened only if it really is that session's. */
  private async openJournal(sessionId: string): Promise<fsp.FileHandle | CopilotAssetFailure> {
    const realRoot = await fsp.realpath(this.stateDir).catch((): null => null);
    if (!realRoot) return 'journal_unreadable';
    const realDir = await fsp.realpath(path.join(this.stateDir, sessionId)).catch((): null => null);
    if (!realDir) return 'journal_unreadable';
    // A symlinked session folder pointing anywhere else is refused.
    if (path.dirname(realDir) !== realRoot) return 'session_dir_rejected';
    const file = path.join(realDir, 'events.jsonl');
    const st = await fsp.lstat(file, { bigint: true }).catch((): null => null);
    if (!st) return 'journal_unreadable';
    if (!st.isFile()) return 'session_dir_rejected';
    // No following a symlink swapped in after the check, and no blocking on a FIFO.
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    const handle = await fsp.open(file, flags).catch((): null => null);
    if (!handle) return 'journal_unreadable';
    const opened = await handle.stat({ bigint: true }).catch((): null => null);
    // The folder itself could be swapped for a link between the check and the open.
    const reopened = await fsp.realpath(file).catch((): null => null);
    if (!opened?.isFile() || opened.ino !== st.ino || opened.dev !== st.dev || !reopened || path.dirname(reopened) !== realDir) {
      await handle.close();
      return 'session_dir_rejected';
    }
    return handle;
  }

  private async readOnce(sessionId: string, assetId: string): Promise<ChatMediaAssetResult> {
    const handle = await this.openJournal(sessionId);
    if (typeof handle === 'string') return fail(handle);
    try {
      const st = await handle.stat({ bigint: true });
      const size = Number(st.size);
      let index = this.indexes.get(sessionId);
      // A rewritten journal (compaction replaces the file) starts a new index.
      if (!index || index.ino !== st.ino || index.dev !== st.dev || size < index.scannedTo) index = this.freshIndex(sessionId, st);
      this.indexes.delete(sessionId);
      this.indexes.set(sessionId, index);
      while (this.indexes.size > MAX_SESSIONS) this.indexes.delete(this.indexes.keys().next().value!);

      const known = index.assets.has(assetId);
      if (!known) await this.scanNew(handle, index, size, assetId);
      let at = index.assets.get(assetId);
      if (!at) return fail('not_found');
      let result = await this.readAsset(handle, at, assetId);
      if (!result.ok && known && (result.reason === 'malformed' || result.reason === 'hash_mismatch')) {
        // A journal rewritten in place keeps its inode: the offsets are stale. Index it again once.
        index = this.freshIndex(sessionId, st);
        await this.scanNew(handle, index, size, assetId);
        at = index.assets.get(assetId);
        result = at ? await this.readAsset(handle, at, assetId) : fail('not_found');
      }
      return result;
    } finally {
      await handle.close();
    }
  }

  private freshIndex(sessionId: string, st: { dev: bigint; ino: bigint }): JournalIndex {
    const index: JournalIndex = { dev: st.dev, ino: st.ino, scannedTo: 0, assets: new Map() };
    this.indexes.set(sessionId, index);
    return index;
  }

  /**
   * Index asset lines appended since the last scan. A long stretch (a first
   * lookup in a big journal) is read from the end, where a just-finished
   * tool's asset is, in growing windows that stop once `assetId` turns up,
   * never more than the budget.
   */
  private async scanNew(handle: fsp.FileHandle, index: JournalIndex, size: number, assetId: string): Promise<void> {
    const from = index.scannedTo;
    if (size - from <= Math.min(TAIL_WINDOWS_BYTES[0], this.scanBudget)) {
      index.scannedTo = await this.scan(handle, index, from, size, size);
      return;
    }
    const limit = Math.min(size - from, this.scanBudget);
    const windows = [...TAIL_WINDOWS_BYTES.filter((w) => w < limit), limit];
    let end = size;
    for (const window of windows) {
      const start = size - window;
      const scanned = await this.scan(handle, index, start, end, size);
      // Only the newest window's end is where the next scan carries on from.
      if (end === size) index.scannedTo = scanned;
      if (index.assets.has(assetId)) return;
      // The next window takes the lines that start before this one.
      end = start;
    }
  }

  /**
   * Index the asset lines that start in [start, end), reading on past `end`
   * (up to `size`) to finish the last one. A line cut at `start` belongs to
   * an earlier window and is skipped. Returns where the next line starts.
   */
  private async scan(handle: fsp.FileHandle, index: JournalIndex, start: number, end: number, size: number): Promise<number> {
    let partial = false;
    if (start > 0) {
      // Mid-file: the first line is whole only when the byte before it ends a line.
      const before = Buffer.alloc(1);
      await handle.read(before, 0, 1, start - 1);
      partial = before[0] !== 0x0a;
    }
    const buf = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(1, size - start)));
    let pos = start;
    let lineStart = start;
    let head: Buffer[] = [];
    let headLength = 0;
    while (pos < size && lineStart < end) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (!bytesRead) break;
      const chunk = buf.subarray(0, bytesRead);
      let i = 0;
      while (i < chunk.length && lineStart < end) {
        const nl = chunk.indexOf(0x0a, i);
        const end = nl < 0 ? chunk.length : nl;
        if (!partial && headLength < HEAD_BYTES) {
          const piece = chunk.subarray(i, Math.min(end, i + HEAD_BYTES - headLength));
          head.push(Buffer.from(piece));
          headLength += piece.length;
        }
        if (nl < 0) break;
        if (!partial) this.indexLine(index, Buffer.concat(head, headLength), lineStart, pos + nl);
        partial = false;
        head = [];
        headLength = 0;
        lineStart = pos + nl + 1;
        i = nl + 1;
      }
      pos += bytesRead;
    }
    // A line still being written is read again next time.
    return lineStart;
  }

  private indexLine(index: JournalIndex, head: Buffer, start: number, end: number): void {
    if (head.length < ASSET_LINE_PREFIX.length || !head.subarray(0, ASSET_LINE_PREFIX.length).equals(ASSET_LINE_PREFIX)) return;
    const match = ASSET_ID_IN_HEAD.exec(head.toString('latin1'));
    if (!match) return;
    index.assets.delete(match[1]);
    index.assets.set(match[1], { start, end });
    while (index.assets.size > MAX_INDEXED_ASSETS) index.assets.delete(index.assets.keys().next().value!);
  }

  private async readAsset(handle: fsp.FileHandle, at: { start: number; end: number }, assetId: string): Promise<ChatMediaAssetResult> {
    const length = at.end - at.start;
    if (length > MAX_ASSET_LINE_BYTES) return fail('too_large');
    const line = Buffer.alloc(length);
    const { bytesRead } = await handle.read(line, 0, length, at.start);
    if (bytesRead !== length) return fail('malformed');
    let event: { type?: unknown; data?: { assetId?: unknown; data?: unknown; byteLength?: unknown } };
    try {
      event = JSON.parse(line.toString('utf8'));
    } catch {
      // telemetry-exempt: reported as the asset's failure reason, logged by the caller.
      return fail('malformed');
    }
    const data = event?.data;
    if (event?.type !== 'session.binary_asset' || data?.assetId !== assetId || typeof data.data !== 'string') return fail('malformed');
    if (typeof data.byteLength === 'number' && data.byteLength > CHAT_MEDIA_MAX_BYTES) return fail('too_large');
    const bytes = Buffer.from(data.data, 'base64');
    if (!bytes.length) return fail('malformed');
    if (bytes.length > CHAT_MEDIA_MAX_BYTES) return fail('too_large');
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== assetId) return fail('hash_mismatch');
    return { ok: true, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length) };
  }
}
