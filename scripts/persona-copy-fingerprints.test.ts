/**
 * scripts/persona-copy-fingerprints.mjs (#3579): the committed table of every
 * shipped persona version's fingerprint is what the script builds from git
 * history. A shallow clone (CI) has no history, so there only the table's
 * format is checked.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import table from '../src/main/services/managed-agents/persona-copy-fingerprints.json';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'persona-copy-fingerprints.mjs');
const shallow = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: ROOT, encoding: 'utf8' }).trim() !== 'false';
  } catch {
    return true;
  }
})();

describe('persona copy fingerprints', () => {
  it('has the format persona-copies.ts reads', () => {
    expect(table.$comment).toContain('scripts/persona-copy-fingerprints.mjs');
    const personas = Object.entries(table.personas);
    expect(personas.length).toBeGreaterThanOrEqual(12);
    for (const [id, entry] of personas) {
      expect(id).toMatch(/^[a-z-]+$/);
      expect(entry.name).toBeTruthy();
      expect(entry.versions.length).toBeGreaterThan(0);
      for (const v of entry.versions) {
        expect(v.first).toMatch(/^# /);
        expect(v.length).toBeGreaterThan(v.first.length);
        expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it.skipIf(shallow)('matches what the script builds from git history', () => {
    // Exits 1, with the command to run, when the committed table is out of date.
    expect(() => execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })).not.toThrow();
  }, 60_000);
});
