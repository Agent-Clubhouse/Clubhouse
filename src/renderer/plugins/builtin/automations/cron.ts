/**
 * Lightweight 5-field cron parser and matcher.
 * Fields: minute hour dom month dow
 */

export function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    const range = stepMatch ? stepMatch[1] : part;

    let start: number;
    let end: number;
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

export function describeSchedule(expression: string): string {
  const preset = PRESETS.find((p) => p.value === expression);
  if (preset) return preset.label;

  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return expression;

  const [min, hour, dom, mon, dow] = fields;

  // Every N minutes
  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Every ${min.slice(2)} minutes`;
  }

  // Specific minute every hour
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Every hour at :${min.padStart(2, '0')}`;
  }

  // Specific time daily
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    const h = parseInt(hour, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `Daily at ${h12}:${min.padStart(2, '0')} ${ampm}`;
  }

  // Weekdays at specific time
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '1-5') {
    const h = parseInt(hour, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `Weekdays at ${h12}:${min.padStart(2, '0')} ${ampm}`;
  }

  return expression;
}

export const PRESETS = [
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every 30 minutes', value: '*/30 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Daily at 9 AM', value: '0 9 * * *' },
  { label: 'Daily at midnight', value: '0 0 * * *' },
  { label: 'Weekdays at 9 AM', value: '0 9 * * 1-5' },
] as const;
