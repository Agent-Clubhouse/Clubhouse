import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'path';
import { CHAT_SHARDS, chatShardProblems, chatShardTestMatch } from '../e2e/chat-shards.mjs';

const E2E_DIR = path.resolve(__dirname, '..', 'e2e');

describe('Chat E2E shard lists', () => {
  it('put every chat spec on disk in exactly one shard', () => {
    const specs = readdirSync(path.join(E2E_DIR, 'chat-rich'))
      .filter((name) => name.endsWith('.spec.ts'))
      .map((name) => `chat-rich/${name}`);
    expect(specs.length).toBeGreaterThan(0);
    expect(chatShardProblems([...specs, 'actions.spec.ts', 'dispatcher.spec.ts', 'dispatcher-card.spec.ts', 'dispatcher-setup.spec.ts', 'managed-agents.spec.ts', 'managed-agents-acceptance.spec.ts'])).toEqual([]);
  });

  it('match the shards the e2e-chat job runs, so no list goes unrun', () => {
    const workflow = readFileSync(path.resolve(E2E_DIR, '..', '.github', 'workflows', 'validate.yml'), 'utf8');
    const job = workflow.slice(workflow.indexOf('\n  e2e-chat:'));
    const matrix = /\n\s+shard: \[([^\]]*)\]/.exec(job)?.[1];
    expect(matrix?.split(',').map((s) => s.trim())).toEqual(Object.keys(CHAT_SHARDS));
  });

  it('report a spec in no shard, in two shards, or gone from disk', () => {
    const shards = { 1: ['a.spec.ts', 'b.spec.ts'], 2: ['b.spec.ts', 'gone.spec.ts'] };
    expect(chatShardProblems(['a.spec.ts', 'b.spec.ts', 'new.spec.ts'], shards)).toEqual([
      'b.spec.ts is in 2 shards',
      'new.spec.ts is in no shard',
      "gone.spec.ts is listed but doesn't exist",
    ]);
  });

  it('report an empty shard', () => {
    expect(chatShardProblems(['a.spec.ts'], { 1: ['a.spec.ts'], 2: [] })).toEqual(['shard 2 is empty']);
  });

  it('turn a shard into globs, and refuse one that does not exist or is empty', () => {
    expect(chatShardTestMatch('1', { 1: ['a.spec.ts'] })).toEqual(['**/a.spec.ts']);
    expect(() => chatShardTestMatch('4', { 1: ['a.spec.ts'] })).toThrow(/has shards 1/);
    expect(() => chatShardTestMatch('2', { 1: ['a.spec.ts'], 2: [] })).toThrow(/has no specs/);
  });
});
