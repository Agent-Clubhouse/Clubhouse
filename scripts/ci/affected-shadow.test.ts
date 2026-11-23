import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { assertionShape, buildGraph, consumers, decide, parseModule, pureFormatter, report } from './affected-shadow.mjs';

const leaf = 'src/renderer/utils/format.ts';
const suite = 'src/renderer/utils/format.test.ts';
// AST/source inputs are the selector's public contract; reading them is the behavior under test.
// eslint-disable-next-line no-restricted-syntax
const source = fs.readFileSync(path.resolve(leaf), 'utf8');
// eslint-disable-next-line no-restricted-syntax -- selector consumes test ASTs, not runtime exports
const testSource = fs.readFileSync(path.resolve(suite), 'utf8');
const sentinels = ['src/main/services/dispatcher/dispatcher-copy.test.ts', 'src/main/ipc/index.integration.test.ts', 'src/main/util/windows-pty.test.ts', 'src/main/services/pty-manager.test.ts', 'src/main/services/file-watch-service.test.ts', 'src/main/services/auto-update-apply.test.ts', 'src/main/services/auto-update-apply-windows.test.ts'];
function fixture() {
  return new Map([[leaf, source], [suite, testSource],
    ['src/renderer/view.ts', "export { formatDuration } from './utils/format'"],
    ['src/renderer/view.test.ts', "import './view'"],
    ['src/main/pure.test.ts', "import { expect } from 'vitest'; expect(1).toBe(1)"],
    ['src/shared/contract.test.ts', ''], ['src/preload/bridge.test.ts', ''], ['test/integration.test.ts', ''],
    ['src/main/scanner.test.ts', "import fs from 'node:fs'; fs.readFileSync('src/renderer/utils/format.ts')"],
    ...sentinels.map((name) => [name, ''] as [string, string])]);
}
function mutate(name: string, text: string, changed = [name]) {
  const base = fixture(), head = new Map(base); head.set(name, text);
  return decide(base, head, changed);
}

describe('report-only selector contract', () => {
  it('admits semantic arithmetic changes and retains projects, transitive UI, scanners and OS/IPC sentinels on both platforms', () => {
    for (const replacement of ['Math.floor(ms / 1000)', 'Math.round(ms / 900)', 'Math.round(ms / 1000) + 1']) {
      const result = mutate(leaf, source.replace('Math.round(ms / 1000)', replacement));
      expect(result.mode).toBe('selected');
      expect(result.reportOnly).toBe(true);
      expect(result.platforms).toEqual(['linux', 'windows']);
      expect(result.tests).toEqual(expect.arrayContaining([suite, 'src/renderer/view.test.ts', 'src/main/scanner.test.ts', 'src/shared/contract.test.ts', 'src/preload/bridge.test.ts', 'test/integration.test.ts', ...sentinels]));
      expect(result.tests).not.toContain('src/main/pure.test.ts');
      expect(result.invariants.length).toBeGreaterThan(3);
    }
  });
  it('direct formatter behavior detects synthetic rounding, minute, hour and display mutants', () => {
    const mutants: [string, number, string][] = [
      [source.replace('Math.round(ms / 1000)', 'Math.floor(ms / 1000)'), 500, '1s'],
      [source.replace('totalSeconds < 60', 'totalSeconds < 61'), 60_000, '1m'],
      [source.replace('minutes < 60', 'minutes < 61'), 3_600_000, '1h'],
      [source.replace('`${totalSeconds}s`', '`${totalSeconds}sec`'), 5000, '5s'],
    ];
    for (const [mutant, input, correct] of mutants) {
      expect(pureFormatter(mutant)).toBe(true);
      const context = { exports: {} as { formatDuration: (ms: number) => string } };
      const js = ts.transpileModule(mutant, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
      vm.runInNewContext(js, context, { timeout: 1000 });
      expect(context.exports.formatDuration(input)).not.toBe(correct);
      expect(mutate(leaf, mutant).tests).toContain(suite);
      expect(mutate(leaf, mutant).tests).toContain('src/renderer/view.test.ts');
    }
  });
  it('admits only literal assertion edits for exact declared test suites', () => {
    expect(mutate(suite, testSource.replace("toBe('0s')", "toBe('changed')")).mode).toBe('selected');
    for (const [old, next] of [['it(', 'it.skip('], ['describe(', 'describe.only('], ["from './format'", "from '@/format'"], ['formatDuration(0)', 'process.exit(0)']]) {
      expect(mutate(suite, testSource.replace(old, next)).mode).toBe('full');
    }
    expect(mutate(suite, testSource + '\nglobalThis.x = 1;').mode).toBe('full');
    expect(assertionShape(suite, testSource)).not.toBeNull();
  });
  it.each([
    "import './side-effect';", "export * from './other';", "void import('./other');", "require(variable);", 'process.platform;', 'globalThis.x = 1;',
    'Math.round = () => 0;', 'const r = Math.random();', 'const r = Date.now();', 'while(true) {}', 'const r = new URL("file:///x");',
  ])('fans out capabilities and effects: %s', (extra) => {
    expect(pureFormatter(source + '\n' + extra)).toBe(false);
    expect(mutate(leaf, source + '\n' + extra).mode).toBe('full');
  });
  it('rejects mutation inside function, export signature drift and aliased capability access', () => {
    for (const expression of ['Math.random()', 'process.env.X', 'globalThis["x"]', 'Math["round"](ms)', '(() => 1)()', 'eval("1")']) {
      expect(pureFormatter(source.replace('Math.round(ms / 1000)', expression))).toBe(false);
    }
    expect(pureFormatter(source.replace('ms: number', 'ms: number = Date.now()'))).toBe(false);
    expect(pureFormatter(source.replace('export function', 'export async function'))).toBe(false);
    expect(pureFormatter(source.replace('export function', 'export function*'))).toBe(false);
    expect(pureFormatter(source.replace('ms: number', 'ms?: number'))).toBe(false);
  });
  it.each(['package.json', 'vitest.config.ts', 'test/setup-renderer.ts', 'src/shared/types.ts', 'src/preload/index.ts', 'test/__fixtures__/x.json', 'src/main/native.node', 'src/renderer/utils/other.ts', 'src/renderer/utils/Format.ts'])('unknown/config/shared/fixture/native/case paths fan out: %s', (name) => {
    expect(mutate(name, '').mode).toBe('full');
  });
  it('fans out additions, deletions, missing sentinels, and cross-feature consumers', () => {
    const base = fixture(), head = new Map(base); head.delete(leaf);
    expect(decide(base, head, [leaf]).mode).toBe('full');
    expect(decide(head, base, [leaf]).mode).toBe('full');
    const missing = new Map(base); missing.delete(sentinels[0]);
    expect(decide(missing, missing, [leaf]).mode).toBe('full');
    base.set('src/main/cross.ts', "export * from '../renderer/utils/format'");
    expect(decide(base, base, [leaf]).mode).toBe('full');
    base.set('src/renderer/test-consumer.ts', "import './utils/format.test'");
    expect(decide(base, base, [suite]).mode).toBe('full');
  });
  it('parses exports, static/type imports, unresolved paths, dynamic and mock boundaries', () => {
    const files = new Map([['leaf.ts', ''], ['barrel.ts', "export * from './leaf'"], ['consumer.test.ts', "import type { X } from './barrel'"]]);
    expect(consumers(buildGraph(files), 'leaf.ts')).toEqual(['barrel.ts', 'consumer.test.ts']);
    expect(buildGraph(new Map([['x.ts', "import './missing'"]])).modules.get('x.ts')?.hazards).toContain('unresolved:./missing');
    for (const text of ["import(name)", "vi.mock('./leaf')", "require('./leaf')", "import.meta.glob('./*.ts')"]) expect(parseModule('x.ts', text).hazards.length).toBeGreaterThan(0);
    expect(parseModule('x.ts', "import { a } from './leaf'").declarations).not.toEqual(parseModule('x.ts', "import { b } from './leaf'").declarations);
  });
  it('uses immutable Git objects even with dirty checkout; refuses unknown history/untracked working trees', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-shadow-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    try {
      git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test');
      for (const [name, text] of fixture()) { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), text); }
      git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
      fs.writeFileSync(path.join(repo, suite), testSource.replace("toBe('0s')", "toBe('1s')"));
      git('add', '.'); git('commit', '-qm', 'assertion'); const head = git('rev-parse', 'HEAD');
      fs.writeFileSync(path.join(repo, suite), "import './unknown';");
      const historical = report({ repo, base, head });
      expect(historical.mode).toBe('selected'); expect(historical.base).toBe(base); expect(historical.head).toBe(head);
      expect(report({ repo, base, head: 'WORKTREE' }).mode).toBe('full');
      fs.writeFileSync(path.join(repo, 'untracked.txt'), 'unknown');
      expect(report({ repo, base, head: 'WORKTREE' }).reasons.join()).toContain('untracked');
      const unknown = report({ repo, base: 'missing-history', head });
      expect(unknown.mode).toBe('full'); expect(unknown.fullSuiteRequired).toBe(true);
      expect(unknown.reasons.join()).toContain('input-uncertain');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });
});
