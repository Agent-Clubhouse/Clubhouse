#!/usr/bin/env node
// Decides which Validate jobs a pull request needs, from its diff.
// See docs/ci.md. Used by the `changes` job in .github/workflows/validate.yml:
//
//   git diff -U0 <base>...<head> | node scripts/ci/classify-changes.mjs
//
// Prints `docs_only`, `e2e` and `macos_build` (true/false), plus the reason
// for `macos_build`, as key=value lines, appending them to $GITHUB_OUTPUT
// when set.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Files that change nothing the app builds or runs. */
const DOCS_ONLY = [
  /^docs\//,
  /^notes\//,
  /^[^/]+\.md$/, // top-level markdown (README, CONTRIBUTING, …); src/**/*.md is bundled app content
  /^\.github\/ISSUE_TEMPLATE\//,
  /^\.github\/[^/]+\.md$/,
  /^LICENSE$/,
];

/** Unit-test-only changes: the app bundle the E2E suite runs is unchanged. */
const UNIT_TEST_ONLY = [/\.test\.tsx?$/, /\/__fixtures__\//, /\/__mocks__\//, /^test\//, /^scripts\/.*\.test\.ts$/];

/**
 * Changes that need the macOS app built and launched (the "macOS build" job):
 * packaging and signing inputs, window and app chrome, and the CI that runs
 * it. The macOS unit job runs on every code PR regardless.
 */
const MACOS_BUILD_PATHS = [
  /^forge\.config\.ts$/,
  /^entitlements\.plist$/,
  /^scripts\/fix-node-pty\.js$/,
  /^assets\/.*\.icns$/,
  /^\.github\/workflows\/validate\.yml$/,
  /^scripts\/ci\//,
  // Window and app chrome, whose macOS look and behaviour (traffic lights,
  // the app menu) only show in a launched app.
  /^src\/main\/menu\.ts$/,
  /^src\/renderer\/chrome\//,
];

/**
 * A changed line, in any non-test source file, that touches macOS-only
 * behaviour. Matching changed lines rather than whole files keeps an
 * unrelated edit to a file with a darwin branch elsewhere from counting.
 */
const MACOS_MARKERS = new RegExp([
  String.raw`['"]darwin['"]`,
  String.raw`\bsafeStorage\b`,
  String.raw`\bsystemPreferences\b`,
  // window chrome
  String.raw`\btitleBarStyle\b`,
  String.raw`\btitleBarOverlay\b`,
  String.raw`\bhiddenInset\b`,
  String.raw`\btrafficLightPosition\b`,
  String.raw`\bapp\.dock\b`,
  String.raw`\bsetVibrancy\b`,
  // keyboard: Cmd on macOS
  String.raw`\bisMac\b`,
  String.raw`\bmetaKey\b`,
  String.raw`\bCmdOrCtrl\b`,
  // macOS install locations, packaging and signing
  String.raw`/opt/homebrew`,
  String.raw`\bosxSign\b`,
  String.raw`\bosxNotarize\b`,
].join('|'));

/** Dependency changes that alter what gets built for macOS (Electron, native modules, packaging). */
const PACKAGING_DEPENDENCY = new RegExp([
  // package.json entries and lockfile keys: "electron", "node_modules/node-pty", …
  String.raw`"(?:node_modules/)?(?:electron|node-pty|@electron/[^"]+|@electron-forge/[^"]+|electron-[^"]+)"`,
  // lockfile "resolved" URLs, which are often the only changed lines of a bump
  String.raw`registry\.npmjs\.org/(?:electron|node-pty|@electron/|@electron-forge/|electron-)`,
].join('|'));

const matchesAny = (patterns, file) => patterns.some((re) => re.test(file));
const isTest = (file) => matchesAny(UNIT_TEST_ONLY, file);

/** Changed lines (added or removed) per file, from `git diff -U0` output. */
export function changedLinesByFile(diff) {
  const byFile = new Map();
  let current;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line);
      current = m ? m[1] : undefined;
      if (current && !byFile.has(current)) byFile.set(current, []);
    } else if (current && (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      byFile.get(current).push(line.slice(1));
    }
  }
  return byFile;
}

/**
 * @param {string[]} files changed paths, repo-relative
 * @param {Map<string, string[]>} [changedLines] added/removed lines per file;
 *   without it, only path rules decide `macosBuild`
 */
export function classify(files, changedLines = new Map()) {
  const changed = files.map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean);
  if (changed.length === 0) return { docsOnly: false, e2e: true, macosBuild: true, macosBuildReason: 'no changed files listed' };

  const docsOnly = changed.every((f) => matchesAny(DOCS_ONLY, f));
  const e2e = !docsOnly && changed.some((f) => !matchesAny(DOCS_ONLY, f) && !isTest(f));

  let reason;
  if (!docsOnly) {
    const lines = (f) => changedLines.get(f) ?? [];
    const byPath = changed.find((f) => matchesAny(MACOS_BUILD_PATHS, f));
    const byDependency = changed.find((f) => /^package(-lock)?\.json$/.test(f) && lines(f).some((l) => PACKAGING_DEPENDENCY.test(l)));
    const byMarker = changed.find((f) => /^src\/.*\.(ts|tsx)$/.test(f) && !isTest(f) && lines(f).some((l) => MACOS_MARKERS.test(l)));
    if (byPath) reason = `path ${byPath}`;
    else if (byDependency) reason = `Electron or native-module dependency change in ${byDependency}`;
    else if (byMarker) reason = `macOS-specific lines changed in ${byMarker}`;
  }
  return { docsOnly, e2e, macosBuild: reason !== undefined, ...(reason && { macosBuildReason: reason }) };
}

function main() {
  // stdin: `git diff -U0 <base>...<head>` output; the file list comes from it.
  const diff = fs.readFileSync(0, 'utf8');
  const changedLines = changedLinesByFile(diff);
  const result = classify([...changedLines.keys()], changedLines);
  const lines = [
    `docs_only=${result.docsOnly}`,
    `e2e=${result.e2e}`,
    `macos_build=${result.macosBuild}`,
    `macos_build_reason=${result.macosBuildReason ?? ''}`,
  ];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
