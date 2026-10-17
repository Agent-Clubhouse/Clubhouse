import { describe, it, expect, beforeEach } from 'vitest';
import { greetingPool, pickGreeting, resetGreetingMemory, timeOfDay } from './greetings';

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
    expect(pool).toHaveLength(6);
    expect(pool).toContain('Early bird gets the worm.');
    expect(pool).toContain('Got something for Clubhouse-PM?');
    expect(pool).toContain('Clubhouse-PM is rested and ready.');
  });

  it('uses only the any-time set in the evening', () => {
    expect(greetingPool('a', 19)).toEqual(['Where should we pick up?', 'Got something for a?', 'a is rested and ready.']);
  });

  it('covers all twelve lines across the day', () => {
    const all = new Set([...greetingPool('x', 8), ...greetingPool('x', 14), ...greetingPool('x', 23)]);
    expect(all.size).toBe(12);
  });
});

describe('pickGreeting', () => {
  beforeEach(() => resetGreetingMemory());

  it('never repeats the previous line', () => {
    let prev = '';
    for (let i = 0; i < 50; i++) {
      // Always ask for the first choice; it must still move on.
      const line = pickGreeting('x', 14, () => 0);
      expect(line).not.toBe(prev);
      prev = line;
    }
  });

  it('picks from the pool', () => {
    const pool = greetingPool('x', 23);
    expect(pool).toContain(pickGreeting('x', 23, () => 0.99));
  });
});
