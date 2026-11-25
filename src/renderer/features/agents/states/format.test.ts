import { describe, it, expect } from 'vitest';
import { describeSleep, formatRunTokens } from './format';

describe('describeSleep (#2104)', () => {
  const at = '2026-10-18T03:01:06.000Z';
  it.each([
    [{ reason: 'idle', at, idleMinutes: 30 }, 'slept after 30 min idle'],
    [{ reason: 'idle', at, idleMinutes: 240 }, 'slept after 4 h idle'],
    [{ reason: 'idle', at }, 'slept after idle'],
    [{ reason: 'user', at }, 'stopped by you'],
    [{ reason: 'agent', at, by: 'Clubhouse-PM' }, 'put to sleep by Clubhouse-PM'],
    [{ reason: 'agent', at }, 'put to sleep by another agent'],
    [{ reason: 'crashed', at, exitCode: 1 }, 'CLI exited (code 1)'],
    [{ reason: 'exited', at }, 'CLI exited'],
  ] as const)('%o → %s', (info, text) => {
    expect(describeSleep(info)).toBe(text);
  });
});

describe('formatRunTokens', () => {
  it.each([
    [undefined, undefined, 'Not reported'],
    [0, 0, '0'],
    [12_000, 800, '12k in, 800 out'],
    [undefined, 4, 'unknown in, 4 out'],
    [0, undefined, '0 in, unknown out'],
  ] as const)('%s in, %s out → %s', (input, output, text) => {
    expect(formatRunTokens(input, output)).toBe(text);
  });
});
