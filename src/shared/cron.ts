// Lightweight 5-field cron expression matcher.
// Format: minute hour day-of-month month day-of-week
// Supports: *, specific values, comma lists, ranges (1-5), steps (star/15)

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    const range = stepMatch ? stepMatch[1] : part;

    let start: number, end: number;
    if (range === '*') {
      start = min;
      end = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      start = a;
      end = b;
    } else {
      start = parseInt(range, 10);
      end = start;
    }

    for (let i = start; i <= end; i += step) {
      values.add(i);
    }
  }
  return values;
}

export function matchesCron(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dom = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dow = parseField(fields[4], 0, 6);

  return (
    minute.has(date.getMinutes()) &&
    hour.has(date.getHours()) &&
    dom.has(date.getDate()) &&
    month.has(date.getMonth() + 1) &&
    dow.has(date.getDay())
  );
}

const PRESETS: Record<string, string> = {
  '*/1 * * * *': 'Every minute',
  '*/5 * * * *': 'Every 5 minutes',
  '*/15 * * * *': 'Every 15 minutes',
  '*/30 * * * *': 'Every 30 minutes',
  '0 * * * *': 'Every hour',
  '0 */6 * * *': 'Every 6 hours',
  '0 0 * * *': 'Daily at midnight',
  '0 9 * * *': 'Daily at 9 AM',
  '0 9 * * 1': 'Weekly on Monday at 9 AM',
};

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function describeSchedule(expression: string): string {
  const preset = PRESETS[expression.trim()];
  if (preset) return preset;

  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return 'Invalid cron expression';

  const [min, hour, dom, month, dow] = fields;
  const parts: string[] = [];

  if (min.startsWith('*/')) parts.push(`Every ${min.slice(2)} min`);
  else if (hour.startsWith('*/')) parts.push(`Every ${hour.slice(2)} hours`);
  else if (min !== '*' && hour !== '*') parts.push(`At ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`);
  else if (min !== '*') parts.push(`At minute ${min}`);
  else parts.push('Every minute');

  if (dom !== '*') parts.push(`on day ${dom}`);
  if (month !== '*') parts.push(`in month ${month}`);
  if (dow !== '*') {
    const days = dow.split(',').map((d) => DOW_NAMES[parseInt(d, 10)] || d);
    parts.push(`on ${days.join(', ')}`);
  }

  return parts.join(' ');
}
