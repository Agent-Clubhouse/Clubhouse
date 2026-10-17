import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classify, changedLinesByFile } from './classify-changes.mjs';

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
      .toEqual({ docsOnly: true, e2e: false, macosBuild: false });
  });

  it('markdown inside src is app content, not docs', () => {
    expect(run(diff({ 'src/renderer/help/intro.md': ['+x'] }))).toMatchObject({ docsOnly: false, e2e: true });
  });

  it('a unit-test-only change skips the E2E build', () => {
    expect(run(diff({ 'src/main/a.test.ts': ['+x'], 'src/main/__fixtures__/f.json': ['+{}'] })))
      .toEqual({ docsOnly: false, e2e: false, macosBuild: false });
  });

  it('an ordinary source change gets E2E but not the macOS build', () => {
    expect(run(diff({ 'src/main/services/agent-config.ts': ['+const a = 1;'] })))
      .toEqual({ docsOnly: false, e2e: true, macosBuild: false });
  });

  it('unit-level macOS files edited without macOS-specific lines need only the macOS unit job', () => {
    for (const file of ['src/main/services/auto-update-apply.ts', 'src/main/telemetry/secret-store.ts', 'src/main/util/shell.ts', 'src/main/services/file-watch-service.ts']) {
      expect(run(diff({ [file]: ['+  const retries = 3;'] }))).toMatchObject({ macosBuild: false });
    }
  });

  it.each([
    ["  if (process.platform === 'darwin') return;"],
    ['  const isMac = platform === "mac";'],
    ['  if (e.metaKey && e.key === "k") open();'],
    ["  accelerator: 'CmdOrCtrl+Shift+N',"],
    ["  const brew = '/opt/homebrew/bin/claude';"],
    ["  titleBarStyle: 'hiddenInset',"],
    ['  titleBarOverlay: { height: 30 },'],
    ['  trafficLightPosition: { x: 12, y: 10 },'],
    ['  app.dock.setBadge(String(n));'],
    ['  safeStorage.encryptString(token)'],
  ])('a changed source line with a macOS marker needs the macOS build: %s', (line) => {
    expect(run(diff({ 'src/main/services/anything.ts': [`+${line}`] }))).toMatchObject({ macosBuild: true });
  });

  it('the macOS build by path: packaging inputs, the app menu, renderer chrome and the CI itself', () => {
    for (const file of ['forge.config.ts', 'entitlements.plist', 'scripts/fix-node-pty.js', 'assets/icon.icns', '.github/workflows/validate.yml', 'scripts/ci/classify-changes.mjs', 'src/main/menu.ts', 'src/renderer/chrome/ChromeBody.tsx']) {
      expect(run(diff({ [file]: ['+x'] }))).toMatchObject({ macosBuild: true, macosBuildReason: `path ${file}` });
    }
  });

  it('the macOS build for darwin lines in window chrome, preload or the renderer', () => {
    expect(run(diff({ 'src/renderer/features/agents/AgentTitle.tsx': ["+  if (platform === 'darwin') return <TrafficLightSpacer />;"] })))
      .toMatchObject({ macosBuild: true, macosBuildReason: 'macOS-specific lines changed in src/renderer/features/agents/AgentTitle.tsx' });
    expect(run(diff({ 'src/main/ipc/window-handlers.ts': ["+    titleBarStyle: 'hiddenInset',"] }))).toMatchObject({ macosBuild: true });
    expect(run(diff({ 'src/renderer/features/editor/keys.ts': ['+  if (e.metaKey) save();'] }))).toMatchObject({ macosBuild: true });
  });

  it('an edit to a file with a darwin branch elsewhere does not need the macOS build', () => {
    expect(run(diff({ 'src/main/index.ts': ['+registerChatDrivers();'] }))).toMatchObject({ macosBuild: false });
  });

  it('darwin in a test (a platform mock) does not need the macOS build', () => {
    expect(run(diff({ 'src/renderer/features/agents/AgentTitle.test.tsx': ["+Object.defineProperty(process, 'platform', { value: 'darwin' });"] })))
      .toMatchObject({ macosBuild: false });
  });

  it('dependency changes count only for Electron, native modules and forge', () => {
    expect(run(diff({ 'package-lock.json': ['+    "node_modules/electron": {', '+      "version": "43.7.9"'] }))).toMatchObject({ macosBuild: true });
    expect(run(diff({ 'package-lock.json': ['-      "resolved": "https://registry.npmjs.org/electron/-/electron-43.6.0.tgz",', '+      "resolved": "https://registry.npmjs.org/electron/-/electron-43.7.9.tgz",'] })))
      .toMatchObject({ macosBuild: true });
    expect(run(diff({ 'package.json': ['+    "@electron-forge/cli": "^7.12.0",'] }))).toMatchObject({ macosBuild: true });
    expect(run(diff({ 'package-lock.json': ['+    "node_modules/marked": {'] }))).toMatchObject({ macosBuild: false });
  });

  it('with no file list it runs everything', () => {
    expect(classify([])).toMatchObject({ e2e: true, macosBuild: true });
  });

  it('parses changed lines per file from git diff -U0', () => {
    const lines = changedLinesByFile(diff({ 'a.ts': ['+added', '-removed', ' context'], 'b.ts': ['+b'] }));
    expect([...lines.entries()]).toEqual([['a.ts', ['added', 'removed']], ['b.ts', ['b']]]);
  });

  it('the CLI reads a diff on stdin and writes GITHUB_OUTPUT', async () => {
    const out = path.join(os.tmpdir(), `classify-${process.pid}.txt`);
    try {
      const result = spawnSync(process.execPath, [CLASSIFY], {
        input: diff({ 'forge.config.ts': ['+x'] }),
        env: { ...process.env, GITHUB_OUTPUT: out },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(await fs.promises.readFile(out, 'utf8')).toBe(
        'docs_only=false\ne2e=true\nmacos_build=true\nmacos_build_reason=path forge.config.ts\n',
      );
    } finally {
      fs.rmSync(out, { force: true });
    }
  });
});
