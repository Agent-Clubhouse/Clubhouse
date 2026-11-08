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
import { randomBytes } from 'crypto';
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
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, content, 'utf-8');
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
  try {
    await fsp.writeFile(paths.index, DEFAULT_INDEX, { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
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
  return (await readIfExists(memoryPaths(root).index)) ?? '';
}

/** Replace index.md, cut to its cap. Returns what was written. */
export async function writeIndex(content: string, root?: string, cap: number = MEMORY_INDEX_CAP_BYTES): Promise<string> {
  const capped = capIndex(content, cap);
  await writeFileAtomic(memoryPaths(root).index, capped);
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

export function renderAgentPage(agent: string, page: AgentPage): string {
  return `# ${agent}\n\n${AGENT_CARD_HEADING}\n\n${guardSection(page.card)}\n\n${AGENT_NOTES_HEADING}\n\n${guardSection(page.notes)}\n`;
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

async function writeAgentSection(agent: string, section: keyof AgentPage, text: string, root?: string): Promise<AgentPage> {
  await ensureMemoryLayout(root);
  return withPageLock(agentPagePath(agent, root), async () => {
    const current = (await readAgentPage(agent, root)) ?? { card: '', notes: '' };
    const next = { ...current, [section]: text };
    await writeFileAtomic(agentPagePath(agent, root), renderAgentPage(agent, next));
    return parseAgentPage(renderAgentPage(agent, next));
  });
}

/** Replace the agent's card, keeping the Dispatcher's notes. */
export function writeAgentCard(agent: string, card: string, root?: string): Promise<AgentPage> {
  return writeAgentSection(agent, 'card', card, root);
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
    await writeFileAtomic(file, renderAgentPage(agent, { card: AGENT_CARD_PLACEHOLDER, notes: '' }));
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
      if (page) await writeFileAtomic(toFile, renderAgentPage(to, page));
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
    await writeFileAtomic(toFile, renderAgentPage(to, { card, notes }));
    await fsp.rm(fromFile, { force: true });
  }));
}

// ── Topics ─────────────────────────────────────────────────────────────────

export type TopicStatus = 'confirmed' | 'unconfirmed';

export interface TopicPage {
  status: TopicStatus;
  source: string;
  body: string;
}

export function topicPagePath(topic: string, root?: string): string {
  return path.join(memoryPaths(root).topics, `${memorySlug(topic)}.md`);
}

/**
 * A topic page is a `Status:` line and a `Source:` line, a blank line, then the
 * body exactly as given.
 */
export function renderTopicPage(page: TopicPage): string {
  const source = page.source.replace(/\s*\n\s*/g, ' ').trim();
  return `Status: ${page.status}\nSource: ${source}\n\n${page.body}`;
}

/** Null when the text doesn't start with a `Status:` header. */
export function parseTopicPage(text: string): TopicPage | null {
  const match = /^Status: (confirmed|unconfirmed)\nSource: ([^\n]*)\n\n/.exec(text);
  if (!match) return null;
  return { status: match[1] as TopicStatus, source: match[2], body: text.slice(match[0].length) };
}

export async function readTopic(topic: string, root?: string): Promise<TopicPage | null> {
  const text = await readIfExists(topicPagePath(topic, root));
  return text === null ? null : parseTopicPage(text);
}

export async function writeTopic(topic: string, page: TopicPage, root?: string): Promise<string> {
  await ensureMemoryLayout(root);
  const file = topicPagePath(topic, root);
  await writeFileAtomic(file, renderTopicPage(page));
  return file;
}
