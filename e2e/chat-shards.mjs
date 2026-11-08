/**
 * Which Chat E2E shard runs each spec. Assigned by hand from measured times, to
 * keep every shard within its budget (docs/testing/chat-e2e-plan.md, "Shard-time
 * budget"). A new spec goes in the list with the most room.
 * test/chat-e2e-shards.test.ts fails if one is missing.
 *
 * Plain .mjs with no Playwright imports, so the config and that test can both load it.
 */
export const CHAT_SHARDS = {
  1: [
    'chat-rich/annex.spec.ts',
    'chat-rich/file-chips.spec.ts',
    'chat-rich/flag-off.spec.ts',
    'chat-rich/context-menu.spec.ts',
    'chat-rich/link-tokens.spec.ts',
    'chat-rich/question-dock.spec.ts',
  ],
  2: [
    'actions.spec.ts',
    'chat-rich/media-cards.spec.ts',
    'chat-rich/media-images.spec.ts',
    'chat-rich/providers.spec.ts',
    'managed-agents.spec.ts',
  ],
  3: [
    'chat-rich/queue-merging.spec.ts',
    'chat-rich/reading.spec.ts',
    'dispatcher.spec.ts',
    'managed-agents-acceptance.spec.ts',
  ],
};

/** The specs a shard runs, as `testMatch` globs. An unknown or empty shard throws, rather than running everything or nothing.
 * @param {Record<string, string[]>} [shards]
 */
export function chatShardTestMatch(shard, shards = CHAT_SHARDS) {
  const specs = shards[shard];
  if (!specs) throw new Error(`PLAYWRIGHT_CHAT_SHARD is ${shard}, and e2e/chat-shards.mjs has shards ${Object.keys(shards).join(', ')}`);
  if (specs.length === 0) throw new Error(`Chat shard ${shard} in e2e/chat-shards.mjs has no specs`);
  return specs.map((spec) => `**/${spec}`);
}

/** What's wrong with the lists, given the chat specs on disk. Empty when each is in exactly one list.
 * @param {Record<string, string[]>} [shards]
 */
export function chatShardProblems(specsOnDisk, shards = CHAT_SHARDS) {
  const listed = Object.values(shards).flat();
  const problems = [];
  for (const [shard, specs] of Object.entries(shards)) {
    if (specs.length === 0) problems.push(`shard ${shard} is empty`);
  }
  for (const spec of specsOnDisk) {
    const count = listed.filter((s) => s === spec).length;
    if (count === 0) problems.push(`${spec} is in no shard`);
    if (count > 1) problems.push(`${spec} is in ${count} shards`);
  }
  for (const spec of new Set(listed)) {
    if (!specsOnDisk.includes(spec)) problems.push(`${spec} is listed but doesn't exist`);
  }
  return problems;
}
