import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'path';
import { chatShardProblems } from '../e2e/chat-shards.mjs';
import { ANNEX_SHARD_ENV, ANNEX_SHARDS, E2E_SHARD_ENV, E2E_SHARDS, listShardTestMatch } from '../e2e/e2e-shards.mjs';

const E2E_DIR = path.resolve(__dirname, '..', 'e2e');
const WORKFLOW = readFileSync(path.resolve(E2E_DIR, '..', '.github', 'workflows', 'validate.yml'), 'utf8');

/** Every spec under e2e/, as a path relative to it with forward slashes. */
function specsOnDisk(dir = E2E_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : specsOnDisk(full);
    return entry.name.endsWith('.spec.ts') ? [path.relative(E2E_DIR, full).split(path.sep).join('/')] : [];
  });
}

/** The config's testIgnore globs are `**\/name` or `**\/dir/**`. */
function ignoredBy(spec: string, glob: string): boolean {
  const rest = glob.replace(/^\*\*\//, '');
  if (rest.endsWith('/**')) return `/${spec}`.includes(`/${rest.slice(0, -3)}/`);
  return spec === rest || spec.endsWith(`/${rest}`);
}

async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  try {
    return (await import('../playwright.config')).default as { testIgnore?: string[]; testMatch?: string[] };
  } finally {
    vi.unstubAllEnvs();
  }
}

/** The job's block in validate.yml, up to the next job's comment. */
function workflowJob(id: string): string {
  const start = WORKFLOW.indexOf(`\n  ${id}:`);
  expect(start, id).toBeGreaterThan(-1);
  const next = WORKFLOW.indexOf('\n  # ', start + 1);
  return WORKFLOW.slice(start, next === -1 ? undefined : next);
}

const E2E_JOB_ENV = { PLAYWRIGHT_IGNORE_ANNEX: '1', PLAYWRIGHT_IGNORE_CHAT_RICH: '1', CLUBHOUSE_E2E_LAYOUT: undefined, PLAYWRIGHT_CHAT_SHARD: undefined };

describe('E2E and Annex E2E shard lists (#2843)', () => {
  it('put every spec the sharded E2E job runs in exactly one shard', async () => {
    const config = await loadConfig({ ...E2E_JOB_ENV, [E2E_SHARD_ENV]: undefined, [ANNEX_SHARD_ENV]: undefined });
    const ignore = config.testIgnore ?? [];
    const runs = specsOnDisk().filter((spec) => !ignore.some((glob) => ignoredBy(spec, glob)));
    expect(runs.length).toBeGreaterThan(10);
    expect(chatShardProblems(runs, E2E_SHARDS)).toEqual([]);
  });

  it('put every Annex spec in exactly one shard', () => {
    const annex = specsOnDisk().filter((spec) => spec.startsWith('annex-v2/'));
    expect(annex.length).toBeGreaterThan(0);
    expect(chatShardProblems(annex, ANNEX_SHARDS)).toEqual([]);
  });

  it('run one list per shard in each job, and every list', () => {
    for (const [id, env, shards] of [['e2e', E2E_SHARD_ENV, E2E_SHARDS], ['e2e-annex', ANNEX_SHARD_ENV, ANNEX_SHARDS]] as const) {
      const job = workflowJob(id);
      expect(job, id).toContain(`${env}: \${{ matrix.shard }}`);
      expect(job, id).not.toMatch(/--shard/);
      const matrix = /\n\s+shard: \[([^\]]*)\]/.exec(job)?.[1];
      expect(matrix?.split(',').map((x) => x.trim()), id).toEqual(Object.keys(shards));
    }
  });

  it('turn the job\'s shard into its list in the config', async () => {
    const e2e = await loadConfig({ ...E2E_JOB_ENV, [E2E_SHARD_ENV]: '2', [ANNEX_SHARD_ENV]: undefined });
    expect(e2e.testMatch).toEqual(E2E_SHARDS[2].map((spec) => `**/${spec}`));
    const annex = await loadConfig({ ...E2E_JOB_ENV, PLAYWRIGHT_IGNORE_ANNEX: undefined, PLAYWRIGHT_IGNORE_CHAT_RICH: undefined, [E2E_SHARD_ENV]: undefined, [ANNEX_SHARD_ENV]: '1' });
    expect(annex.testMatch).toEqual(ANNEX_SHARDS[1].map((spec) => `**/${spec}`));
    expect(annex.testIgnore ?? []).not.toContain('**/annex-v2/**');
  });

  it('turn a shard into globs, and refuse one that does not exist or is empty', () => {
    expect(listShardTestMatch('X', '1', { 1: ['a.spec.ts'] })).toEqual(['**/a.spec.ts']);
    expect(() => listShardTestMatch('X', '3', { 1: ['a.spec.ts'] })).toThrow(/X is 3, and e2e\/e2e-shards.mjs has shards 1/);
    expect(() => listShardTestMatch('X', '2', { 1: ['a.spec.ts'], 2: [] })).toThrow(/has no specs/);
  });

  it('read the testIgnore globs the way the config writes them', () => {
    expect(ignoredBy('annex-v2/lifecycle.spec.ts', '**/annex-v2/**')).toBe(true);
    expect(ignoredBy('chat-rich/reading.spec.ts', '**/annex-v2/**')).toBe(false);
    expect(ignoredBy('dispatcher.spec.ts', '**/dispatcher.spec.ts')).toBe(true);
    expect(ignoredBy('dispatcher-card.spec.ts', '**/dispatcher.spec.ts')).toBe(false);
  });
});
