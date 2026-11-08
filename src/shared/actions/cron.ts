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
  /** The day-of-month field was `*` (or covers every day). */
  anyDayOfMonth: boolean;
  /** The day-of-week field was `*` (or covers every day). */
  anyDayOfWeek: boolean;
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
      anyDayOfMonth: dayOfMonth.size === 31,
      anyDayOfWeek: dayOfWeek.size === 7,
    },
  };
}

/** The error for an invalid cron line, or null when it parses. */
export function validateCron(expression: string): string | null {
  const parsed = parseCron(expression);
  return parsed.ok ? null : parsed.error;
}

function dayMatches(spec: CronSpec, d: Date): boolean {
  const dom = spec.dayOfMonth.has(d.getDate());
  const dow = spec.dayOfWeek.has(d.getDay());
  if (spec.anyDayOfMonth && spec.anyDayOfWeek) return true;
  if (spec.anyDayOfMonth) return dow;
  if (spec.anyDayOfWeek) return dom;
  return dom || dow;
}

/** Whether the spec matches this local minute. */
export function cronMatches(spec: CronSpec, d: Date): boolean {
  return spec.minute.has(d.getMinutes())
    && spec.hour.has(d.getHours())
    && spec.month.has(d.getMonth() + 1)
    && dayMatches(spec, d);
}

/** Enough steps to search more than four years of skipped days and hours. */
const SEARCH_LIMIT = 50_000;

/**
 * The first matching minute strictly after `after`, or null when the spec
 * never matches (e.g. 30 February).
 */
export function nextCronTime(spec: CronSpec, after: Date | number): Date | null {
  const d = new Date(typeof after === 'number' ? after : after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < SEARCH_LIMIT; i++) {
    if (!spec.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(spec, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hour.has(d.getHours())) {
      const hour = d.getHours();
      const day = d.getDate();
      d.setHours(hour + 1, 0, 0, 0);
      // A spring-forward skipped a whole hour: a schedule time in that hour
      // runs at the first minute after the jump, as standard cron does.
      if (d.getDate() === day && d.getHours() > hour + 1 && spec.hour.has(hour + 1)) return d;
      continue;
    }
    if (!spec.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(d.getTime());
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
  const dowText = (() => {
    if (spec.anyDayOfWeek) return '';
    if (dows.join() === '1,2,3,4,5') return 'weekdays';
    if (dows.join() === '0,6') return 'weekends';
    return joinWords(dows.map((d) => `${DAY_WORDS[d]}s`));
  })();
  const domText = spec.anyDayOfMonth ? '' : `the ${joinWords(doms.map(ordinal))}`;
  const monthText = spec.month.size === 12 ? '' : ` in ${joinWords(sorted(spec.month).map((m) => MONTH_WORDS[m - 1]))}`;
  if (!dowText && !domText) return monthText ? `every day${monthText}` : 'every day';
  if (dowText && domText) return `on ${domText} or on ${dowText}${monthText}`;
  if (domText) return `on ${domText} of the month${monthText}`;
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
