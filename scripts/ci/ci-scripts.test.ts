import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classify, changedLinesByFile } from './classify-changes.mjs';
import {
  collectFailures,
  decide,
  issueBody,
  ISSUE_LABELS,
  ISSUE_TITLE,
  parseJunitFailures,
  previousFailureIds,
} from './nightly-report.mjs';

const CLASSIFY = path.join(__dirname, 'classify-changes.mjs');

/** A minimal `git diff -U0` for the given files and changed lines. */
function diff(files: Record<string, string[]>): string {
  return Object.entries(files).map(([file, lines]) => [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    ...lines,
  ].join('\n')).join('\n') + '\n';
}

const run = (d: string) => classify([...changedLinesByFile(d).keys()], changedLinesByFile(d));

describe('classify-changes', () => {
  it('docs-only changes need nothing', () => {
    expect(run(diff({ 'docs/ci.md': ['+x'], 'README.md': ['+y'], 'notes/a.md': ['+z'] })))
      .toEqual({ docsOnly: true, e2e: false, macos: false });
  });

  it('markdown inside src is app content, not docs', () => {
    expect(run(diff({ 'src/renderer/help/intro.md': ['+x'] }))).toMatchObject({ docsOnly: false, e2e: true });
  });

  it('a unit-test-only change skips the E2E build', () => {
    expect(run(diff({ 'src/main/a.test.ts': ['+x'], 'src/main/__fixtures__/f.json': ['+{}'] })))
      .toEqual({ docsOnly: false, e2e: false, macos: false });
  });

  it('an ordinary source change gets E2E but not macOS', () => {
    expect(run(diff({ 'src/main/services/agent-config.ts': ['+const a = 1;'] })))
      .toEqual({ docsOnly: false, e2e: true, macos: false });
  });

  it('macOS by path: packaging, auto-update, keychain, CI', () => {
    for (const file of ['forge.config.ts', 'entitlements.plist', 'src/main/services/auto-update-apply.test.ts', 'src/main/telemetry/secret-store.ts', '.github/workflows/validate.yml']) {
      expect(run(diff({ [file]: ['+x'] }))).toMatchObject({ macos: true, macosReason: `path ${file}` });
    }
  });

  it('macOS by changed lines that touch darwin behaviour in source', () => {
    expect(run(diff({ 'src/renderer/chrome/ChromeTitleBar.tsx': ["+  if (platform === 'darwin') return <TrafficLights />;"] })))
      .toMatchObject({ macos: true, macosReason: 'macOS-specific lines changed in src/renderer/chrome/ChromeTitleBar.tsx' });
  });

  it('an edit to a file with a darwin branch elsewhere is not macOS-specific', () => {
    expect(run(diff({ 'src/main/index.ts': ['+registerChatDrivers();'] }))).toMatchObject({ macos: false });
  });

  it('darwin in a test (a platform mock) is not macOS-specific', () => {
    expect(run(diff({ 'src/main/a.test.ts': ["+Object.defineProperty(process, 'platform', { value: 'darwin' });"] })))
      .toMatchObject({ macos: false });
  });

  it('dependency changes count only for Electron, native modules and forge', () => {
    expect(run(diff({ 'package-lock.json': ['+    "node_modules/electron": {', '+      "version": "43.7.9"'] }))).toMatchObject({ macos: true });
    expect(run(diff({ 'package-lock.json': ['-      "resolved": "https://registry.npmjs.org/electron/-/electron-43.6.0.tgz",', '+      "resolved": "https://registry.npmjs.org/electron/-/electron-43.7.9.tgz",'] })))
      .toMatchObject({ macos: true });
    expect(run(diff({ 'package.json': ['+    "@electron-forge/cli": "^7.12.0",'] }))).toMatchObject({ macos: true });
    expect(run(diff({ 'package-lock.json': ['+    "node_modules/marked": {'] }))).toMatchObject({ macos: false });
  });

  it('with no file list it runs everything', () => {
    expect(classify([])).toMatchObject({ e2e: true, macos: true });
  });

  it('parses changed lines per file from git diff -U0', () => {
    const lines = changedLinesByFile(diff({ 'a.ts': ['+added', '-removed', ' context'], 'b.ts': ['+b'] }));
    expect([...lines.entries()]).toEqual([['a.ts', ['added', 'removed']], ['b.ts', ['b']]]);
  });

  it('the CLI reads a diff on stdin and writes GITHUB_OUTPUT', async () => {
    const out = path.join(os.tmpdir(), `classify-${process.pid}.txt`);
    try {
      const result = spawnSync(process.execPath, [CLASSIFY], {
        input: diff({ 'src/main/services/auto-update-service.ts': ['+x'] }),
        env: { ...process.env, GITHUB_OUTPUT: out },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(await fs.promises.readFile(out, 'utf8')).toBe(
        'docs_only=false\ne2e=true\nmacos=true\nmacos_reason=path src/main/services/auto-update-service.ts\n',
      );
    } finally {
      fs.rmSync(out, { force: true });
    }
  });
});

const VITEST_JUNIT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" failures="1" errors="0">
  <testsuite name="src/main/services/auto-update-apply.test.ts" tests="3" failures="1">
    <testcase classname="src/main/services/auto-update-apply.test.ts" name="applies an update &gt; on darwin" time="0.01">
      <failure message="expected &apos;a&apos; to be &apos;b&apos;" type="AssertionError">AssertionError: expected 'a' to be 'b'
    at stack</failure>
    </testcase>
    <testcase classname="src/main/services/auto-update-apply.test.ts" name="passes" time="0.01"></testcase>
    <testcase classname="src/main/services/auto-update-apply.test.ts" name="also passes" time="0.01"/>
  </testsuite>
</testsuites>`;

const PLAYWRIGHT_JUNIT = `<testsuites id="" name="" tests="2" failures="1">
<testsuite name="app-launch.spec.ts" tests="2">
<testcase name="app launches › shows the title bar" classname="app-launch.spec.ts" time="3.2">
<failure message="app-launch.spec.ts:12:3 shows the title bar" type="FAILURE">
<![CDATA[Error: locator not found]]>
</failure>
</testcase>
<testcase name="app launches › opens settings" classname="app-launch.spec.ts" time="1.0">
</testcase>
</testsuite>
</testsuites>`;

describe('nightly-report', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-report-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('parses failing cases from vitest and Playwright JUnit', () => {
    expect(parseJunitFailures(VITEST_JUNIT)).toEqual([{
      id: 'src/main/services/auto-update-apply.test.ts › applies an update > on darwin',
      name: 'applies an update > on darwin',
      file: 'src/main/services/auto-update-apply.test.ts',
      message: "expected 'a' to be 'b'",
      source: '',
    }]);
    expect(parseJunitFailures(PLAYWRIGHT_JUNIT).map((f) => f.id)).toEqual(['app-launch.spec.ts › app launches › shows the title bar']);
  });

  it('collects failures from every artifact folder, deduplicated', () => {
    fs.mkdirSync(path.join(dir, 'junit-unit'));
    fs.mkdirSync(path.join(dir, 'junit-e2e'));
    fs.writeFileSync(path.join(dir, 'junit-unit', 'unit.xml'), VITEST_JUNIT);
    fs.writeFileSync(path.join(dir, 'junit-e2e', 'e2e.xml'), PLAYWRIGHT_JUNIT);
    fs.writeFileSync(path.join(dir, 'junit-e2e', 'retry.xml'), PLAYWRIGHT_JUNIT);

    const failures = collectFailures(dir);
    expect(failures.map((f) => [f.source, f.id])).toEqual([
      ['junit-e2e', 'app-launch.spec.ts › app launches › shows the title bar'],
      ['junit-unit', 'src/main/services/auto-update-apply.test.ts › applies an update > on darwin'],
    ]);
  });

  const f = (id: string) => ({ id, name: id, file: 'x', message: 'boom', source: 's' });
  const base = { runUrl: 'https://example.test/run/1', date: '2026-10-17' };

  it('opens an issue on the first failing night, with the repo\'s labels', () => {
    const d = decide({ ...base, outcome: 'failure', failures: [f('a › one')], openIssue: undefined });
    expect(d).toMatchObject({ action: 'create', title: ISSUE_TITLE, labels: ISSUE_LABELS });
    expect(d.body).toContain('`a › one` — boom');
    expect(previousFailureIds(d.body)).toEqual(['a › one']);
  });

  it('updates the open issue with new, still-failing and fixed tests', () => {
    const openIssue = { number: 7, body: issueBody([f('a › one'), f('b › two')], 'https://example.test/run/0', '2026-10-16') };
    const d = decide({ ...base, outcome: 'failure', failures: [f('b › two'), f('c › three')], openIssue });

    expect(d).toMatchObject({ action: 'update', number: 7 });
    expect(d.comment).toContain('**New failures (1):**\n- `c › three`');
    expect(d.comment).toContain('**Still failing (1):** `b › two`');
    expect(d.comment).toContain('**Fixed since the last report (1):** `a › one`');
    expect(previousFailureIds(d.body)).toEqual(['b › two', 'c › three']);
  });

  it('closes the issue on the first passing night, and does nothing when there is none', () => {
    const openIssue = { number: 7, body: issueBody([f('a › one')], 'u', 'd') };
    expect(decide({ ...base, outcome: 'success', failures: [], openIssue })).toMatchObject({ action: 'close' });
    expect(decide({ ...base, outcome: 'success', failures: [], openIssue: undefined })).toEqual({ action: 'none' });
  });

  it('a failed run with no test results still files, pointing at the log', () => {
    const d = decide({ ...base, outcome: 'failure', failures: [], openIssue: undefined });
    expect(d.action).toBe('create');
    expect(d.body).toContain('failed before producing test results');
  });

  it('caps the listed failures', () => {
    const many = Array.from({ length: 60 }, (_, i) => f(`t › ${String(i).padStart(2, '0')}`));
    expect(issueBody(many, 'u', 'd')).toContain('…and 10 more');
  });
});
