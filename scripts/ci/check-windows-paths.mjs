#!/usr/bin/env node
// Fails when a path in the repo can't exist on Windows. One such commit makes
// every Windows job die at actions/checkout (#2347: a stray `undefined\temp/`
// Node compile-cache dir). See docs/ci.md.
//
//   node scripts/ci/check-windows-paths.mjs              # tracked files (CI)
//   node scripts/ci/check-windows-paths.mjs --untracked  # also untracked and ignored
//
// The vitest global setup runs the --untracked form after every test run.

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// eslint-disable-next-line no-control-regex -- control characters are what we reject
const INVALID_CHARS = /[<>:"|?*\\\u0000-\u001f]/;

/** Why `name` (one path segment) can't exist on Windows, or undefined if it can. */
export function windowsNameProblem(name) {
  const bad = name.match(INVALID_CHARS);
  if (bad) return `contains ${JSON.stringify(bad[0])}`;
  if (RESERVED.test(name)) return 'is a reserved device name';
  if (/[ .]$/.test(name) && name !== '.' && name !== '..') return 'ends with a dot or space';
  return undefined;
}

/** The problems among `paths` (repo-relative, `/`-separated), one string per bad path. */
export function findWindowsPathProblems(paths) {
  const problems = [];
  for (const p of paths) {
    for (const segment of p.split('/').filter(Boolean)) {
      const why = windowsNameProblem(segment);
      if (why) {
        problems.push(`${JSON.stringify(p)}: ${JSON.stringify(segment)} ${why}`);
        break;
      }
    }
  }
  return problems;
}

/** Repo paths from git: tracked, plus untracked and ignored (collapsed to their directories) when asked. */
export function listRepoPaths(cwd, { untracked = false } = {}) {
  const git = (...args) => execFileSync('git', ['-c', 'core.quotepath=off', ...args, '-z'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = git('ls-files', '--cached') + (untracked ? git('ls-files', '--others', '--directory') : '');
  return out.split('\0').filter(Boolean);
}

/** A failure message for the bad paths under `cwd`, or undefined when all are valid. */
export function checkWindowsPaths(cwd, opts) {
  const problems = findWindowsPathProblems(listRepoPaths(cwd, opts));
  if (problems.length === 0) return undefined;
  return [
    `${problems.length} path(s) can't exist on Windows (a Windows checkout of this commit fails):`,
    ...problems.slice(0, 20).map((p) => `  ${p}`),
    ...(problems.length > 20 ? [`  … and ${problems.length - 20} more`] : []),
    'Delete or rename them. A dir like `undefined\\temp` is a Node compile cache written by a Node process whose os.tmpdir() took its win32 branch with TEMP and TMP unset (#2347).',
  ].join('\n');
}

function main() {
  const message = checkWindowsPaths(process.cwd(), { untracked: process.argv.includes('--untracked') });
  if (message) {
    console.error(message);
    process.exit(1);
  }
  console.log('All paths are valid on Windows.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
