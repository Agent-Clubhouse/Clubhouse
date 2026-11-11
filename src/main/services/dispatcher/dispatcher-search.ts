/**
 * One search over the Dispatcher's memory and its transcripts (#3039), used by
 * both of its agents: the chat (through search_memory) and the coordinator
 * (the same tool). It only reads.
 *
 * - Memory: every `.md` page under the memory folder (dispatcher-memory,
 *   #3038), searched by paragraph. A hit names the page, as read_memory takes
 *   it, and the line.
 * - Transcripts: the sessions every provider's CLI recorded in either of the
 *   Dispatcher's folders, from its own store (Claude Code's projects folder,
 *   Codex rollouts, Copilot session-state). A hit names the transcript file and
 *   the line of the record it came from, so it can be opened there, and the
 *   provider and session id.
 *
 * Nothing here knows a provider's store layout: providers list their sessions
 * and say where each transcript is (SessionCapable.transcriptPath). What it
 * does know is how each CLI writes a record, to pull out the text a person
 * would search for (transcriptRecordText).
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { getDispatcherFolders, getDispatcherMemoryPath } from './dispatcher-paths';
import { getAllProviders } from '../../orchestrators/registry';
import { isSessionCapable } from '../../orchestrators/types';
import { MEMORY_HISTORY_DIR, recordMemoryRead } from './dispatcher-memory';

export type SearchScope = 'all' | 'memory' | 'transcripts';

/** Hits per source at most when the caller doesn't say. */
export const DEFAULT_SEARCH_LIMIT = 10;
/** Hits per source at most, whatever the caller asks for. */
export const MAX_SEARCH_LIMIT = 50;
/** Search terms at most; the rest of a long query is ignored. */
export const MAX_SEARCH_TERMS = 12;
/** Characters of text around a match in a hit. */
export const SNIPPET_CHARS = 280;
/** Memory pages read at most, and the largest page read. */
export const MAX_MEMORY_PAGES = 2_000;
export const MAX_MEMORY_PAGE_BYTES = 1024 * 1024;
/** Sessions read at most per provider and folder, newest first. */
export const MAX_SESSIONS_PER_STORE = 50;
/**
 * Transcript bytes read at most in one search, newest sessions first. Keeps a
 * search over a long history from holding up the main process; a search that
 * stops here says so.
 */
export const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;

export interface MemoryHit {
  /** The page, relative to the memory folder: what read_memory takes. */
  page: string;
  /** 1-based line in the page where the matching paragraph starts. */
  line: number;
  text: string;
  /** `memory/<page>#L<line>`: the page inside the Dispatcher's folder, and the line. */
  link: string;
}

export type TranscriptRole = 'user' | 'assistant' | 'tool';

export interface TranscriptHit {
  /** The provider whose CLI wrote it, such as `claude-code`. */
  provider: string;
  sessionId: string;
  /** The transcript file. */
  file: string;
  /** 1-based line of the record in the file. */
  line: number;
  role: TranscriptRole;
  /** When the record was written, as ISO 8601, if it says. */
  at?: string;
  text: string;
  /** `<file>#L<line>`. */
  link: string;
}

export interface SearchResult {
  query: string;
  memory: MemoryHit[];
  transcripts: TranscriptHit[];
  /** True when a source had more hits than the limit. */
  more?: true;
  /** True when the transcript budget ran out before every session was read. */
  incomplete?: true;
}

/** Where one provider's sessions are. `provider` is its id. */
export interface TranscriptStore {
  provider: string;
  listSessions(cwd: string): Promise<Array<{ sessionId: string; lastActiveAt: string }>>;
  transcriptPath(sessionId: string, cwd: string): Promise<string | null>;
}

export interface SearchOptions {
  scope?: SearchScope;
  limit?: number;
  /** The memory folder; the Dispatcher's by default. */
  memoryRoot?: string;
  /** The folders whose sessions are searched; both of the Dispatcher's by default. */
  folders?: readonly string[];
  /** Where sessions are; every registered provider that can say by default. */
  stores?: readonly TranscriptStore[];
  /** Overrides MAX_TRANSCRIPT_BYTES, for tests. */
  maxTranscriptBytes?: number;
}

// ── Query ──────────────────────────────────────────────────────────────────

/**
 * The terms of a query, lowercased: words, with "quoted phrases" kept whole.
 * A hit has every term.
 */
export function parseQuery(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = (match[1] ?? match[2]).trim().toLowerCase();
    if (term && !terms.includes(term)) terms.push(term);
    if (terms.length >= MAX_SEARCH_TERMS) break;
  }
  return terms;
}

function matchesAll(lower: string, terms: readonly string[]): boolean {
  return terms.every((t) => lower.includes(t));
}

/** Occurrences of every term, so a paragraph about the query ranks above one that mentions it. */
function score(lower: string, terms: readonly string[]): number {
  let n = 0;
  for (const t of terms) {
    for (let at = lower.indexOf(t); at >= 0; at = lower.indexOf(t, at + t.length)) n++;
  }
  return n;
}

/** The text around the first match, on one line, cut to SNIPPET_CHARS. */
export function snippet(text: string, terms: readonly string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= SNIPPET_CHARS) return flat;
  const lower = flat.toLowerCase();
  const first = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0));
  const at = Number.isFinite(first) ? first : 0;
  let start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
  const end = Math.min(flat.length, start + SNIPPET_CHARS);
  start = Math.max(0, end - SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(limit)));
}

// ── Memory ─────────────────────────────────────────────────────────────────

async function memoryPages(root: string): Promise<string[]> {
  const pages: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      // telemetry-exempt: no memory yet, or a folder removed while searching
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (pages.length >= MAX_MEMORY_PAGES) return;
      // Links are never followed: they could lead out of memory.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (dir === root && entry.name === MEMORY_HISTORY_DIR) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) pages.push(full);
    }
  };
  await walk(root);
  return pages;
}

/**
 * A page's paragraphs: runs of non-blank lines, where a heading or a list item
 * starts a new one, so each timeline line and each bullet is its own hit.
 */
export function paragraphs(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let current: { line: number; lines: string[] } | null = null;
  const flush = () => {
    if (current) out.push({ line: current.line, text: current.lines.join('\n') });
    current = null;
  };
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return flush();
    if (/^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(raw)) flush();
    if (!current) current = { line: i + 1, lines: [] };
    current.lines.push(raw);
  });
  flush();
  return out;
}

async function searchMemory(root: string, terms: readonly string[]): Promise<Array<MemoryHit & { score: number }>> {
  const hits: Array<MemoryHit & { score: number }> = [];
  for (const file of await memoryPages(root)) {
    let text: string;
    try {
      const stat = await fsp.stat(file);
      if (stat.size > MAX_MEMORY_PAGE_BYTES) continue;
      text = await fsp.readFile(file, 'utf-8');
    } catch {
      // telemetry-exempt: a page removed while searching
      continue;
    }
    const page = path.relative(root, file).split(path.sep).join('/');
    for (const para of paragraphs(text)) {
      const lower = para.text.toLowerCase();
      if (!matchesAll(lower, terms)) continue;
      hits.push({ page, line: para.line, text: snippet(para.text, terms), link: `memory/${page}#L${para.line}`, score: score(lower, terms) });
    }
  }
  return hits;
}

// ── Transcript records ─────────────────────────────────────────────────────

export interface RecordText {
  role: TranscriptRole;
  text: string;
  at?: string;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** A tool's input or output as text: strings as they are, anything else as JSON. */
function asText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return str(v);
  if (Array.isArray(v)) {
    // Content blocks: [{ type: 'text', text }]
    const texts = v.map((b) => str(obj(b)?.text) ?? (typeof b === 'string' ? b : undefined)).filter(Boolean);
    if (texts.length) return texts.join('\n');
  }
  try {
    return JSON.stringify(v);
  } catch {
    // telemetry-exempt: a value JSON can't hold has nothing to search
    return undefined;
  }
}

function toolText(name: unknown, input: unknown): string {
  return [str(name), asText(input)].filter(Boolean).join(' ');
}

function timestamp(v: unknown): string | undefined {
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  return undefined;
}

function joined(parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => !!p && !!p.trim()).join('\n');
}

/**
 * Context a CLI adds to the user's turn on its own (Codex's environment and
 * AGENTS.md blocks), which would match nearly any search.
 */
function isInjectedContext(text: string): boolean {
  return /^\s*<(environment_context|user_instructions|permissions instructions|turn_aborted)\b/.test(text)
    || /^\s*# AGENTS\.md instructions/.test(text);
}

/** Claude Code: `{ type: 'user' | 'assistant', message: { role, content }, timestamp }`. */
function claudeRecord(record: Obj): RecordText | null {
  if (record.isMeta === true) return null;
  const message = obj(record.message);
  const content = message?.content;
  const at = timestamp(record.timestamp);
  if (typeof content === 'string') {
    const text = str(content);
    return text ? { role: record.type === 'assistant' ? 'assistant' : 'user', text, at } : null;
  }
  if (!Array.isArray(content)) return null;
  const said: string[] = [];
  const tools: string[] = [];
  for (const block of content.map(obj)) {
    if (!block) continue;
    if (block.type === 'text' && str(block.text)) said.push(block.text as string);
    else if (block.type === 'tool_use') tools.push(toolText(block.name, block.input));
    else if (block.type === 'tool_result') tools.push(asText(block.content) ?? '');
  }
  const text = joined([...said, ...tools]);
  if (!text) return null;
  const role: TranscriptRole = said.length === 0 ? 'tool' : record.type === 'assistant' ? 'assistant' : 'user';
  return { role, text, at };
}

/**
 * Codex rollouts: `{ timestamp, type: 'response_item', payload }`, where the
 * payload is a message, a tool call or a tool call's output. The same turn is
 * also logged as `event_msg` records, which are skipped so a line isn't found
 * twice. Old rollouts wrote the payload as the record itself.
 */
function codexRecord(record: Obj): RecordText | null {
  const payload = record.type === 'response_item' ? obj(record.payload) : record;
  if (!payload) return null;
  const at = timestamp(record.timestamp);
  switch (payload.type) {
    case 'message': {
      if (payload.role !== 'user' && payload.role !== 'assistant') return null;
      const blocks = Array.isArray(payload.content) ? payload.content.map(obj) : [];
      const text = joined(blocks.map((b) => str(b?.text)).filter((t) => t && !isInjectedContext(t)));
      return text ? { role: payload.role, text, at } : null;
    }
    case 'function_call':
      return { role: 'tool', text: toolText(payload.name, payload.arguments), at };
    case 'custom_tool_call':
      return { role: 'tool', text: toolText(payload.name, payload.input), at };
    case 'local_shell_call':
      return { role: 'tool', text: toolText('shell', obj(payload.action)?.command ?? payload.action), at };
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const output = obj(payload.output);
      const text = asText(output ? output.content ?? output.output ?? output : payload.output);
      return text ? { role: 'tool', text, at } : null;
    }
    default:
      return null;
  }
}

/**
 * Copilot `events.jsonl`: `{ type: 'user.message' | 'assistant.message' |
 * 'tool.execution_complete', data, timestamp }`.
 */
function copilotRecord(record: Obj): RecordText | null {
  const data = obj(record.data);
  if (!data) return null;
  const at = timestamp(record.timestamp);
  switch (record.type) {
    case 'user.message': {
      const text = str(data.content);
      return text ? { role: 'user', text, at } : null;
    }
    case 'assistant.message': {
      const said = str(data.content);
      const requests = Array.isArray(data.toolRequests) ? data.toolRequests.map(obj) : [];
      const tools = requests.map((r) => (r ? toolText(r.name, r.arguments) : ''));
      const text = joined([said, ...tools]);
      return text ? { role: said ? 'assistant' : 'tool', text, at } : null;
    }
    case 'tool.execution_complete': {
      const result = obj(data.result);
      const text = asText(result?.detailedContent ?? result?.content ?? obj(data.error)?.message);
      return text ? { role: 'tool', text, at } : null;
    }
    default:
      return null;
  }
}

/**
 * The searchable text of one transcript record, in any provider's format, or
 * null for records that hold none (session metadata, usage, reasoning that is
 * stored encrypted, the CLI's own instructions).
 */
export function transcriptRecordText(record: unknown): RecordText | null {
  const r = obj(record);
  if (!r) return null;
  if ((r.type === 'user' || r.type === 'assistant') && obj(r.message)) return claudeRecord(r);
  if (typeof r.type === 'string' && r.type.includes('.')) return copilotRecord(r);
  return codexRecord(r);
}

// ── Transcripts ────────────────────────────────────────────────────────────

/**
 * Terms a raw JSONL line can be checked for before it is parsed: JSON writes
 * these characters as they are, so a line without the term can't hold it.
 */
function rawCheckable(term: string): boolean {
  return /^[\x20-\x7e]+$/.test(term) && !/["\\/]/.test(term);
}

interface Budget {
  left: number;
  ranOut: boolean;
}

async function searchTranscript(
  file: string,
  meta: { provider: string; sessionId: string },
  terms: readonly string[],
  budget: Budget,
  out: TranscriptHit[],
  scores: Map<TranscriptHit, number>,
): Promise<void> {
  let size: number;
  try {
    size = (await fsp.stat(file)).size;
  } catch {
    // telemetry-exempt: a transcript removed while searching
    return;
  }
  if (size > budget.left) {
    budget.ranOut = true;
    return;
  }
  budget.left -= size;
  const quick = terms.filter(rawCheckable);
  const stream = fs.createReadStream(file, { encoding: 'utf-8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const raw of lines) {
      line++;
      if (!raw) continue;
      const lowerRaw = raw.toLowerCase();
      if (!matchesAll(lowerRaw, quick)) continue;
      let record: unknown;
      try {
        record = JSON.parse(raw);
      } catch {
        // telemetry-exempt: a line the CLI was still writing
        continue;
      }
      const found = transcriptRecordText(record);
      if (!found) continue;
      const lower = found.text.toLowerCase();
      if (!matchesAll(lower, terms)) continue;
      const hit: TranscriptHit = {
        ...meta,
        file,
        line,
        role: found.role,
        ...(found.at && { at: found.at }),
        text: snippet(found.text, terms),
        link: `${file}#L${line}`,
      };
      out.push(hit);
      scores.set(hit, score(lower, terms));
    }
  } catch {
    // telemetry-exempt: an unreadable transcript is skipped; the others still count
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Every registered provider that lists sessions and says where each transcript is. */
export function providerTranscriptStores(): TranscriptStore[] {
  const stores: TranscriptStore[] = [];
  for (const provider of getAllProviders()) {
    if (!isSessionCapable(provider) || typeof provider.transcriptPath !== 'function') continue;
    stores.push({
      provider: provider.id,
      listSessions: (cwd) => provider.listSessions(cwd),
      transcriptPath: (sessionId, cwd) => provider.transcriptPath!(sessionId, cwd),
    });
  }
  return stores;
}

interface SessionRef {
  store: TranscriptStore;
  folder: string;
  sessionId: string;
  lastActiveAt: number;
}

async function searchTranscripts(
  folders: readonly string[],
  stores: readonly TranscriptStore[],
  terms: readonly string[],
  maxBytes: number,
): Promise<{ hits: TranscriptHit[]; scores: Map<TranscriptHit, number>; incomplete: boolean }> {
  const sessions: SessionRef[] = [];
  for (const store of stores) {
    for (const folder of folders) {
      try {
        const listed = await store.listSessions(folder);
        const newest = [...listed].sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt)).slice(0, MAX_SESSIONS_PER_STORE);
        for (const s of newest) sessions.push({ store, folder, sessionId: s.sessionId, lastActiveAt: Date.parse(s.lastActiveAt) || 0 });
      } catch {
        // telemetry-exempt: a provider whose store can't be read; the others are still searched
      }
    }
  }
  // Newest first across providers, so the budget goes to recent work.
  sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  const hits: TranscriptHit[] = [];
  const scores = new Map<TranscriptHit, number>();
  const budget: Budget = { left: maxBytes, ranOut: false };
  const seen = new Set<string>();
  for (const s of sessions) {
    if (budget.left <= 0) {
      budget.ranOut = true;
      break;
    }
    let file: string | null;
    try {
      file = await s.store.transcriptPath(s.sessionId, s.folder);
    } catch {
      // telemetry-exempt: a session whose file can't be found is skipped
      continue;
    }
    if (!file || seen.has(file)) continue;
    seen.add(file);
    await searchTranscript(file, { provider: s.store.provider, sessionId: s.sessionId }, terms, budget, hits, scores);
  }
  return { hits, scores, incomplete: budget.ranOut };
}

// ── Search ─────────────────────────────────────────────────────────────────

/**
 * Search memory and transcripts for `query`. Each source returns its best
 * hits up to the limit: memory pages by how often the terms appear,
 * transcripts newest first.
 */
export async function searchDispatcher(query: string, options: SearchOptions = {}): Promise<SearchResult> {
  const terms = parseQuery(query);
  const result: SearchResult = { query, memory: [], transcripts: [] };
  if (terms.length === 0) return result;
  const scope = options.scope ?? 'all';
  const limit = clampLimit(options.limit);

  if (scope !== 'transcripts') {
    const hits = await searchMemory(options.memoryRoot ?? getDispatcherMemoryPath(), terms);
    hits.sort((a, b) => b.score - a.score || a.page.localeCompare(b.page) || a.line - b.line);
    if (hits.length > limit) result.more = true;
    result.memory = hits.slice(0, limit).map(({ score: _score, ...hit }) => hit);
    for (const page of new Set(result.memory.map((hit) => hit.page))) await recordMemoryRead(page, options.memoryRoot);
  }

  if (scope !== 'memory') {
    const { hits, scores, incomplete } = await searchTranscripts(
      options.folders ?? getDispatcherFolders(),
      options.stores ?? providerTranscriptStores(),
      terms,
      options.maxTranscriptBytes ?? MAX_TRANSCRIPT_BYTES,
    );
    const when = (h: TranscriptHit) => (h.at ? Date.parse(h.at) : 0);
    hits.sort((a, b) => when(b) - when(a) || (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
    if (hits.length > limit) result.more = true;
    if (incomplete) result.incomplete = true;
    result.transcripts = hits.slice(0, limit);
  }

  return result;
}
