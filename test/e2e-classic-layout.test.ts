import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import * as path from 'path';
import { classicRunSeedOver } from '../e2e/layout';
import { CLASSIC_ONLY_SPECS, CLASSIC_SHARDS, CLASSIC_RUN_SPECS, LAYOUT_SWITCH_SPECS, classicTestMatch } from '../e2e/classic-specs.mjs';

const E2E_DIR = path.resolve(__dirname, '..', 'e2e');
const PIN = /newChrome:\s*false/;

/** Every .ts file under e2e/, as a path relative to it with forward slashes. */
function e2eSources(dir = E2E_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : e2eSources(full);
    return entry.name.endsWith('.ts') ? [path.relative(E2E_DIR, full).split(path.sep).join('/')] : [];
  });
}

describe('E2E classic layout lists (#2843)', () => {
  const sources = e2eSources();

  it('allow only the classic-only specs and the layout switch spec to pin the classic layout', () => {
    // e2e/layout.ts is what seeds classic for the classic run.
    const pinning = sources
      .filter((file) => file !== 'layout.ts' && PIN.test(readFileSync(path.join(E2E_DIR, file), 'utf8')))
      .sort();
    expect(pinning).toEqual([...CLASSIC_ONLY_SPECS, ...LAYOUT_SWITCH_SPECS].sort());
  });

  it('list only files that exist, each once', () => {
    const listed = [...CLASSIC_RUN_SPECS, ...LAYOUT_SWITCH_SPECS];
    for (const spec of CLASSIC_ONLY_SPECS) expect(CLASSIC_RUN_SPECS, `${spec} runs in the Classic layout job`).toContain(spec);
    for (const file of listed) expect(existsSync(path.join(E2E_DIR, file)), file).toBe(true);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('run on classic, besides the classic-only specs, only specs that leave the layout to the run', () => {
    for (const spec of CLASSIC_RUN_SPECS) {
      expect(spec.endsWith('.spec.ts'), spec).toBe(true);
      if (CLASSIC_ONLY_SPECS.includes(spec)) continue;
      expect(PIN.test(readFileSync(path.join(E2E_DIR, spec), 'utf8')), spec).toBe(false);
    }
  });

  it('keep the classic-only specs out of every other run', () => {
    const config = readFileSync(path.resolve(E2E_DIR, '..', 'playwright.config.ts'), 'utf8');
    expect(config).toMatch(/classicRun \? \[\] : CLASSIC_ONLY_SPECS\.map/);
  });

  it('match the job that runs them on classic', () => {
    const workflow = readFileSync(path.resolve(E2E_DIR, '..', '.github', 'workflows', 'validate.yml'), 'utf8');
    const start = workflow.indexOf('\n  e2e-classic:');
    expect(start).toBeGreaterThan(-1);
    const job = workflow.slice(start, workflow.indexOf('\n  # ', start + 1));
    expect(job).toMatch(/CLUBHOUSE_E2E_LAYOUT: classic/);
    expect(job).toMatch(/PLAYWRIGHT_CLASSIC_SHARD: \$\{\{ matrix\.shard \}\}/);
    const matrix = /\n\s+shard: \[([^\]]*)\]/.exec(job)?.[1];
    expect(matrix?.split(',').map((x) => x.trim())).toEqual(Object.keys(CLASSIC_SHARDS));
  });

  it('put each classic spec in exactly one shard, with no shard empty', () => {
    for (const [shard, specs] of Object.entries(CLASSIC_SHARDS)) expect(specs.length, `shard ${shard}`).toBeGreaterThan(0);
    expect(new Set(CLASSIC_RUN_SPECS).size).toBe(CLASSIC_RUN_SPECS.length);
  });

  it('turn a shard into globs, and refuse one that does not exist or is empty', () => {
    expect(classicTestMatch('1', { 1: ['a.spec.ts'] })).toEqual(['**/a.spec.ts']);
    expect(() => classicTestMatch('2', { 1: ['a.spec.ts'] })).toThrow(/has shards 1/);
    expect(() => classicTestMatch('1', { 1: [] })).toThrow(/no specs/);
  });

  it('seed classic over a reused profile by merging, and leave an unreadable or chosen file alone', () => {
    expect(classicRunSeedOver(undefined)).toEqual({ newChrome: false });
    expect(classicRunSeedOver('{"telemetry": true}')).toEqual({ telemetry: true, newChrome: false });
    expect(classicRunSeedOver('{"telemetry": tru')).toBeUndefined();
    expect(classicRunSeedOver('[]')).toBeUndefined();
    expect(classicRunSeedOver('{"newChrome": true}')).toBeUndefined();
  });
});
