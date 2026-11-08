/**
 * A minimal 5-field cron parser for Actions schedules (#2918), in local time.
 *
 *   minute  hour  day-of-month  month  day-of-week
 *
 * Each field takes `*`, a number, a range `a-b`, a step `x/n` (on `*` or a
 * range), or a comma list of those. Months and days also take three-letter
 * names (JAN, MON), and day 7 is Sunday like day 0. As in standard cron, when
 * both day fields are restricted a time matches either of them.
 *
 * Schedules follow the machine's clock across daylight saving changes: a time
 * skipped by a spring-forward runs at the first minute after the jump, and a
 * time repeated by a fall-back runs once.
 */

export interface CronSpec {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dayOfWeek: ReadonlySet<number>;
  /** The day-of-month field starts with `*`, so it doesn't restrict days (standard cron's rule). */
  anyDayOfMonth: boolean;
  /** The day-of-week field starts with `*`. */
  anyDayOfWeek: boolean;
  /** The hour field starts with `*`: such schedules also run in an hour a fall-back repeats. */
  anyHour: boolean;
}

export type CronParseResult = { ok: true; spec: CronSpec; error?: undefined } | { ok: false; error: string; spec?: undefined };

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Offset of names[0] (months start at 1). */
  nameBase?: number;
}

const FIELDS: FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of the month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  // 7 is accepted as Sunday and folded to 0 below.
  { name: 'day of the week', min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
];

function parseValue(raw: string, def: FieldDef): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (def.names) {
    const i = def.names.indexOf(raw.toUpperCase());
    if (i >= 0) return i + (def.nameBase ?? 0);
  }
  return null;
}

function parseField(field: string, def: FieldDef): Set<number> | string {
  const values = new Set<number>();
  if (!field) return `The ${def.name} is empty.`;
  for (const part of field.split(',')) {
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined) return `“${part}” in the ${def.name} has more than one “/”.`;
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) return `The step in “${part}” (${def.name}) must be a whole number of 1 or more.`;
      step = Number(stepText);
    }
    let start: number;
    let end: number;
    if (range === '*') {
      start = def.min;
      end = def.max === 7 ? 6 : def.max;
    } else {
      const bounds = range.split('-');
      if (bounds.length > 2) return `“${range}” in the ${def.name} isn’t a range.`;
      const a = parseValue(bounds[0], def);
      const b = bounds.length === 2 ? parseValue(bounds[1], def) : a;
      if (a === null || b === null) return `“${range}” isn’t a valid ${def.name}.`;
      start = a;
      // `5/15` means from 5 to the end, every 15.
      end = bounds.length === 1 && stepText !== undefined ? (def.max === 7 ? 6 : def.max) : b;
      if (start < def.min || start > def.max || end < def.min || end > def.max) {
        return `The ${def.name} must be between ${def.min} and ${def.max === 7 ? 6 : def.max}.`;
      }
      if (end < start) return `“${range}” in the ${def.name} runs backwards.`;
    }
    for (let v = start; v <= end; v += step) values.add(def.max === 7 && v === 7 ? 0 : v);
  }
  return values;
}

/** Parse a 5-field cron line. Errors are one sentence in plain words. */
export function parseCron(expression: string): CronParseResult {
  const fields = expression.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    return { ok: false, error: `A schedule line needs 5 parts (minute, hour, day of the month, month, day of the week). This one has ${fields.length}.` };
  }
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const parsed = parseField(fields[i], FIELDS[i]);
    if (typeof parsed === 'string') return { ok: false, error: parsed };
    sets.push(parsed);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = sets;
  return {
    ok: true,
    spec: {
      minute, hour, dayOfMonth, month, dayOfWeek,
      anyDayOfMonth: fields[2].startsWith('*'),
      anyDayOfWeek: fields[4].startsWith('*'),
      anyHour: fields[1].startsWith('*'),
    },
  };
}

/** The error for an invalid cron line, or null when it parses. */
export function validateCron(expression: string): string | null {
  const parsed = parseCron(expression);
  return parsed.ok ? null : parsed.error;
}

function dayMatchesFields(spec: CronSpec, date: number, weekday: number): boolean {
  const dom = spec.dayOfMonth.has(date);
  const dow = spec.dayOfWeek.has(weekday);
  // Standard cron: when either field starts with `*` both must match (a bare
  // `*` matches every day); when both are restricted, either may.
  return spec.anyDayOfMonth || spec.anyDayOfWeek ? dom && dow : dom || dow;
}

/** Whether the spec matches this local minute. */
export function cronMatches(spec: CronSpec, d: Date): boolean {
  return spec.minute.has(d.getMinutes())
    && spec.hour.has(d.getHours())
    && spec.month.has(d.getMonth() + 1)
    && dayMatchesFields(spec, d.getDate(), d.getDay());
}

/** Enough steps to search more than four years of skipped days and hours. */
const SEARCH_LIMIT = 50_000;
const MINUTE_MS = 60_000;

/**
 * The next wall-clock minute that matches, strictly after `wall`. Wall-clock
 * times are held in a UTC Date used as a plain calendar, so the search itself
 * never meets a daylight saving change.
 */
function nextWallTime(spec: CronSpec, wall: Date): Date | null {
  const d = new Date(wall.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  for (let i = 0; i < SEARCH_LIMIT; i++) {
    if (!spec.month.has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatchesFields(spec, d.getUTCDate(), d.getUTCDay())) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hour.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minute.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  return null;
}

/** A local instant as a wall-clock calendar date. */
function toWall(instant: number): Date {
  const l = new Date(instant);
  return new Date(Date.UTC(l.getFullYear(), l.getMonth(), l.getDate(), l.getHours(), l.getMinutes()));
}

function sameWall(instant: number, wall: Date): boolean {
  return toWall(instant).getTime() === wall.getTime();
}

/**
 * The first matching minute strictly after `after`, or null when the spec
 * never matches (e.g. 30 February).
 *
 * Daylight saving: a wall time a spring-forward skips runs at the first
 * minute after the jump. In an hour a fall-back repeats, a schedule with a
 * fixed hour runs once (the first time); one whose hour field is `*` runs in
 * both.
 */
export function nextCronTime(spec: CronSpec, after: Date | number): Date | null {
  const afterMs = typeof after === 'number' ? after : after.getTime();
  const byWall = nextByWallClock(spec, afterMs);
  if (!spec.anyHour) return byWall;
  // An hour a fall-back repeats lies behind the wall clock: look at the next
  // two real hours minute by minute, so `*` hours run through it.
  const start = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = Math.min(byWall ? byWall.getTime() : Infinity, afterMs + 120 * MINUTE_MS);
  for (let t = start; t < limit; t += MINUTE_MS) {
    if (cronMatches(spec, new Date(t))) return new Date(t);
  }
  return byWall;
}

function nextByWallClock(spec: CronSpec, afterMs: number): Date | null {
  let wall = toWall(afterMs);
  for (let i = 0; i < SEARCH_LIMIT; i++) {
    const next = nextWallTime(spec, wall);
    if (!next) return null;
    wall = next;
    const y = next.getUTCFullYear(), mo = next.getUTCMonth(), day = next.getUTCDate(), h = next.getUTCHours(), mi = next.getUTCMinutes();
    const first = new Date(y, mo, day, h, mi).getTime();
    if (!sameWall(first, next)) {
      // Skipped by a spring-forward: the first real minute after the jump.
      const afterJump = new Date(y, mo, day, h, 0).getTime();
      const jump = sameWall(afterJump, new Date(Date.UTC(y, mo, day, h, 0))) ? first : afterJump;
      if (jump > afterMs) return new Date(jump);
      continue;
    }
    if (first > afterMs) return new Date(first);
    // The wall time came round again after a fall-back: its second instance.
    for (const shift of [30, 60, 120]) {
      const second = first + shift * MINUTE_MS;
      if (second > afterMs && sameWall(second, next)) {
        if (spec.anyHour) return new Date(second);
        break;
      }
    }
  }
  return null;
}

/** The next `count` run times after `after`, for the form's preview. */
export function nextCronTimes(spec: CronSpec, after: Date | number, count: number): Date[] {
  const out: Date[] = [];
  let from: Date | number = after;
  for (let i = 0; i < count; i++) {
    const next = nextCronTime(spec, from);
    if (!next) break;
    out.push(next);
    from = next;
  }
  return out;
}

/**
 * The schedule times in (from, to], oldest first, at most `limit`. Used for
 * missed-run catch-up.
 */
export function cronTimesBetween(spec: CronSpec, from: number, to: number, limit: number): number[] {
  const out: number[] = [];
  let cursor = from;
  while (out.length < limit) {
    const next = nextCronTime(spec, cursor);
    if (!next || next.getTime() > to) break;
    out.push(next.getTime());
    cursor = next.getTime();
  }
  return out;
}

// ── Plain words ─────────────────────────────────────────────────────────────

const DAY_WORDS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_WORDS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "9:00 AM", "12:30 PM". */
export function formatClock(hour: number, minute: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function sorted(set: ReadonlySet<number>): number[] {
  return [...set].sort((a, b) => a - b);
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** Evenly spaced values from the field's start: the step, or null. */
function everyN(values: number[], min: number, max: number): number | null {
  if (values.length < 2 || values[0] !== min) return null;
  const step = values[1] - values[0];
  for (let i = 1; i < values.length; i++) if (values[i] - values[i - 1] !== step) return null;
  return values[values.length - 1] + step > max ? step : null;
}

function describeDays(spec: CronSpec): string {
  const dows = sorted(spec.dayOfWeek);
  const doms = sorted(spec.dayOfMonth);
  const monthText = spec.month.size === 12 ? '' : ` in ${joinWords(sorted(spec.month).map((m) => MONTH_WORDS[m - 1]))}`;
  // Standard cron: a day field starting with `*` doesn't restrict; two restricted fields match either.
  const dowRestricts = !spec.anyDayOfWeek && dows.length < 7;
  const domRestricts = !spec.anyDayOfMonth && doms.length < 31;
  const everyDay = (!spec.anyDayOfWeek && !spec.anyDayOfMonth)
    ? !(dowRestricts && domRestricts)
    : !(spec.anyDayOfWeek ? domRestricts : dowRestricts);
  if (everyDay) return monthText ? `every day${monthText}` : 'every day';
  const dowText = (() => {
    if (dows.join() === '1,2,3,4,5') return 'weekdays';
    if (dows.join() === '0,6') return 'weekends';
    return joinWords(dows.map((d) => `${DAY_WORDS[d]}s`));
  })();
  const domText = `the ${joinWords(doms.map(ordinal))}`;
  if (!spec.anyDayOfWeek && !spec.anyDayOfMonth) return `on ${domText} or on ${dowText}${monthText}`;
  if (spec.anyDayOfWeek) return `on ${domText} of the month${monthText}`;
  return `on ${dowText}${monthText}`;
}

/**
 * A cron line in plain words, e.g. "Weekdays at 9:00 AM", "Every 15 minutes",
 * "Every hour at 30 minutes past". Invalid lines describe their error.
 */
export function describeCron(expression: string): string {
  const parsed = parseCron(expression);
  if (!parsed.ok) return parsed.error;
  const spec = parsed.spec;
  const minutes = sorted(spec.minute);
  const hours = sorted(spec.hour);
  const days = describeDays(spec);
  const everyDay = days === 'every day';
  const onDays = everyDay ? '' : `, ${days}`;

  // Every N minutes, every hour.
  if (hours.length === 24) {
    const step = everyN(minutes, 0, 59);
    if (minutes.length === 60) return `Every minute${onDays}`;
    if (step) return `Every ${step} minutes${onDays}`;
    if (minutes.length === 1) {
      return minutes[0] === 0 ? `Every hour${onDays}` : `Every hour at ${minutes[0]} minutes past${onDays}`;
    }
    return `Every hour at ${joinWords(minutes.map(String))} minutes past${onDays}`;
  }
  // Every N hours.
  const hourStep = everyN(hours, 0, 23);
  if (hourStep && minutes.length === 1) {
    const past = minutes[0] === 0 ? '' : ` at ${minutes[0]} minutes past`;
    return `Every ${hourStep} hours${past}${onDays}`;
  }
  // Set times of day.
  if (minutes.length * hours.length <= 6) {
    const times = hours.flatMap((h) => minutes.map((m) => formatClock(h, m)));
    const at = `at ${joinWords(times)}`;
    if (everyDay) return `Every day ${at}`;
    if (days === 'on weekdays') return `Weekdays ${at}`;
    if (days === 'on weekends') return `Weekends ${at}`;
    const capital = days.charAt(0).toUpperCase() + days.slice(1);
    return `${capital} ${at}`;
  }
  const minuteText = minutes.length === 60 ? 'every minute' : `at ${joinWords(minutes.map(String))} minutes past`;
  return `${minuteText.charAt(0).toUpperCase() + minuteText.slice(1)} during ${joinWords(hours.map((h) => formatClock(h, 0)))}${onDays}`;
}
