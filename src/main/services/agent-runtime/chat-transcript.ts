/** Session transcripts and a small per-agent index. Legacy agent logs are kept after migration. */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import { appLog } from '../log-service';
import { isChatEvent, type ChatEvent, type ChatSessionSummary } from '../../../shared/chat';

function transcriptDir(): string {
  return path.join(app.getPath('userData'), 'agent-logs', 'chat');
}
function segment(id: string): string {
  return encodeURIComponent(id).replace(/\./g, '%2E');
}
function sessionDir(agentId: string): string {
  return path.join(transcriptDir(), segment(agentId));
}
/** Without a session id, returns the legacy path (read-only after migration). */
export function transcriptPath(agentId: string, sessionId?: string): string {
  return sessionId === undefined
    ? path.join(transcriptDir(), `${agentId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`)
    : path.join(sessionDir(agentId), `${segment(sessionId)}.jsonl`);
}
interface SessionEntry extends ChatSessionSummary { bytes: number; lastStartedAt?: number }
interface SessionIndex {
  version: 1;
  currentSessionId: string | null;
  sessions: SessionEntry[];
  /**
   * Size of the legacy log already split into session files. If the log grows
   * later (an older build appended to it), the new part is imported on load.
   */
  legacyBytes?: number;
}
interface AgentState {
  agentId: string;
  index: SessionIndex;
  /** Sizes of files this process has checked or written. Each ends with a line break. */
  sizes: Map<string, number>;
  /** The index has changes not yet saved. After a crash, the repair pass rebuilds them. */
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** An index change waits this long before it is saved, so a burst of appends shares one write. */
const INDEX_SAVE_DELAY_MS = 1_000;
/** After a failed migration or index load, appends skip retrying it for this long. */
const MIGRATION_RETRY_MS = 10_000;

const chains = new Map<string, Promise<unknown>>();
const states = new Map<string, AgentState>();
const migrationRetryAt = new Map<string, number>();
let stagingCleanup: Promise<void> | undefined;

/** Run once at startup, before any migration can create a new staging folder. */
export function cleanupTranscriptStaging(): Promise<void> {
  return stagingCleanup ??= (async () => {
    try {
      const entries = await fsp.readdir(transcriptDir(), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && /\.migrating-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.name)) {
          await fsp.rm(path.join(transcriptDir(), entry.name), { recursive: true, force: true });
        }
      }
    } catch (error) {
      // telemetry-exempt: best-effort startup cleanup; failures are logged locally.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        appLog('core:chat', 'warn', 'Could not clean up chat migration staging folders', { meta: { error: String(error) } });
      }
    }
  })();
}

function selectCurrent(index: SessionIndex): void {
  // An old session can finish after its replacement starts. Only a start (or
  // the first known event when no start marker exists) establishes recency.
  index.currentSessionId = [...index.sessions].reverse().sort((a, b) =>
    (b.lastStartedAt ?? b.startedAt) - (a.lastStartedAt ?? a.startedAt))[0]?.sessionId ?? null;
}

/** Reads, migration and appends share the lock, including writes to the index. */
function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).catch((): void => undefined).then(work);
  chains.set(key, next);
  void next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch((): void => undefined);
  return next;
}
/** Waits for the agent's queued work and saves any pending index change. */
export async function flushTranscript(agentId: string): Promise<void> {
  const dir = sessionDir(agentId);
  const state = states.get(dir);
  if (state?.timer) { clearTimeout(state.timer); state.timer = undefined; }
  await serialized(dir, async () => {
    const current = states.get(dir);
    if (current) await saveDirtyIndex(current);
  });
}
function parseEvents(raw: string): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const line of raw.split('\n')) {
    try {
      const value: unknown = JSON.parse(line);
      if (isChatEvent(value)) events.push(value);
    } catch {
      // telemetry-exempt: recover valid events around crash-torn or foreign lines.
    }
  }
  return events;
}
async function readText(file: string): Promise<string> {
  try { return await fsp.readFile(file, 'utf-8'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw err; }
}
async function readBytes(file: string): Promise<Buffer> {
  try { return await fsp.readFile(file); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0); throw err; }
}
async function readRange(file: string, start: number, end: number): Promise<Buffer> {
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
async function saveIndex(dir: string, index: SessionIndex): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  const temp = path.join(dir, 'index.json.tmp');
  await fsp.writeFile(temp, JSON.stringify(index), 'utf-8');
  await fsp.rename(temp, path.join(dir, 'index.json'));
}
/** Writes a file and flushes it to disk before returning. */
async function writeDurable(file: string, content: string): Promise<void> {
  const handle = await fsp.open(file, 'w');
  try {
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
  } finally { await handle.close(); }
}
/** Flushes a directory's entries to disk. POSIX only: Windows can't open a directory to sync it. */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const handle = await fsp.open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    // telemetry-exempt: some filesystems reject directory sync; the file contents are already synced.
    appLog('core:chat', 'debug', 'Could not sync chat transcript folder', { meta: { dir, error: String(error) } });
  }
}
/** Size of a file and the separator needed before appending, so a crash-torn last line stays separate. */
async function lineEnd(file: string): Promise<{ size: number | undefined; prefix: string }> {
  try {
    const handle = await fsp.open(file, 'r');
    try {
      const { size } = await handle.stat();
      if (!size) return { size, prefix: '' };
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      return { size, prefix: last[0] === 10 ? '' : '\n' };
    } finally { await handle.close(); }
  } catch (error) {
    // telemetry-exempt: writing can still succeed when reading is denied.
    // Separate a possibly torn line without requiring access to read it.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { size: 0, prefix: '' };
    return { size: undefined, prefix: '\n' };
  }
}
/**
 * Appends whole lines. A file's end is checked the first time this process
 * writes it; after that its size is tracked, so an append is a single write.
 * Returns the new size, if known.
 */
async function appendLines(file: string, text: string, sizes?: Map<string, number>): Promise<number | undefined> {
  let size = sizes?.get(file);
  let prefix = '';
  if (size === undefined) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    ({ size, prefix } = await lineEnd(file));
  }
  const data = prefix + text;
  try {
    await fsp.appendFile(file, data, 'utf-8');
  } catch (error) {
    // A partial write leaves the end unknown; check it again next time.
    sizes?.delete(file);
    throw error;
  }
  if (size === undefined) return undefined;
  const next = size + Buffer.byteLength(data);
  sizes?.set(file, next);
  return next;
}
function record(index: SessionIndex, event: ChatEvent): SessionEntry {
  let entry = index.sessions.find((s) => s.sessionId === event.sessionId);
  if (!entry) {
    entry = { sessionId: event.sessionId, startedAt: event.ts, lastActiveAt: event.ts, lastSeq: 0, bytes: 0 };
    index.sessions.push(entry);
  }
  entry.lastSeq = Math.max(entry.lastSeq, event.seq);
  entry.lastActiveAt = Math.max(entry.lastActiveAt, event.ts);
  if (event.type === 'session_started') {
    entry.lastStartedAt = Math.max(entry.lastStartedAt ?? 0, event.ts);
    entry.driver = event.data.driver;
    entry.provider = event.data.provider;
    delete entry.endedAt;
  }
  if ((event.type === 'session_started' || event.type === 'session_info') && event.data.nativeSessionId) {
    entry.nativeSessionId = event.data.nativeSessionId;
  }
  if (event.type === 'session_ended') entry.endedAt = event.ts;
  if (event.type === 'user_message' && !entry.title) {
    entry.title = event.data.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').slice(0, 120);
  }
  selectCurrent(index);
  return entry;
}
function groupBySession(events: ChatEvent[]): Map<string, ChatEvent[]> {
  const grouped = new Map<string, ChatEvent[]>();
  for (const event of events) {
    const list = grouped.get(event.sessionId) ?? [];
    list.push(event);
    grouped.set(event.sessionId, list);
  }
  return grouped;
}

/**
 * Splits the legacy log in a staging folder. Only a verified, complete split
 * that has reached the disk is published; the original is never changed or
 * deleted. Returns false when there is nothing to migrate.
 */
async function migrateLegacy(agentId: string, index: SessionIndex): Promise<boolean> {
  const raw = await readBytes(transcriptPath(agentId));
  const legacy = parseEvents(raw.toString('utf-8'));
  if (!legacy.length) return false;
  const dir = sessionDir(agentId);
  const staging = `${dir}.migrating-${randomUUID()}`;
  await fsp.mkdir(staging, { recursive: true });
  try {
    for (const event of legacy) record(index, event);
    for (const [id, events] of groupBySession(legacy)) {
      const file = path.join(staging, `${segment(id)}.jsonl`);
      const content = events.map((e) => JSON.stringify(e) + '\n').join('');
      await writeDurable(file, content);
      if (await readText(file) !== content) throw new Error('Chat transcript migration verification failed');
      index.sessions.find((s) => s.sessionId === id)!.bytes = Buffer.byteLength(content);
    }
    index.legacyBytes = raw.length;
    await writeDurable(path.join(staging, 'index.json'), JSON.stringify(index));
    // A published folder is never migrated again, so its files must be on disk
    // before the rename: after a power loss it must not hold empty files.
    await syncDirectory(staging);
    await fsp.rename(staging, dir);
    await syncDirectory(transcriptDir());
  } finally { await fsp.rm(staging, { recursive: true, force: true }); }
  return true;
}

/**
 * Imports events an older build appended to the legacy log after migration.
 * Events already in a session file are skipped, so an import interrupted
 * before the index recorded it can safely run again.
 */
async function importLegacyGrowth(state: AgentState): Promise<void> {
  const { agentId, index } = state;
  const legacyFile = transcriptPath(agentId);
  try {
    let size: number;
    try { size = (await fsp.stat(legacyFile)).size; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      index.legacyBytes = 0;
      return;
    }
    const recorded = index.legacyBytes;
    if (recorded === size) return;
    // Unknown (split by a build that didn't record it) or shrunk (replaced):
    // compare the whole log. Duplicates are skipped below.
    const start = recorded !== undefined && recorded < size ? recorded : 0;
    const events = parseEvents((await readRange(legacyFile, start, size)).toString('utf-8'));
    let imported = 0;
    for (const [id, list] of groupBySession(events)) {
      const file = transcriptPath(agentId, id);
      const existing = new Set(parseEvents(await readText(file)).map((e) => JSON.stringify(e)));
      const missing = list.filter((e) => !existing.has(JSON.stringify(e)));
      if (!missing.length) continue;
      await appendLines(file, missing.map((e) => JSON.stringify(e) + '\n').join(''), state.sizes);
      imported += missing.length;
    }
    index.legacyBytes = size;
    if (imported) {
      appLog('core:chat', 'info', 'Imported chat events added to the legacy log after migration', { meta: { agentId, imported } });
    }
  } catch (error) {
    // telemetry-exempt: the legacy log is untouched and the import runs again on the next load.
    appLog('core:chat', 'warn', 'Could not import chat events added to the legacy log', { meta: { agentId, error: String(error) } });
  }
}

function discardState(dir: string): void {
  const state = states.get(dir);
  if (state?.timer) clearTimeout(state.timer);
  states.delete(dir);
}

async function loadState(agentId: string): Promise<AgentState> {
  await cleanupTranscriptStaging();
  const dir = sessionDir(agentId);
  const cached = states.get(dir);
  if (cached && fs.existsSync(dir)) return cached;
  discardState(dir);
  const raw = await readText(path.join(dir, 'index.json'));
  let index: SessionIndex = { version: 1, currentSessionId: null, sessions: [] };
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as SessionIndex;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions) || !parsed.sessions.every((s) => s
        && typeof s.sessionId === 'string' && Number.isFinite(s.bytes) && Number.isFinite(s.lastSeq)
        && Number.isFinite(s.startedAt) && Number.isFinite(s.lastActiveAt))) throw new Error('Invalid chat index');
      if (parsed.legacyBytes !== undefined && !Number.isFinite(parsed.legacyBytes)) delete parsed.legacyBytes;
      index = parsed;
    } catch {
      // telemetry-exempt: rebuild damaged metadata from the authoritative session files below.
    }
  }
  const state: AgentState = { agentId, index, sizes: new Map(), dirty: false };
  const migrated = !fs.existsSync(dir) && await migrateLegacy(agentId, index);
  await fsp.mkdir(dir, { recursive: true });
  if (!migrated) await importLegacyGrowth(state);
  // Repair an interrupted append or an index saved before its latest appends,
  // once per process. Unchanged transcripts aren't parsed; normal reads and
  // resume use only the index.
  for (const name of await fsp.readdir(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    const size = (await fsp.stat(file)).size;
    const entry = index.sessions.find((s) => `${segment(s.sessionId)}.jsonl` === name);
    if (entry?.bytes === size) continue;
    const events = parseEvents(await readText(file));
    for (const event of events) record(index, event);
    if (events.length) index.sessions.find((s) => s.sessionId === events[0].sessionId)!.bytes = size;
  }
  selectCurrent(index);
  await saveIndex(dir, index);
  states.set(dir, state);
  migrationRetryAt.delete(dir);
  return state;
}

async function saveDirtyIndex(state: AgentState): Promise<void> {
  const dir = sessionDir(state.agentId);
  if (!state.dirty || states.get(dir) !== state) return;
  if (!fs.existsSync(dir)) { discardState(dir); return; }
  state.dirty = false;
  try {
    await saveIndex(dir, state.index);
  } catch (error) {
    // telemetry-exempt: the events are saved; the next save or load rebuilds the index from them.
    state.dirty = true;
    appLog('core:chat', 'warn', 'Chat events saved; index update will be retried', { meta: { agentId: state.agentId, error: String(error) } });
  }
}
/** Saving the index is deferred: a stale index is repaired from the session files on load. */
function scheduleIndexSave(state: AgentState): void {
  state.dirty = true;
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void serialized(sessionDir(state.agentId), () => saveDirtyIndex(state));
  }, INDEX_SAVE_DELAY_MS);
  state.timer.unref?.();
}

export function appendChatEvent(event: ChatEvent): Promise<void> {
  const dir = sessionDir(event.agentId);
  return serialized(dir, async () => {
    let state: AgentState | undefined;
    // After a failure, don't retry the whole migration on every event: the
    // event is saved below, and the next attempt includes it.
    if (Date.now() >= (migrationRetryAt.get(dir) ?? 0)) {
      try { state = await loadState(event.agentId); }
      catch (error) {
        // telemetry-exempt: persistence recovers below; the retry reason is logged locally.
        discardState(dir);
        migrationRetryAt.set(dir, Date.now() + MIGRATION_RETRY_MS);
        appLog('core:chat', 'warn', 'Chat migration/index unavailable; persisting events before retry', { meta: { agentId: event.agentId, retryInMs: MIGRATION_RETRY_MS, error: String(error) } });
      }
    }
    // Until the split is published, the legacy log remains authoritative.
    // Append there on migration failure so a later attempt includes new events.
    // Once published, each session file is authoritative even without an index.
    const published = state !== undefined || fs.existsSync(dir);
    const file = published ? transcriptPath(event.agentId, event.sessionId) : transcriptPath(event.agentId);
    const size = await appendLines(file, JSON.stringify(event) + '\n', state?.sizes);
    if (!state) return;
    const entry = record(state.index, event);
    try {
      entry.bytes = size ?? (await fsp.stat(file)).size;
    } catch (error) {
      // telemetry-exempt: the event is saved; the next load rebuilds this entry from the file.
      // Reporting failure here could cause a caller to retry the same event.
      discardState(dir);
      appLog('core:chat', 'warn', 'Chat event saved; index update will be retried', { meta: { agentId: event.agentId, error: String(error) } });
      return;
    }
    scheduleIndexSave(state);
  });
}

/**
 * Resolves when every agent's queued transcript work is done: appends, index
 * writes and migrations, which share the lock, including work queued while
 * waiting. Pending index changes are saved. Entries leave the map once
 * settled. For shutdown (#2053).
 */
export async function flushAllTranscripts(): Promise<void> {
  do {
    for (const state of states.values()) {
      if (state.dirty || state.timer) void flushTranscript(state.agentId);
    }
    while (chains.size) await Promise.allSettled([...chains.values()]);
  } while ([...states.values()].some((state) => state.timer));
}

export interface ReadTranscriptOptions {
  /** Omitted means the most recently started or resumed session. */
  sessionId?: string;
  afterSeq?: number;
  tail?: number;
}

/** Bytes read per step when reading a tail from the end of the file. */
const TAIL_CHUNK_BYTES = 64 * 1024;

/**
 * Read only enough of the end of the file for `tail` lines, so frequent
 * pollers (MCP read_output) don't parse the whole transcript each time.
 */
async function readTailText(file: string, tail: number): Promise<string> {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    let position = size;
    const chunks: Buffer[] = [];
    let newlines = 0;
    while (position > 0 && newlines <= tail) {
      const length = Math.min(TAIL_CHUNK_BYTES, position);
      position -= length;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, position);
      chunks.unshift(buf);
      for (const byte of buf) if (byte === 10) newlines++;
    }
    let text = Buffer.concat(chunks).toString('utf-8');
    // Drop a partial first line when we stopped mid-file (it may also split a UTF-8 sequence).
    if (position > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } finally {
    await handle.close();
  }
}

export function readChatTranscript(agentId: string, opts: ReadTranscriptOptions = {}): Promise<ChatEvent[]> {
  return serialized(sessionDir(agentId), async () => {
    const { index } = await loadState(agentId);
    const id = opts.sessionId ?? index.currentSessionId;
    if (!id) return [];
    const file = transcriptPath(agentId, id);
    let raw: string;
    try { raw = opts.tail ? await readTailText(file, opts.tail) : await readText(file); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; }
    let events = parseEvents(raw).filter((e) => e.sessionId === id);
    if (opts.afterSeq !== undefined) events = events.filter((e) => e.seq > opts.afterSeq!);
    return opts.tail ? events.slice(-opts.tail) : events;
  });
}
export function listChatSessions(agentId: string): Promise<ChatSessionSummary[]> {
  return serialized(sessionDir(agentId), async () => (await loadState(agentId)).index.sessions
    .map(({ bytes: _bytes, lastStartedAt: _lastStartedAt, ...entry }) => entry).sort((a, b) => b.lastActiveAt - a.lastActiveAt));
}
export async function lastSeqFor(agentId: string, sessionId: string): Promise<number> {
  return serialized(sessionDir(agentId), async () => (await loadState(agentId)).index.sessions.find((s) => s.sessionId === sessionId)?.lastSeq ?? 0);
}
export function transcriptExists(agentId: string): boolean {
  return fs.existsSync(transcriptPath(agentId)) || (fs.existsSync(sessionDir(agentId))
    && fs.readdirSync(sessionDir(agentId)).some((name) => name.endsWith('.jsonl')));
}
/**
 * Simulate a process restart in storage tests. A normal quit saves pending
 * index changes; `crash` drops them, as a power loss or kill would.
 */
export function resetTranscriptCache({ crash = false }: { crash?: boolean } = {}): void {
  for (const [dir, state] of states) {
    if (state.timer) clearTimeout(state.timer);
    if (!crash && state.dirty && fs.existsSync(dir)) fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(state.index));
  }
  states.clear();
  migrationRetryAt.clear();
  stagingCleanup = undefined;
}
