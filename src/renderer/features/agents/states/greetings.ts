/**
 * Greeting lines for a sleeping agent (#2019), shown on its canvas card and
 * sleeping pane. Each agent gets a line from the time-of-day set plus the
 * any-time set, picked by a hash of its id (#2102): the same agent keeps the
 * same line across renders, and agents side by side mostly differ.
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
  "What's next for {name}?",
  '{name} is ready and waiting.',
  '{name} is standing by.',
  'What should {name} take on?',
  'Give {name} something to do.',
  'Ready when you are.',
  'Wake {name} with a new task.',
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

/** FNV-1a, 32-bit: a cheap, stable spread of agent ids over the lines. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The line for this agent at this hour. Stable for an agent; it only changes
 * when the time of day changes the pool.
 */
export function pickGreeting(agentId: string, name: string, hour: number): string {
  const pool = greetingPool(name, hour);
  return pool[hashId(agentId) % pool.length];
}
