import { describe, it, expect } from 'vitest';
import { greetingPool, hashId, pickGreeting, timeOfDay } from './greetings';

describe('timeOfDay', () => {
  it.each([
    [5, 'morning'], [11, 'morning'],
    [12, 'afternoon'], [17, 'afternoon'],
    [18, 'evening'], [21, 'evening'],
    [22, 'night'], [0, 'night'], [4, 'night'],
  ])('hour %i is %s', (hour, expected) => {
    expect(timeOfDay(hour)).toBe(expected);
  });
});

describe('greetingPool', () => {
  it('mixes the time-of-day set with the any-time set and fills in the name', () => {
    const pool = greetingPool('Clubhouse-PM', 9);
    expect(pool).toHaveLength(13);
    expect(pool).toContain('Early bird gets the worm.');
    expect(pool).toContain('Got something for Clubhouse-PM?');
    expect(pool).toContain('Clubhouse-PM is rested and ready.');
  });

  it('uses only the any-time set in the evening, which still has at least eight lines', () => {
    const evening = greetingPool('a', 19);
    expect(evening.length).toBeGreaterThanOrEqual(8);
    expect(evening).toContain('Got something for a?');
    expect(evening).toContain("What's next for a?");
    expect(evening).toContain('a is ready and waiting.');
  });

  it('covers all nineteen lines across the day', () => {
    const all = new Set([...greetingPool('x', 8), ...greetingPool('x', 14), ...greetingPool('x', 23)]);
    expect(all.size).toBe(19);
  });

  it('follows the copy rules: no em dashes, no colon reveals, no all-caps words', () => {
    for (const hour of [8, 14, 19, 23]) {
      for (const line of greetingPool('curious-tapir', hour)) {
        expect(line).not.toMatch(/\u2014/);
        expect(line).not.toMatch(/: /);
        expect(line).not.toMatch(/\b[A-Z]{2,}\b/);
      }
    }
  });
});

describe('pickGreeting', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `durable_${1771298226364 + i * 7919}_${i.toString(36)}`);

  it('gives an agent the same line every time', () => {
    const first = pickGreeting('durable_1771298226364_yno2uf', 'faithful-urchin', 19);
    for (let i = 0; i < 20; i++) expect(pickGreeting('durable_1771298226364_yno2uf', 'faithful-urchin', 19)).toBe(first);
    expect(greetingPool('faithful-urchin', 19)).toContain(first);
  });

  it('spreads agents across every line, none taking more than a quarter', () => {
    const pool = greetingPool('x', 19);
    const counts = new Map<string, number>();
    for (const id of ids) {
      const line = pickGreeting(id, 'x', 19);
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    expect(counts.size).toBe(pool.length);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(ids.length / 4);
  });

  it('keeps cards side by side from all saying the same thing', () => {
    const board = ['durable_a1', 'durable_b2', 'durable_c3', 'durable_d4'].map((id) => pickGreeting(id, 'x', 19));
    expect(new Set(board).size).toBeGreaterThan(1);
  });

  it('hashes ids stably to unsigned 32-bit values', () => {
    expect(hashId('abc')).toBe(hashId('abc'));
    expect(hashId('abc')).not.toBe(hashId('abd'));
    expect(hashId('')).toBe(0x811c9dc5);
    expect(hashId('durable_x')).toBeGreaterThanOrEqual(0);
  });
});
