import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import * as path from 'path';
import { CLASSIC_RUN_SPECS, LAYOUT_SWITCH_SPECS, PINNED_CLASSIC_SPECS, classicTestMatch } from '../e2e/classic-specs.mjs';

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

  it('allow only the listed files to pin the classic layout', () => {
    // e2e/layout.ts is what seeds classic for the classic run.
    const pinning = sources
      .filter((file) => file !== 'layout.ts' && PIN.test(readFileSync(path.join(E2E_DIR, file), 'utf8')))
      .sort();
    expect(pinning).toEqual([...PINNED_CLASSIC_SPECS, ...LAYOUT_SWITCH_SPECS].sort());
  });

  it('list only files that exist, each once', () => {
    const listed = [...CLASSIC_RUN_SPECS, ...PINNED_CLASSIC_SPECS, ...LAYOUT_SWITCH_SPECS];
    for (const file of listed) expect(existsSync(path.join(E2E_DIR, file)), file).toBe(true);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('run on classic only specs that leave the layout to the run', () => {
    for (const spec of CLASSIC_RUN_SPECS) {
      expect(spec.endsWith('.spec.ts'), spec).toBe(true);
      expect(PIN.test(readFileSync(path.join(E2E_DIR, spec), 'utf8')), spec).toBe(false);
    }
  });

  it('match the job that runs them on classic', () => {
    const workflow = readFileSync(path.resolve(E2E_DIR, '..', '.github', 'workflows', 'validate.yml'), 'utf8');
    const start = workflow.indexOf('\n  e2e-classic:');
    expect(start).toBeGreaterThan(-1);
    const job = workflow.slice(start, workflow.indexOf('\n  # ', start + 1));
    expect(job).toMatch(/CLUBHOUSE_E2E_LAYOUT: classic/);
    expect(job).toMatch(/npx playwright test --shard=\$\{\{ matrix\.shard \}\}\/2 --reporter/);
    expect(job).toMatch(/shard: \[1, 2\]/);
  });

  it('turn the list into globs, and refuse an empty one', () => {
    expect(classicTestMatch(['a.spec.ts'])).toEqual(['**/a.spec.ts']);
    expect(() => classicTestMatch([])).toThrow(/no specs/);
  });
});
