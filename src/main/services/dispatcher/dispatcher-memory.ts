/**
 * The Dispatcher's memory (#3038): plain markdown under
 * `~/.clubhouse/dispatcher/memory/`, so any provider can read and write it and
 * it survives a restart or a provider switch.
 *
 *   index.md           loaded at every start, capped at MEMORY_INDEX_CAP_BYTES
 *   agents/<agent>.md  the agent's own card, then the Dispatcher's notes
 *   timeline/          days, rolled into weeks, then months (dispatcher-memory-timeline.ts)
 *   topics/<topic>.md  one page per piece of work, confirmed or unconfirmed, with its source
 *
 * The retired `notes/` folder is kept outside memory, in `notes-archive/` next
 * to it (dispatcher-memory-migration.ts).
 *
 * Every helper takes the memory root, defaulting to the Dispatcher's, so tests
 * and later callers can point it anywhere. Nothing here knows about a provider.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { getDispatcherMemoryPath } from './dispatcher-paths';

/**
 * The most index.md may hold, in UTF-8 bytes (about 2,000 tokens). It is
 * enforced when Clubhouse writes the index and again when it is loaded, since
 * the agent edits the file directly.
 */
export const MEMORY_INDEX_CAP_BYTES = 8 * 1024;

/** Appended where the index was cut, so the reader knows there is more. */
export const INDEX_CUT_NOTE = '\n\n_The index was cut at its size limit. The rest is in agents/, timeline/ and topics/._\n';

export interface MemoryPaths {
  root: string;
  index: string;
  agents: string;
  timeline: string;
  topics: string;
}

export function memoryPaths(root: string = getDispatcherMemoryPath()): MemoryPaths {
  return {
    root,
    index: path.join(root, 'index.md'),
    agents: path.join(root, 'agents'),
    timeline: path.join(root, 'timeline'),
    topics: path.join(root, 'topics'),
  };
}

/** What a new index says. It leads into the pages rather than repeating them. */
export const DEFAULT_INDEX = `This index is loaded at every start. Keep it short, since it is cut at ${MEMORY_INDEX_CAP_BYTES / 1024} KB, and point to pages instead of copying them.

- \`agents/\`: one page per agent. The agent writes its card at the top; you write your notes under it.
- \`timeline/\`: what happened, one file per day. Older days roll into weeks, and weeks into months, each keeping links to transcripts.
- \`topics/\`: one page per piece of work, marked confirmed or unconfirmed, with its source.
`;

/**
 * A file name for a page: lowercase letters, digits, dots, dashes and
 * underscores only, so it can't leave its folder and two names that differ
 * only in case share a page on any file system.
 */
export function memorySlug(name: string): string {
  let slug = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (slug.length > 80) slug = slug.slice(0, 80).replace(/[-.]+$/, '');
  if (!slug) return 'untitled';
  // Names Windows reserves, with or without an extension.
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/.test(slug)) slug = `${slug}-page`;
  return slug;
}

/** Write through a temporary file and a rename, so a reader never sees half a file. */
export async function writeFileAtomic(file: string, content: string, timestamps?: { atimeMs: number; mtimeMs: number }): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, content, 'utf-8');
    // Stamp maintenance writes before publishing them, never over a later edit.
    if (timestamps) await fsp.utimes(tmp, timestamps.atimeMs / 1000, timestamps.mtimeMs / 1000);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

/** A file's text, or null when it doesn't exist. */
export async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Create the folders and a starting index. Leaves anything already there alone. */
export async function ensureMemoryLayout(root?: string): Promise<MemoryPaths> {
  const paths = memoryPaths(root);
  for (const dir of [paths.agents, paths.timeline, paths.topics]) {
    await fsp.mkdir(dir, { recursive: true });
  }
  await withPageLock(paths.index, async () => {
    if ((await readIfExists(paths.index)) === null) await memoryWrite('index.md', DEFAULT_INDEX, 'layout', paths.root);
  });
  return paths;
}

// ── Index ──────────────────────────────────────────────────────────────────

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

/** The longest start of `text` that fits in `budget` bytes, never splitting a character. */
function fitBytes(text: string, budget: number): string {
  if (byteLength(text) <= budget) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const size = byteLength(ch);
    if (used + size > budget) break;
    out += ch;
    used += size;
  }
  return out;
}

/**
 * The index cut to `cap` bytes at a line boundary, with a note saying where the
 * rest is. Text already under the cap comes back unchanged.
 */
export function capIndex(text: string, cap: number = MEMORY_INDEX_CAP_BYTES): string {
  if (byteLength(text) <= cap) return text;
  const budget = cap - byteLength(INDEX_CUT_NOTE);
  if (budget <= 0) return fitBytes(INDEX_CUT_NOTE, cap);
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const size = byteLength(line) + (kept.length ? 1 : 0);
    if (used + size > budget) {
      // A single line longer than the whole budget is cut inside the line.
      if (kept.length === 0) kept.push(fitBytes(line, budget));
      break;
    }
    kept.push(line);
    used += size;
  }
  return `${kept.join('\n').trimEnd()}${INDEX_CUT_NOTE}`;
}

/** index.md as it is on disk, or '' when there is none. */
export async function readIndex(root?: string): Promise<string> {
  const text = await readIfExists(memoryPaths(root).index);
  if (text !== null) await recordMemoryRead('index.md', root);
  return text ?? '';
}

/** Replace index.md, cut to its cap. Returns what was written. */
export async function writeIndex(content: string, root?: string, cap: number = MEMORY_INDEX_CAP_BYTES): Promise<string> {
  const capped = capIndex(content, cap);
  await memoryWrite('index.md', capped, 'index', root);
  return capped;
}

/** The index as a start loads it: created if missing, and never over its cap. */
export async function loadIndex(root?: string, cap: number = MEMORY_INDEX_CAP_BYTES): Promise<string> {
  await ensureMemoryLayout(root);
  return capIndex(await readIndex(root), cap);
}

/**
 * Add or replace a `## <title>` section in the index with a list of lines.
 * Lines that don't fit under the cap are left out and counted instead, so the
 * index keeps pointing at everything it can. Running it again with the same
 * lines changes nothing.
 */
export async function setIndexSection(
  title: string,
  lines: string[],
  overflow: (left: number) => string,
  root?: string,
  cap: number = MEMORY_INDEX_CAP_BYTES,
): Promise<string> {
  await ensureMemoryLayout(root);
  const current = removeSection(await readIndex(root), title).trimEnd();
  const head = `${current}${current ? '\n\n' : ''}## ${title}\n\n`;
  const budget = cap - byteLength(head) - byteLength(INDEX_CUT_NOTE);
  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const remaining = lines.length - i - 1;
    const tail = remaining > 0 ? byteLength(`\n${overflow(remaining)}`) : 0;
    const size = byteLength(`${lines[i]}\n`);
    if (used + size + tail > budget) {
      kept.push(overflow(lines.length - i));
      break;
    }
    kept.push(lines[i]);
    used += size;
  }
  return writeIndex(`${head}${kept.join('\n')}\n`, root, cap);
}

/** `text` without its `## <title>` section (up to the next `## ` heading). */
function removeSection(text: string, title: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === `## ${title}`);
  if (start < 0) return text;
  let end = start + 1;
  while (end < lines.length && !/^##? /.test(lines[end])) end++;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

// ── Agent pages ────────────────────────────────────────────────────────────

/** The agent writes this section (#3041). */
export const AGENT_CARD_HEADING = '## Card';
/** The Dispatcher writes this section. */
export const AGENT_NOTES_HEADING = '## Notes';

export interface AgentPage {
  card: string;
  notes: string;
}

export function agentPagePath(agent: string, root?: string): string {
  return path.join(memoryPaths(root).agents, `${memorySlug(agent)}.md`);
}

/**
 * Split a page into its two sections. Text before the card heading other than
 * the title is kept with the card, so a hand edit is never dropped.
 */
export function parseAgentPage(text: string): AgentPage {
  const lines = text.split('\n');
  const cardAt = lines.findIndex((l) => l.trimEnd() === AGENT_CARD_HEADING);
  const notesAt = lines.findIndex((l, i) => i > cardAt && l.trimEnd() === AGENT_NOTES_HEADING);
  const before = (cardAt < 0 ? lines.slice(0, notesAt < 0 ? lines.length : notesAt) : lines.slice(0, cardAt))
    .filter((l, i) => !(i === 0 && l.startsWith('# ')));
  const card = cardAt < 0 ? before : [...before, ...lines.slice(cardAt + 1, notesAt < 0 ? lines.length : notesAt)];
  const notes = notesAt < 0 ? [] : lines.slice(notesAt + 1);
  return { card: card.join('\n').trim(), notes: notes.join('\n').trim() };
}

/** A section's text can't open the other section: a heading line of ours gets one more `#`. */
function guardSection(text: string): string {
  return text
    .split('\n')
    .map((l) => (l.trimEnd() === AGENT_CARD_HEADING || l.trimEnd() === AGENT_NOTES_HEADING ? `#${l}` : l))
    .join('\n')
    .trim();
}

export function renderAgentPage(agent: string, page: AgentPage, title: string = agent): string {
  return `# ${title}\n\n${AGENT_CARD_HEADING}\n\n${guardSection(page.card)}\n\n${AGENT_NOTES_HEADING}\n\n${guardSection(page.notes)}\n`;
}

export async function readAgentPage(agent: string, root?: string): Promise<AgentPage | null> {
  const text = await readIfExists(agentPagePath(agent, root));
  return text === null ? null : parseAgentPage(text);
}

/** Pending writes per page file, so two writers in this process never interleave a read and a write. */
const pageLocks = new Map<string, Promise<unknown>>();

function withPageLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const run = (pageLocks.get(file) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch((): void => undefined);
  pageLocks.set(file, tail);
  void tail.then(() => { if (pageLocks.get(file) === tail) pageLocks.delete(file); });
  return run;
}

/** Hold the same lock as tool writes while retiring a source page. */
export async function withMemoryPageLock<T>(page: string, root: string, fn: (file: string) => Promise<T>): Promise<T> {
  const { resolveMemoryPage } = await import('./dispatcher-memory-reader');
  const file = await resolveMemoryPage(page, root, true);
  return withPageLock(`write:${file}`, () => fn(file));
}

async function writeAgentSection(agent: string, section: keyof AgentPage, text: string, root?: string, reason: string = section === 'card' ? 'card' : 'notes', title?: string): Promise<AgentPage> {
  await ensureMemoryLayout(root);
  return withPageLock(agentPagePath(agent, root), async () => {
    const written = await memoryWrite(relativeMemoryPage(agentPagePath(agent, root), root), (previous) => {
      const current = previous === null ? { card: '', notes: '' } : parseAgentPage(previous);
      return renderAgentPage(agent, { ...current, [section]: text }, title ?? agent);
    }, reason, root);
    return parseAgentPage(written);
  });
}

/**
 * A Dispatcher on another computer (#3349): its page is keyed by its
 * machine-qualified address, hashed so the file name is short and safe on
 * every file system (a machine fingerprint has colons). The label and full
 * address are in the page.
 */
export function remoteDispatcherPageName(address: string): string {
  return `peer-${createHash('sha256').update(address.toLowerCase()).digest('hex').slice(0, 16)}`;
}

/** Write a remote Dispatcher's card from what its link says, titled by its label, keeping the notes. */
export function writeRemoteDispatcherCard(address: string, label: string, card: string, root?: string): Promise<AgentPage> {
  return writeAgentSection(remoteDispatcherPageName(address), 'card', card, root, 'peer card', label);
}

/** Replace the agent's card, keeping the Dispatcher's notes. */
export function writeAgentCard(agent: string, card: string, root?: string, reason: string = 'card'): Promise<AgentPage> {
  return writeAgentSection(agent, 'card', card, root, reason);
}

/** Replace the Dispatcher's notes on an agent, keeping the agent's card. */
export function writeAgentNotes(agent: string, notes: string, root?: string): Promise<AgentPage> {
  return writeAgentSection(agent, 'notes', notes, root);
}

/**
 * The card section of a page whose agent hasn't answered (#3041). Written when
 * Clubhouse first asks, so the page reads the same as the agent's Details card.
 */
export const AGENT_CARD_PLACEHOLDER = 'No description yet.';

/** The agent's own card, or null when the page is missing, empty or still the placeholder. */
export async function readAgentCard(agent: string, root?: string): Promise<string | null> {
  const page = await readAgentPage(agent, root);
  if (!page) return null;
  return page.card && page.card !== AGENT_CARD_PLACEHOLDER ? page.card : null;
}

/** Whether the agent has a page at all, card or not. */
export async function agentPageExists(agent: string, root?: string): Promise<boolean> {
  return (await readIfExists(agentPagePath(agent, root))) !== null;
}

/** Give the agent a page with the placeholder card, unless it has one. Never changes a page that exists. */
export async function ensureAgentPage(agent: string, root?: string): Promise<void> {
  await ensureMemoryLayout(root);
  const file = agentPagePath(agent, root);
  await withPageLock(file, async () => {
    if ((await readIfExists(file)) !== null) return;
    await memoryWrite(relativeMemoryPage(file, root), renderAgentPage(agent, { card: AGENT_CARD_PLACEHOLDER, notes: '' }), 'card placeholder', root);
  });
}

/**
 * Move an agent's page to a new name (a rename of the agent or its project),
 * keeping both sections. When a page already has the new name, the moved card
 * replaces its card and the two sets of notes are kept, the old page's last.
 */
export async function moveAgentPage(from: string, to: string, root?: string): Promise<void> {
  const fromFile = agentPagePath(from, root);
  const toFile = agentPagePath(to, root);
  if (fromFile === toFile) {
    // Same file, new title.
    await withPageLock(toFile, async () => {
      const page = await readAgentPage(from, root);
      if (page) await memoryWrite(relativeMemoryPage(toFile, root), renderAgentPage(to, page), 'card rename', root);
    });
    return;
  }
  // Both pages locked, always in the same order, so two moves can't wait on each other.
  const [first, second] = [fromFile, toFile].sort();
  await withPageLock(first, () => withPageLock(second, async () => {
    const moved = await readAgentPage(from, root);
    if (!moved) return;
    const existing = await readAgentPage(to, root);
    const notes = [existing?.notes, moved.notes].filter((n): n is string => !!n).join('\n\n');
    const card = moved.card && moved.card !== AGENT_CARD_PLACEHOLDER ? moved.card : existing?.card || moved.card;
    await memoryWrite(relativeMemoryPage(toFile, root), renderAgentPage(to, { card, notes }), 'card rename', root);
    await moveMemoryHistory(relativeMemoryPage(fromFile, root), relativeMemoryPage(toFile, root), root);
    await fsp.rm(fromFile, { force: true });
  }));
}

// ── Topics ─────────────────────────────────────────────────────────────────

export type TopicStatus = 'confirmed' | 'unconfirmed';

export interface TopicPage {
  status: TopicStatus;
  source: string;
  created?: string;
  updated?: string;
  /** Original header lines, including extensions and their order. */
  headerLines?: string[];
  body: string;
}

export function topicPagePath(topic: string, root?: string): string {
  return path.join(memoryPaths(root).topics, `${memorySlug(topic)}.md`);
}

const TOPIC_KEYS = ['Status', 'Source', 'Created', 'Updated'] as const;

/** Header lines, a blank line, then the body exactly as given. */
export function renderTopicPage(page: TopicPage): string {
  const values: Record<string, string | undefined> = {
    Status: page.status, Source: page.source, Created: page.created, Updated: page.updated,
  };
  const headers = page.headerLines ?? [];
  const last = new Map<string, number>();
  const matches = headers.map((line, index) => {
    const match = /^([^:]+):[ \t]*(.*)$/.exec(line);
    if (match) last.set(match[1], index);
    return match;
  });
  const seen = new Set<string>();
  const lines = headers.flatMap((line, index) => {
    const match = matches[index];
    if (!match || !TOPIC_KEYS.includes(match[1] as typeof TOPIC_KEYS[number])) return [line];
    const key = match[1];
    seen.add(key);
    const value = values[key];
    if (value === undefined) return [];
    if (index !== last.get(key) || match[2] === value) return [line];
    return [`${key}: ${value.replace(/\s*\n\s*/g, ' ').trim()}`];
  });
  for (const key of TOPIC_KEYS) {
    if (!seen.has(key) && values[key] !== undefined) lines.push(`${key}: ${values[key]!.replace(/\s*\n\s*/g, ' ').trim()}`);
  }
  return `${lines.join('\n')}\n\n${page.body}`;
}

/** Legacy pages need no dates; unknown header lines survive a round trip. */
export function parseTopicPage(text: string): TopicPage | null {
  const at = text.indexOf('\n\n');
  if (at < 0) return null;
  const lines = text.slice(0, at).split('\n');
  const headers = new Map<string, string>();
  for (const line of lines) {
    const match = /^([^:]+):[ \t]*(.*)$/.exec(line);
    if (match) headers.set(match[1], match[2]);
  }
  const status = headers.get('Status');
  const source = headers.get('Source');
  if ((status !== 'confirmed' && status !== 'unconfirmed') || source === undefined) return null;
  const page: TopicPage = { status, source, body: text.slice(at + 2) };
  if (headers.has('Created')) page.created = headers.get('Created');
  if (headers.has('Updated')) page.updated = headers.get('Updated');
  if (text.slice(0, at) !== `Status: ${status}\nSource: ${source.trim()}`) page.headerLines = lines;
  return page;
}

/** Only zoned, real, nonfuture content dates override the file's timestamp. */
export function topicUpdatedAt(page: TopicPage | null, mtimeMs: number, nowMs: number = Date.now()): number {
  const value = page?.updated ?? '';
  const match = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const updated = match ? Date.parse(value) : NaN;
  const day = match ? Date.parse(`${match[1]}T00:00:00Z`) : NaN;
  return Number.isFinite(updated) && updated <= nowMs && Number.isFinite(day)
    && new Date(day).toISOString().slice(0, 10) === match?.[1] ? updated : mtimeMs;
}

export const MAX_CONFLICT_NOTES = 5;
const CONFLICT_NOTE = /^Conflicting:[ \t]*(\d{4}-\d{2}-\d{2})(?=[ \t]|$)/;

export function hasConflictNotes(text: string): boolean {
  return text.split('\n').some((line) => CONFLICT_NOTE.test(line));
}

/** Explicit notes, not guessed contradictions: retain the newest five short entries. */
export function boundConflictNotes(text: string): string {
  const lines = text.split('\n');
  const notes = lines.flatMap((line, index) => {
    const match = CONFLICT_NOTE.exec(line);
    return match ? [{ index, date: match[1] }] : [];
  });
  notes.sort((a, b) => b.date.localeCompare(a.date) || b.index - a.index);
  const kept = new Set(notes.slice(0, MAX_CONFLICT_NOTES).map((note) => note.index));
  return lines.flatMap((line, index) => {
    if (!CONFLICT_NOTE.test(line)) return [line];
    return kept.has(index) ? [[...line].slice(0, 500).join('')] : [];
  }).join('\n');
}

export async function readTopic(topic: string, root?: string): Promise<TopicPage | null> {
  const text = await readIfExists(topicPagePath(topic, root));
  return text === null ? null : parseTopicPage(text);
}

export async function writeTopic(topic: string, page: TopicPage, root?: string): Promise<string> {
  await ensureMemoryLayout(root);
  const file = topicPagePath(topic, root);
  await memoryWrite(relativeMemoryPage(file, root), renderTopicPage(page), 'topic', root);
  return file;
}

// ── Access and versions ────────────────────────────────────────────────────

export const MAX_MEMORY_ACCESS_PAGES = 1_000;
export const MEMORY_HISTORY_VERSIONS = 5;
export const MEMORY_HISTORY_DAYS = 30;
export const MEMORY_HISTORY_DIR = 'history';
const DAY_MS = 86_400_000;

interface MemoryFileStamp {
  mtimeMs: number;
  hash: string;
}

export interface MemoryAccess {
  lastRead?: number;
  lastWrite?: number;
  lastWriter?: string;
  lastAgentWrite?: number;
  lastClubhouseWrite?: MemoryFileStamp;
  observed?: MemoryFileStamp;
  reads: number;
  writes: number;
}

export function memoryAccessPath(root: string = getDispatcherMemoryPath()): string {
  return path.join(path.dirname(root), 'memory-access.json');
}

export function relativeMemoryPage(file: string, root: string = getDispatcherMemoryPath()): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function hashMemory(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function fileStamp(value: unknown): value is MemoryFileStamp {
  return object(value) && timestamp(value.mtimeMs) && typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash);
}

export async function readMemoryAccess(root?: string): Promise<Record<string, MemoryAccess>> {
  const text = await readIfExists(memoryAccessPath(root));
  if (text === null) return {};
  const raw: unknown = JSON.parse(text);
  if (!object(raw) || raw.version !== 1 || !object(raw.pages)) throw new Error('Invalid memory access record.');
  const pages: Record<string, MemoryAccess> = {};
  for (const [page, value] of Object.entries(raw.pages)) {
    if (!object(value) || !timestamp(value.reads) || !timestamp(value.writes)
      || (value.lastRead !== undefined && !timestamp(value.lastRead))
      || (value.lastWrite !== undefined && !timestamp(value.lastWrite))
      || (value.lastAgentWrite !== undefined && !timestamp(value.lastAgentWrite))
      || (value.lastWriter !== undefined && (typeof value.lastWriter !== 'string' || value.lastWriter.length > 100))
      || (value.lastClubhouseWrite !== undefined && !fileStamp(value.lastClubhouseWrite))
      || (value.observed !== undefined && !fileStamp(value.observed))) throw new Error('Invalid memory access record.');
    pages[page] = {
      reads: value.reads, writes: value.writes,
      ...(timestamp(value.lastRead) && { lastRead: value.lastRead }),
      ...(timestamp(value.lastWrite) && { lastWrite: value.lastWrite }),
      ...(timestamp(value.lastAgentWrite) && { lastAgentWrite: value.lastAgentWrite }),
      ...(typeof value.lastWriter === 'string' && { lastWriter: value.lastWriter }),
      ...(fileStamp(value.lastClubhouseWrite) && { lastClubhouseWrite: value.lastClubhouseWrite }),
      ...(fileStamp(value.observed) && { observed: value.observed }),
    };
  }
  return pages;
}

async function updateMemoryAccess(page: string, update: (entry: MemoryAccess) => MemoryAccess, root?: string): Promise<void> {
  const file = memoryAccessPath(root);
  await withPageLock(file, async () => {
    const pages = await readMemoryAccess(root);
    pages[page] = update(pages[page] ?? { reads: 0, writes: 0 });
    const kept = Object.entries(pages).sort((a, b) => Math.max(b[1].lastRead ?? 0, b[1].lastWrite ?? 0)
      - Math.max(a[1].lastRead ?? 0, a[1].lastWrite ?? 0) || Number(b[0] === page) - Number(a[0] === page)).slice(0, MAX_MEMORY_ACCESS_PAGES);
    await writeFileAtomic(file, `${JSON.stringify({ version: 1, pages: Object.fromEntries(kept) })}\n`);
  });
}

export async function recordMemoryRead(page: string, root?: string, now: number = Date.now()): Promise<void> {
  await updateMemoryAccess(page, (entry) => ({ ...entry, lastRead: now, reads: Math.min(entry.reads + 1, Number.MAX_SAFE_INTEGER) }), root);
}

async function historyFiles(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && /^\d{13}-[a-f0-9]+\.md$/.test(e.name)).map((e) => e.name).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function historyPath(page: string, root: string = getDispatcherMemoryPath()): Promise<string> {
  const { resolveMemoryPage } = await import('./dispatcher-memory-reader');
  return path.dirname(await resolveMemoryPage(`${MEMORY_HISTORY_DIR}/${page}/snapshot.md`, root, true));
}

async function prunePageHistory(dir: string, now: number): Promise<void> {
  const files = await historyFiles(dir);
  const recent = files.filter((name) => now - Number(name.slice(0, 13)) <= MEMORY_HISTORY_DAYS * DAY_MS);
  const kept = new Set(recent.slice(-MEMORY_HISTORY_VERSIONS));
  for (const name of files) if (!kept.has(name)) await fsp.rm(path.join(dir, name));
}

async function rememberVersion(page: string, text: string, root: string, now: number): Promise<void> {
  if (page.startsWith(`${MEMORY_HISTORY_DIR}/`)) throw new Error('History cannot contain history.');
  const dir = await historyPath(page, root);
  const files = await historyFiles(dir);
  const last = files[files.length - 1];
  if (!last || await readIfExists(path.join(dir, last)) !== text) {
    const at = Math.max(Math.floor(now), last ? Number(last.slice(0, 13)) + 1 : 0);
    await writeFileAtomic(path.join(dir, `${String(at).padStart(13, '0')}-${randomBytes(8).toString('hex')}.md`), text);
  }
  await prunePageHistory(dir, now);
}

export async function pruneMemoryHistory(root: string = getDispatcherMemoryPath(), now: number = Date.now()): Promise<void> {
  const { resolveMemoryPage } = await import('./dispatcher-memory-reader');
  await resolveMemoryPage(`${MEMORY_HISTORY_DIR}/snapshot.md`, root, true);
  const walk = async (dir: string): Promise<void> => {
    let entries: import('fs').Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    await prunePageHistory(dir, now);
    for (const entry of entries) if (entry.isDirectory()) await walk(path.join(dir, entry.name));
  };
  await walk(path.join(root, MEMORY_HISTORY_DIR));
}

export async function moveMemoryHistory(from: string, to: string, root: string = getDispatcherMemoryPath()): Promise<void> {
  const source = await historyPath(from, root);
  const target = await historyPath(to, root);
  if (source === target) return;
  const files = await historyFiles(source);
  if (files.length) await fsp.mkdir(target, { recursive: true });
  for (const file of files) await fsp.rename(path.join(source, file), path.join(target, file));
  const current = await readIfExists(path.join(root, to));
  if (current !== null) await rememberVersion(to, current, root, Date.now());
  else await prunePageHistory(target, Date.now());
}

function sameStamp(a: MemoryFileStamp | undefined, b: MemoryFileStamp): boolean {
  // Some file systems round mtimes. The digest also catches edits within one timestamp tick.
  return !!a && Math.abs(a.mtimeMs - b.mtimeMs) < 1 && a.hash === b.hash;
}

/** Observe direct edits without rewriting the page. Unobserved legacy bytes have no recoverable prior version. */
export async function observeMemoryPage(page: string, root: string = getDispatcherMemoryPath(), now: number = Date.now()): Promise<void> {
  const realRoot = await fsp.realpath(root);
  await withPageLock(`write:${path.join(realRoot, page)}`, async () => {
    const text = await readIfExists(path.join(root, page));
    if (text === null) return;
    const stat = await fsp.stat(path.join(root, page));
    const stamp = { mtimeMs: stat.mtimeMs, hash: hashMemory(text) };
    const entry = (await readMemoryAccess(root))[page];
    if (sameStamp(entry?.observed, stamp)) return;
    await rememberVersion(page, text, root, now);
    await updateMemoryAccess(page, (current) => ({
      ...current, observed: stamp,
      ...(!sameStamp(current.lastClubhouseWrite, stamp) && {
        lastWrite: stat.mtimeMs,
        lastAgentWrite: entry?.observed ? now : page.startsWith('topics/') ? topicUpdatedAt(parseTopicPage(text), stat.mtimeMs, now) : stat.mtimeMs,
        lastWriter: 'agent direct',
        writes: Math.min(current.writes + 1, Number.MAX_SAFE_INTEGER),
      }),
    }), root);
  });
}

export interface MemoryWriteOptions {
  /** Link repairs and archive moves are not changes to the facts. */
  preserveFreshness?: boolean;
  timestamps?: { atimeMs: number; mtimeMs: number };
}

/** All Clubhouse page writes: previous bytes, stamped topics, bounded metadata and a current snapshot. */
export async function memoryWrite(
  page: string, content: string | ((previous: string | null) => string), reason: string, root: string = getDispatcherMemoryPath(), options: MemoryWriteOptions = {},
): Promise<string> {
  if (reason.length > 80) throw new Error('Memory write reason is too long.');
  const { resolveMemoryPage, MemoryReadError } = await import('./dispatcher-memory-reader');
  await fsp.mkdir(root, { recursive: true });
  const file = await resolveMemoryPage(page, root, true);
  const relative = relativeMemoryPage(file, await fsp.realpath(root));
  const kind = relative.toLowerCase();
  if (kind.startsWith(`${MEMORY_HISTORY_DIR}/`)) throw new MemoryReadError('Memory history is read only.');
  if (reason === 'agent tool' && kind.startsWith('archive/')) throw new MemoryReadError('Archived memory is read only.');
  return withPageLock(`write:${file}`, async () => {
    const previous = await readIfExists(file);
    const text = typeof content === 'function' ? content(previous) : content;
    if (reason === 'agent tool' && kind.startsWith('topics/') && !parseTopicPage(text)) {
      throw new MemoryReadError('Topic pages need Status and Source headers, then a blank line and the body.');
    }
    const stat = previous === null ? null : await fsp.stat(file);
    const now = Date.now();
    const entry = (await readMemoryAccess(root))[relative];
    const previousStamp = stat && previous !== null ? { mtimeMs: stat.mtimeMs, hash: hashMemory(previous) } : undefined;
    const direct = previousStamp && !sameStamp(entry?.observed ?? entry?.lastClubhouseWrite, previousStamp);
    if (reason === 'agent tool' && kind.startsWith('agents/')) {
      const before = parseAgentPage(previous ?? '');
      const after = parseAgentPage(text);
      if (before.card !== after.card) throw new Error('Only the agent and the user may change its Card. Keep the card and edit only Notes.');
    }
    let next = kind === 'index.md' ? capIndex(text) : text;
    const topic = kind.startsWith('topics/') ? parseTopicPage(next) : null;
    if (topic && !options.preserveFreshness) {
      const before = previous === null ? null : parseTopicPage(previous);
      const headerLines = [...(topic.headerLines ?? before?.headerLines ?? [])];
      for (const line of before?.headerLines ?? []) {
        const key = /^([^:]+):/.exec(line)?.[1];
        if (key && TOPIC_KEYS.includes(key as typeof TOPIC_KEYS[number])) continue;
        if (!headerLines.includes(line) && (!key || !headerLines.some((header) => header.startsWith(`${key}:`)))) headerLines.push(line);
      }
      next = renderTopicPage({ ...topic, headerLines, created: before?.created ?? topic.created ?? new Date(now).toISOString(),
        updated: new Date(now).toISOString(), body: boundConflictNotes(topic.body) });
    } else if (kind.startsWith('agents/')) {
      const notes = /^## Notes[ \t]*$/m.exec(next);
      if (notes) {
        const start = notes.index + notes[0].length;
        next = next.slice(0, start) + boundConflictNotes(next.slice(start));
      }
    } else next = boundConflictNotes(next);
    if (previous !== null) await rememberVersion(relative, previous, root, now);
    if (next !== previous) await writeFileAtomic(file, next, options.timestamps ?? (options.preserveFreshness && stat ? stat : undefined));
    const written = await fsp.stat(file);
    const stamp = { mtimeMs: written.mtimeMs, hash: hashMemory(next) };
    await rememberVersion(relative, next, root, now + 1);
    await updateMemoryAccess(relative, (current) => ({
      ...current, lastWrite: now, lastWriter: reason === 'agent tool' ? reason : `clubhouse:${reason}`,
      lastClubhouseWrite: stamp, observed: stamp, writes: Math.min(current.writes + 1, Number.MAX_SAFE_INTEGER),
      ...(direct && previousStamp && { lastAgentWrite: entry?.observed ? now
        : relative.startsWith('topics/') ? topicUpdatedAt(parseTopicPage(previous!), previousStamp.mtimeMs, now) : previousStamp.mtimeMs }),
      ...(reason === 'agent tool' && { lastAgentWrite: now }),
    }), root);
    return next;
  });
}
