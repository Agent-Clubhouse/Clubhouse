#!/usr/bin/env node
// Decides which Validate jobs a pull request needs, from its diff.
// See docs/ci.md. Used by the `changes` job in .github/workflows/validate.yml:
//
//   git diff -U0 <base>...<head> | node scripts/ci/classify-changes.mjs
//
// Prints `docs_only`, `e2e` and `macos` (true/false), plus the reason for
// `macos`, as key=value lines, appending them to $GITHUB_OUTPUT when set.

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
 * Files that exist for macOS: packaging and signing, the Squirrel.Mac update
 * path, the keychain-backed secret store, the login-shell environment, and
 * the CI that runs the macOS jobs. Any change to one gets the targeted
 * macOS job. Shared files with a macOS branch are caught by MACOS_MARKERS on
 * the changed lines instead, so ordinary edits to them don't.
 */
const MACOS_PATHS = [
  /^forge\.config\.ts$/,
  /^entitlements\.plist$/,
  /^scripts\/fix-node-pty\.js$/,
  /^assets\/.*\.icns$/,
  /^src\/main\/services\/auto-update/, // includes the darwin-only apply test
  /^src\/main\/telemetry\/secret-store\.ts$/,
  /^src\/main\/util\/shell\.ts$/,
  /^\.github\/workflows\/(validate|nightly-macos)\.yml$/,
  /^scripts\/ci\//,
];

/** A changed line that touches macOS-only behaviour, in a non-test source file. */
const MACOS_MARKERS = /['"]darwin['"]|\bsafeStorage\b|\bsystemPreferences\b|\btitleBarStyle\b|\btrafficLightPosition\b|\bapp\.dock\b|\bsetVibrancy\b|\bosxSign\b|\bosxNotarize\b/;

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
 *   without it, only path rules decide `macos`
 */
export function classify(files, changedLines = new Map()) {
  const changed = files.map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean);
  if (changed.length === 0) return { docsOnly: false, e2e: true, macos: true, macosReason: 'no changed files listed' };

  const docsOnly = changed.every((f) => matchesAny(DOCS_ONLY, f));
  const e2e = !docsOnly && changed.some((f) => !matchesAny(DOCS_ONLY, f) && !isTest(f));

  let macosReason;
  if (!docsOnly) {
    const lines = (f) => changedLines.get(f) ?? [];
    const byPath = changed.find((f) => matchesAny(MACOS_PATHS, f));
    const byDependency = changed.find((f) => /^package(-lock)?\.json$/.test(f) && lines(f).some((l) => PACKAGING_DEPENDENCY.test(l)));
    const byMarker = changed.find((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !isTest(f) && lines(f).some((l) => MACOS_MARKERS.test(l)));
    if (byPath) macosReason = `path ${byPath}`;
    else if (byDependency) macosReason = `Electron or native-module dependency change in ${byDependency}`;
    else if (byMarker) macosReason = `macOS-specific lines changed in ${byMarker}`;
  }
  return { docsOnly, e2e, macos: macosReason !== undefined, ...(macosReason && { macosReason }) };
}

function main() {
  // stdin: `git diff -U0 <base>...<head>` output; the file list comes from it.
  const diff = fs.readFileSync(0, 'utf8');
  const changedLines = changedLinesByFile(diff);
  const result = classify([...changedLines.keys()], changedLines);
  const lines = [
    `docs_only=${result.docsOnly}`,
    `e2e=${result.e2e}`,
    `macos=${result.macos}`,
    `macos_reason=${result.macosReason ?? ''}`,
  ];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
