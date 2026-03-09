/**
 * Validates that eslint.config.mjs ignores generated output directories,
 * including those inside agent worktrees (.clubhouse/agents/**).
 *
 * Regression test for GitHub Issue #656 — lint baseline was too noisy because
 * agent worktree .webpack output (~214k issues) was not excluded.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function extractIgnores(source: string): string[] {
  const match = source.match(/ignores:\s*\[([\s\S]*?)\]/);
  if (!match) return [];
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('eslint ignores configuration', () => {
  const configPath = path.resolve(__dirname, '../../eslint.config.mjs');
  const source = fs.readFileSync(configPath, 'utf-8');
  const ignores = extractIgnores(source);

  it('excludes root-level generated directories', () => {
    expect(ignores).toContain('.webpack/**');
    expect(ignores).toContain('out/**');
    expect(ignores).toContain('dist/**');
    expect(ignores).toContain('node_modules/**');
  });

  it('excludes agent worktree generated directories', () => {
    expect(ignores).toContain('.clubhouse/agents/**/.webpack/**');
    expect(ignores).toContain('.clubhouse/agents/**/out/**');
    expect(ignores).toContain('.clubhouse/agents/**/dist/**');
    expect(ignores).toContain('.clubhouse/agents/**/node_modules/**');
  });
});
