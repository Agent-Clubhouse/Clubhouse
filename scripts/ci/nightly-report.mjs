#!/usr/bin/env node
// Files or updates one deduplicated GitHub issue for the nightly macOS run,
// from its JUnit results (vitest and Playwright). See docs/ci.md.
//
//   node scripts/ci/nightly-report.mjs --junit-dir <dir> --run-url <url> [--outcome success|failure] [--dry-run]
//
// - Failures and no open issue: open one ([MEDIUM][TEST] title, labels per
//   the repo's issue convention, plus `nightly-macos`).
// - Failures and an open issue: comment with what is new, still failing and
//   fixed since the last report, and refresh the body to the current set.
// - Passing night and an open issue: comment and close it.
//
// The failing-test set is kept in the issue body as a hidden marker, so the
// next night can tell new failures from known ones. Uses the `gh` CLI with
// GH_TOKEN.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ISSUE_LABEL = 'nightly-macos';
export const ISSUE_TITLE = '[MEDIUM][TEST] Nightly macOS CI failures';
export const ISSUE_LABELS = [ISSUE_LABEL, 'bug', 'type:bug', 'severity: MEDIUM', 'area:e2e'];
const MARKER = /<!-- nightly-macos-failures: (\[.*?\]) -->/s;
const MAX_LISTED = 50;

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : undefined;
};

/** Failing test cases in a JUnit XML document (vitest or Playwright). */
export function parseJunitFailures(xml, source = '') {
  const failures = [];
  const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m; (m = caseRe.exec(xml));) {
    const open = m[1];
    const body = m[3] ?? '';
    const fail = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (!fail) continue;
    const name = attr(open, 'name') ?? '(unnamed)';
    const classname = attr(open, 'classname') ?? '';
    const file = attr(open, 'file') ?? classname;
    const message = (attr(fail[0], 'message') ?? decode(fail[3] ?? '')).trim().split('\n')[0].slice(0, 300);
    failures.push({ id: `${file} › ${name}`, name, file, message, source });
  }
  return failures;
}

/** Every failure under `dir` (recursively), deduplicated by id. */
export function collectFailures(dir) {
  const byId = new Map();
  const walk = (d) => {
    for (const entry of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.xml')) {
        const source = path.relative(dir, full).split(path.sep)[0];
        for (const f of parseJunitFailures(fs.readFileSync(full, 'utf8'), source)) if (!byId.has(f.id)) byId.set(f.id, f);
      }
    }
  };
  walk(dir);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function previousFailureIds(body) {
  const m = body ? MARKER.exec(body) : null;
  if (!m) return [];
  try {
    const ids = JSON.parse(m[1]);
    return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const list = (items) => {
  const shown = items.slice(0, MAX_LISTED).map((f) => `- \`${f.id}\`${f.message ? ` — ${f.message.replace(/`/g, "'")}` : ''}`);
  if (items.length > MAX_LISTED) shown.push(`- …and ${items.length - MAX_LISTED} more (see the run's artifacts)`);
  return shown.join('\n');
};

export function issueBody(failures, runUrl, date) {
  return [
    `The nightly macOS run (\`.github/workflows/nightly-macos.yml\`) is failing. PRs only run macOS for macOS-specific changes, so this run is where macOS-only regressions show up first (docs/ci.md).`,
    '',
    `**Latest failing run:** ${runUrl} (${date})`,
    '',
    `**Failing tests (${failures.length}):**`,
    failures.length ? list(failures) : '- (the run failed before producing test results; see the run log)',
    '',
    'This issue is updated by each nightly run and closed by the first one that passes.',
    '',
    `<!-- nightly-macos-failures: ${JSON.stringify(failures.map((f) => f.id))} -->`,
  ].join('\n');
}

/** What to do with the tracking issue, and the text to write. Pure, so it can be tested. */
export function decide({ outcome, failures, openIssue, runUrl, date }) {
  const failed = outcome === 'failure' || failures.length > 0;
  if (!failed) {
    if (!openIssue) return { action: 'none' };
    return { action: 'close', comment: `The nightly macOS run passed: ${runUrl} (${date}). Closing.` };
  }
  const body = issueBody(failures, runUrl, date);
  if (!openIssue) return { action: 'create', title: ISSUE_TITLE, labels: ISSUE_LABELS, body };
  const before = new Set(previousFailureIds(openIssue.body));
  const now = new Set(failures.map((f) => f.id));
  const added = failures.filter((f) => !before.has(f.id));
  const still = failures.filter((f) => before.has(f.id));
  const fixed = [...before].filter((id) => !now.has(id));
  const comment = [
    `Nightly macOS run failed again: ${runUrl} (${date}).`,
    '',
    `**New failures (${added.length}):**`,
    added.length ? list(added) : '- none',
    '',
    `**Still failing (${still.length}):** ${still.length ? still.map((f) => `\`${f.id}\``).slice(0, MAX_LISTED).join(', ') : 'none'}`,
    '',
    `**Fixed since the last report (${fixed.length}):** ${fixed.length ? fixed.map((id) => `\`${id}\``).slice(0, MAX_LISTED).join(', ') : 'none'}`,
  ].join('\n');
  return { action: 'update', number: openIssue.number, body, comment };
}

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'inherit'] });
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const dir = get('--junit-dir') ?? 'junit';
  const runUrl = get('--run-url') ?? '(unknown run)';
  const outcome = get('--outcome') ?? 'failure';
  const dryRun = args.includes('--dry-run');
  const date = new Date().toISOString().slice(0, 10);

  const failures = collectFailures(dir);
  const open = JSON.parse(gh(['issue', 'list', '--label', ISSUE_LABEL, '--state', 'open', '--json', 'number,body', '--limit', '1']) || '[]');
  const decision = decide({ outcome, failures, openIssue: open[0], runUrl, date });
  console.log(JSON.stringify({ failures: failures.length, action: decision.action }));
  if (dryRun || decision.action === 'none') return;

  if (decision.action === 'create') {
    // Labels must exist before `gh issue create` can apply them.
    gh(['label', 'create', ISSUE_LABEL, '--color', 'B60205', '--description', 'Tracked by the nightly macOS workflow', '--force']);
    gh(['issue', 'create', '--title', decision.title, '--body-file', '-', ...decision.labels.flatMap((l) => ['--label', l])], decision.body);
  } else if (decision.action === 'update') {
    gh(['issue', 'edit', String(decision.number), '--body-file', '-'], decision.body);
    gh(['issue', 'comment', String(decision.number), '--body-file', '-'], decision.comment);
  } else if (decision.action === 'close') {
    gh(['issue', 'close', String(open[0].number), '--comment', decision.comment]);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
