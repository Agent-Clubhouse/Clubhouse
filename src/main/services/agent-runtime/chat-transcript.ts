/** Session transcripts and a small per-agent index. Legacy agent logs are kept after migration. */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
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
interface SessionEntry extends ChatSessionSummary { bytes: number }
interface SessionIndex { version: 1; currentSessionId: string | null; sessions: SessionEntry[] }
const chains = new Map<string, Promise<unknown>>();
const indexes = new Map<string, SessionIndex>();

/** Reads, migration and appends share the lock, including writes to the index. */
function serialized<T>(agentId: string, work: () => Promise<T>): Promise<T> {
  const key = sessionDir(agentId);
  const next = (chains.get(key) ?? Promise.resolve()).catch((): void => undefined).then(work);
  chains.set(key, next);
  void next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch((): void => undefined);
  return next;
}
export async function flushTranscript(agentId: string): Promise<void> {
  await (chains.get(sessionDir(agentId)) ?? Promise.resolve());
}
function parseEvents(raw: string): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const line of raw.split('\n')) {
    try { const value: unknown = JSON.parse(line); if (isChatEvent(value)) events.push(value); }
    catch { /* Preserve valid events around crash-torn or foreign lines. */ }
  }
  return events;
}
async function readText(file: string): Promise<string> {
  try { return await fsp.readFile(file, 'utf-8'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw err; }
}
async function saveIndex(dir: string, index: SessionIndex): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  const temp = path.join(dir, 'index.json.tmp');
  await fsp.writeFile(temp, JSON.stringify(index), 'utf-8');
  await fsp.rename(temp, path.join(dir, 'index.json'));
}
function record(index: SessionIndex, event: ChatEvent): SessionEntry {
  let entry = index.sessions.find((s) => s.sessionId === event.sessionId);
  if (!entry) {
    entry = { sessionId: event.sessionId, startedAt: event.ts, lastActiveAt: event.ts, lastSeq: 0, bytes: 0 };
    index.sessions.push(entry);
  }
  entry.lastSeq = Math.max(entry.lastSeq, event.seq);
  entry.lastActiveAt = event.ts;
  index.currentSessionId = event.sessionId;
  if (event.type === 'session_started') {
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
  return entry;
}

async function loadIndex(agentId: string): Promise<SessionIndex> {
  const dir = sessionDir(agentId);
  const indexFile = path.join(dir, 'index.json');
  const cached = indexes.get(dir);
  if (cached && fs.existsSync(indexFile)) return cached;
  const raw = await readText(indexFile);
  let index: SessionIndex = { version: 1, currentSessionId: null, sessions: [] };
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as SessionIndex;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) throw new Error('Invalid chat index');
      index = parsed;
    } catch { /* Rebuild a damaged index from the session files below. */ }
  }
  // A legacy log is split in a staging directory. Only a verified, complete
  // split is published; the original is never changed or deleted.
  if (!fs.existsSync(dir)) {
    const legacy = parseEvents(await readText(transcriptPath(agentId)));
    if (legacy.length) {
      const staging = `${dir}.migrating-${randomUUID()}`;
      await fsp.mkdir(staging, { recursive: true });
      try {
        const grouped = new Map<string, ChatEvent[]>();
        for (const event of legacy) {
          const list = grouped.get(event.sessionId) ?? [];
          list.push(event);
          grouped.set(event.sessionId, list);
          record(index, event);
        }
        for (const [id, events] of grouped) {
          const file = path.join(staging, `${segment(id)}.jsonl`);
          const content = events.map((e) => JSON.stringify(e) + '\n').join('');
          await fsp.writeFile(file, content, 'utf-8');
          if (await readText(file) !== content) throw new Error('Chat transcript migration verification failed');
          index.sessions.find((s) => s.sessionId === id)!.bytes = Buffer.byteLength(content);
        }
        await saveIndex(staging, index);
        await fsp.rename(staging, dir);
      } finally { await fsp.rm(staging, { recursive: true, force: true }); }
    }
  }
  await fsp.mkdir(dir, { recursive: true });
  // Repair an interrupted append/index update once per process. Unchanged
  // transcripts aren't parsed; normal reads and resume use only the index.
  let repaired = false;
  for (const name of await fsp.readdir(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    const size = (await fsp.stat(file)).size;
    const entry = index.sessions.find((s) => `${segment(s.sessionId)}.jsonl` === name);
    if (entry?.bytes === size) continue;
    repaired = true;
    const events = parseEvents(await readText(file));
    for (const event of events) record(index, event);
    if (events.length) index.sessions.find((s) => s.sessionId === events[0].sessionId)!.bytes = size;
  }
  // Recovery may visit files in arbitrary directory order.
  if (repaired) {
    index.currentSessionId = [...index.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.sessionId ?? null;
  }
  await saveIndex(dir, index);
  indexes.set(dir, index);
  return index;
}

export function appendChatEvent(event: ChatEvent): Promise<void> {
  return serialized(event.agentId, async () => {
    const index = await loadIndex(event.agentId);
    const file = transcriptPath(event.agentId, event.sessionId);
    let prefix = '';
    try {
      const handle = await fsp.open(file, 'r');
      try {
        const { size } = await handle.stat();
        if (size) { const last = Buffer.alloc(1); await handle.read(last, 0, 1, size - 1); if (last[0] !== 10) prefix = '\n'; }
      } finally { await handle.close(); }
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    await fsp.appendFile(file, prefix + JSON.stringify(event) + '\n', 'utf-8');
    record(index, event).bytes = (await fsp.stat(file)).size;
    await saveIndex(sessionDir(event.agentId), index);
  });
}

export interface ReadTranscriptOptions {
  /** Omitted means the current (most recently written) session. */
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
  return serialized(agentId, async () => {
    const index = await loadIndex(agentId);
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
  return serialized(agentId, async () => (await loadIndex(agentId)).sessions
    .map(({ bytes: _bytes, ...entry }) => entry).sort((a, b) => b.lastActiveAt - a.lastActiveAt));
}
export async function lastSeqFor(agentId: string, sessionId: string): Promise<number> {
  return serialized(agentId, async () => (await loadIndex(agentId)).sessions.find((s) => s.sessionId === sessionId)?.lastSeq ?? 0);
}
export function transcriptExists(agentId: string): boolean {
  return fs.existsSync(transcriptPath(agentId)) || (fs.existsSync(sessionDir(agentId))
    && fs.readdirSync(sessionDir(agentId)).some((name) => name.endsWith('.jsonl')));
}
/** Simulate a process restart in storage tests. */
export function resetTranscriptCache(): void { indexes.clear(); }
