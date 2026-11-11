/**
 * The Dispatcher's timeline (#3038): timestamped lines about what happened, one
 * file per day. Detail fades with age: days roll into ISO weeks
 * (`2026-W45.md`), weeks into months (`2026-11.md`), and every rolled file keeps
 * the links of what went into it, so transcripts stay reachable.
 *
 * This is the rollup itself. When it runs is the upkeep's call (#3040), and
 * the upkeep can pass a `condense` step that shortens the text; without one the
 * text moves as it is. Either way no link is lost and no file is removed
 * before its text is safely in the next one, so a crash part way through and a
 * second run are both harmless.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { memoryPaths, readIfExists, memoryWrite, relativeMemoryPage } from './dispatcher-memory';

const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.md$/;
const WEEK_FILE = /^(\d{4})-W(\d{2})\.md$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** The local calendar day of `date`, as `YYYY-MM-DD`. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A `YYYY-MM-DD` key as a UTC midnight, for whole-day arithmetic. */
function dayKeyToUtc(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** The ISO week a day belongs to, as `YYYY-Www`, and its Monday. */
export function isoWeekOf(key: string): { week: string; monday: number } {
  const t = new Date(dayKeyToUtc(key));
  const weekday = t.getUTCDay() || 7;
  const monday = t.getTime() - (weekday - 1) * DAY_MS;
  // The week's Thursday decides its year.
  const thursday = new Date(monday + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return { week: `${year}-W${pad(week)}`, monday };
}

/** Monday of an ISO week given as year and week number. */
function isoWeekMonday(year: number, week: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Weekday = new Date(jan4).getUTCDay() || 7;
  return jan4 - (jan4Weekday - 1) * DAY_MS + (week - 1) * 7 * DAY_MS;
}

/** Every link target in markdown text, in order, without repeats. */
export function linkTargets(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) seen.add(match[1]);
  return [...seen];
}

export interface TimelineEntry {
  at: Date;
  text: string;
  /** Where the full record is, such as a transcript path. */
  transcript?: string;
}

/** Add a line to the entry's day file, creating it if needed. Returns the file. */
export async function appendTimeline(entry: TimelineEntry, root?: string): Promise<string> {
  const dir = memoryPaths(root).timeline;
  await fsp.mkdir(dir, { recursive: true });
  const key = dayKey(entry.at);
  const file = path.join(dir, `${key}.md`);
  const text = entry.text.replace(/\s*\n\s*/g, ' ').trim();
  const link = entry.transcript ? ` ([transcript](${entry.transcript}))` : '';
  const line = `- ${pad(entry.at.getHours())}:${pad(entry.at.getMinutes())} ${text}${link}\n`;
  const existing = await readIfExists(file);
  await memoryWrite(relativeMemoryPage(file, root), existing === null ? `# ${key}\n\n${line}`
    : `${existing}${existing.endsWith('\n') || existing === '' ? '' : '\n'}${line}`, 'timeline', root);
  return file;
}

export interface CondenseInput {
  /** What the text is being rolled into. */
  into: 'week' | 'month';
  /** The day (`YYYY-MM-DD`) or week (`YYYY-Www`) being rolled. */
  from: string;
  text: string;
}

export interface RollupOptions {
  /** Days at least this old roll into their week. Default 7. */
  keepDays?: number;
  /** Weeks that ended at least this many weeks ago roll into their month. Default 4. */
  keepWeeks?: number;
  /** Shortens text as it rolls up, for example with a model. Links it drops are added back. */
  condense?: (input: CondenseInput) => Promise<string>;
}

export interface RollupResult {
  /** Day keys rolled into weeks. */
  days: string[];
  /** Week keys rolled into months. */
  weeks: string[];
}

/** Condensed text with any link the source had and the result lost added back at the end. */
async function condenseKeepingLinks(input: CondenseInput, condense: RollupOptions['condense']): Promise<string> {
  const source = input.text.trim();
  if (!condense) return source;
  const out = (await condense(input)).trim();
  const kept = new Set(linkTargets(out));
  const missing = linkTargets(source).filter((t) => !kept.has(t));
  if (!missing.length) return out;
  return `${out}\n\n${missing.map((t) => `- [link](${t})`).join('\n')}`;
}

/** The text of a file without its `# ` title line. */
function withoutTitle(text: string): string {
  return text.replace(/^# [^\n]*\n/, '').trim();
}

/**
 * Append `## heading` and `body` to `file` (created with `title` if missing),
 * unless that exact section is already there from an earlier, interrupted run.
 */
async function appendSection(file: string, title: string, heading: string, body: string, root?: string): Promise<void> {
  const section = `## ${heading}\n\n${body}\n`;
  const existing = await readIfExists(file);
  if (existing === null) {
    await memoryWrite(relativeMemoryPage(file, root), `# ${title}\n\n${section}`, 'timeline rollup', root);
    return;
  }
  if (existing.includes(section)) return;
  await memoryWrite(relativeMemoryPage(file, root), `${existing.trimEnd()}\n\n${section}`, 'timeline rollup', root);
}

/**
 * Roll old days into weeks, then old weeks into months, as of `now`.
 * Idempotent: a second run with nothing old enough does nothing.
 */
export async function rollUpTimeline(now: Date, options: RollupOptions = {}, root?: string): Promise<RollupResult> {
  const keepDays = options.keepDays ?? 7;
  const keepWeeks = options.keepWeeks ?? 4;
  const dir = memoryPaths(root).timeline;
  const today = dayKeyToUtc(dayKey(now));
  const result: RollupResult = { days: [], weeks: [] };
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw err;
  }

  for (const name of names) {
    if (!DAY_FILE.test(name)) continue;
    const key = name.slice(0, -3);
    if ((today - dayKeyToUtc(key)) / DAY_MS < keepDays) continue;
    const file = path.join(dir, name);
    const text = withoutTitle((await readIfExists(file)) ?? '');
    const { week } = isoWeekOf(key);
    if (text) {
      const body = await condenseKeepingLinks({ into: 'week', from: key, text }, options.condense);
      await appendSection(path.join(dir, `${week}.md`), `Week ${week}`, key, body, root);
    }
    await fsp.rm(file, { force: true });
    result.days.push(key);
  }

  for (const name of (await fsp.readdir(dir)).sort()) {
    const match = WEEK_FILE.exec(name);
    if (!match) continue;
    const monday = isoWeekMonday(Number(match[1]), Number(match[2]));
    const sunday = monday + 6 * DAY_MS;
    if ((today - sunday) / DAY_MS < keepWeeks * 7) continue;
    const week = name.slice(0, -3);
    const file = path.join(dir, name);
    const text = withoutTitle((await readIfExists(file)) ?? '');
    // A week spanning two months goes to the month of its Thursday, like its year.
    const thursday = new Date(monday + 3 * DAY_MS);
    const month = `${thursday.getUTCFullYear()}-${pad(thursday.getUTCMonth() + 1)}`;
    if (text) {
      const body = await condenseKeepingLinks({ into: 'month', from: week, text }, options.condense);
      await appendSection(path.join(dir, `${month}.md`), `Month ${month}`, week, body, root);
    }
    await fsp.rm(file, { force: true });
    result.weeks.push(week);
  }
  return result;
}
