/**
 * Greeting lines for a sleeping agent (#2019). One is picked per visit from the
 * time-of-day set plus the any-time set, never the same line twice in a row.
 */

export type TimeOfDay = 'morning' | 'afternoon' | 'night' | 'evening';

const TIME_OF_DAY_LINES: Record<Exclude<TimeOfDay, 'evening'>, string[]> = {
  morning: [
    'Early bird gets the worm.',
    'Morning. What are we building today?',
    'Fresh coffee, fresh branch. Where do we start?',
  ],
  afternoon: [
    'What are we going to build?',
    "Afternoon. What's next on the list?",
    'Plenty of day left. What should we tackle?',
  ],
  night: [
    'Ready to burn the midnight oil?',
    'Late one tonight. What are we building?',
    'Quiet hours are good for shipping.',
  ],
};

/** Any time, and the only set in the evening. `{name}` is the agent's name. */
const ANY_TIME_LINES = [
  'Where should we pick up?',
  'Got something for {name}?',
  '{name} is rested and ready.',
];

/** Morning 5 to 11, afternoon 12 to 17, evening 18 to 21, late night 22 to 4. */
export function timeOfDay(hour: number): TimeOfDay {
  if (hour >= 5 && hour <= 11) return 'morning';
  if (hour >= 12 && hour <= 17) return 'afternoon';
  if (hour >= 18 && hour <= 21) return 'evening';
  return 'night';
}

/** Every line that may show at this hour, with the agent's name filled in. */
export function greetingPool(name: string, hour: number): string[] {
  const tod = timeOfDay(hour);
  const lines = tod === 'evening' ? [] : TIME_OF_DAY_LINES[tod];
  return [...lines, ...ANY_TIME_LINES].map((l) => l.replace('{name}', name));
}

let lastGreeting: string | null = null;

/**
 * Pick a line for this visit. Avoids the line shown last time (across agents,
 * for the life of the window). `random` is injectable for tests.
 */
export function pickGreeting(name: string, hour: number, random: () => number = Math.random): string {
  const pool = greetingPool(name, hour);
  const choices = pool.length > 1 ? pool.filter((l) => l !== lastGreeting) : pool;
  const line = choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
  lastGreeting = line;
  return line;
}

/** @internal for tests */
export function resetGreetingMemory(): void {
  lastGreeting = null;
}
