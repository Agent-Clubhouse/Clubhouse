#!/usr/bin/env node
// Finds, checks and republishes release notes. Used by
// .github/workflows/release.yml and .github/workflows/republish-notes.yml.
//
// The notes for a tag come from the PR that bumped package.json to the tag's
// version, never from whatever PR the tag happens to sit on (#2508):
//
//   node scripts/ci/release-notes.mjs extract --tag v1.2.0 [--allow-past-bump]
//       [--notes-out FILE] [--message-out FILE] [--github-output]
//
// fails when the tag isn't on the bump commit (listing the PRs in between),
// when there is no bump commit or PR, or when the notes don't validate.
//
//   node scripts/ci/release-notes.mjs validate --notes-file FILE
//   node scripts/ci/release-notes.mjs validate-message --message-file FILE
//
// check (and normalise in place) replacement notes or a release message.
//
//   node scripts/ci/release-notes.mjs rewrite-manifest --file FILE --version V
//       --notes-file FILE [--message-file FILE] [--history] --out FILE
//
// replaces releaseNotes (and releaseMessage when given) in an update manifest,
// or in that version's entry of a history.json, leaving every other byte of
// the file as it was. Prints `status=updated|unchanged|skipped`.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** How far back along main to look for the bump commit before giving up. */
const MAX_WALK = 500;

/** The notes must open with one of the bump PR's section headings. */
export const KNOWN_HEADINGS = ['# New Features', '# Bug Fixes', '# Improvements'];

/** Lines that only show up in an ordinary PR description, never in release notes. */
const PR_BODY_MARKERS = [
  { re: /\b(fix(es|ed)?|close[sd]?|resolve[sd]?)\s+#\d+/i, label: 'an issue-closing keyword ("Fixes #N")' },
  { re: /^#{2,}\s*(summary|validation|test(ing)? plan|testing|verification)\b/im, label: 'a PR section heading ("## Summary", "## Validation")' },
  { re: /generated with \[|^🤖/im, label: 'a "Generated with [tool]" trailer' },
  { re: /co-authored-by:/i, label: '"Co-Authored-By:"' },
  { re: /\bnpm (run|test|ci)\b|\bnpx \S/, label: 'an npm command' },
  { re: /^\s*[-*] \[[ xX]\]/m, label: 'a task checklist' },
];

/** The package.json version a tag should match. Legacy `rc` tags drop the suffix. */
export function versionForTag(tag) {
  const version = tag.replace(/^v/, '');
  return version.endsWith('rc') ? version.slice(0, -2) : version;
}

export function isPreviewTag(tag) {
  const version = tag.replace(/^v/, '');
  return version.endsWith('rc') || version.includes('-beta.');
}

function packageVersionAt(git, sha) {
  try {
    return JSON.parse(git(['show', `${sha}:package.json`])).version ?? null;
  } catch {
    return null;
  }
}

/**
 * The commit that set package.json to `version`: the oldest commit of the run
 * of first-parent ancestors of `tagRev`, starting at `tagRev` itself, whose
 * package.json carries that version. Null when the tagged commit doesn't.
 */
export function findBumpCommit(git, tagRev, version) {
  const shas = git(['rev-list', '--first-parent', `--max-count=${MAX_WALK + 1}`, `${tagRev}^{commit}`])
    .split('\n').filter(Boolean);
  let bump = null;
  for (const sha of shas.slice(0, MAX_WALK)) {
    if (packageVersionAt(git, sha) !== version) return bump;
    bump = sha;
  }
  // Ran off the root commit: it set the version. Ran past MAX_WALK: give up.
  return shas.length <= MAX_WALK ? bump : null;
}

/** First-parent commits after `bump` up to and including `tagRev`, oldest first. */
export function commitsAfter(git, bump, tagRev) {
  return git(['log', '--first-parent', '--reverse', '--format=%H%x09%s', `${bump}..${tagRev}^{commit}`])
    .split('\n').filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split('\t');
      return { sha, subject: rest.join('\t') };
    });
}

/** The PR number a squash-merge subject ends with, as in `Fix thing (#123)`. */
export function prFromSubject(subject) {
  const m = /\(#(\d+)\)\s*$/.exec(subject);
  return m ? Number(m[1]) : null;
}

/**
 * Splits a bump PR body into the release message (its `Release: ` first line)
 * and the notes, dropping the test plan and generated trailers the way the
 * release pipeline always has.
 */
export function parsePrBody(body) {
  let lines = (body ?? '').replace(/\r\n?/g, '\n').split('\n');
  let message = null;
  if (lines.length && /^Release: /.test(lines[0])) {
    message = lines[0].slice('Release: '.length).trim() || null;
    lines = lines.slice(1);
  }
  const testPlan = lines.findIndex((l) => /^## Test [Pp]lan/.test(l));
  if (testPlan !== -1) lines = lines.slice(0, testPlan);
  lines = lines.filter((l) => !/Co-[Aa]uthored-[Bb]y:/.test(l)
    && !/Generated with \[Claude Code\]/.test(l)
    && !l.startsWith('🤖'));
  const notes = lines.join('\n').replace(/^\s*\n/, '').trimEnd();
  return { message, notes };
}

/** Problems that keep `notes` from being published; empty when they're fine. */
export function validateNotes(notes) {
  const text = (notes ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return ['the notes are empty'];
  const problems = [];
  const first = text.split('\n', 1)[0].trimEnd();
  if (!KNOWN_HEADINGS.includes(first)) {
    problems.push(`the notes must start with ${KNOWN_HEADINGS.map((h) => `"${h}"`).join(', ')}; they start with "${first.slice(0, 80)}"`);
  }
  for (const { re, label } of PR_BODY_MARKERS) {
    if (re.test(text)) problems.push(`the notes contain ${label}, which belongs in a PR description`);
  }
  return problems;
}

export class ReleaseNotesError extends Error {}

/**
 * Finds the bump commit and PR for `tag` and returns its message and notes.
 * `github.pullsForCommit(sha)` lists the PRs GitHub links to a commit and
 * `github.pullBody(n)` returns a PR's body.
 */
export function extract({ git, github, tag, allowPastBump = false }) {
  const version = versionForTag(tag);
  const tagSha = git(['rev-parse', `${tag}^{commit}`]).trim();
  const tagVersion = packageVersionAt(git, tagSha);
  if (tagVersion !== version) {
    throw new ReleaseNotesError(`package.json at ${tag} (${tagSha.slice(0, 9)}) is ${tagVersion ?? 'missing'}, not ${version}, so there is no bump commit for ${tag}.`);
  }
  const bump = findBumpCommit(git, tagSha, version);
  if (!bump) throw new ReleaseNotesError(`No commit setting package.json to ${version} found within ${MAX_WALK} commits of ${tag}.`);
  const bumpSubject = git(['log', '-1', '--format=%s', bump]).trim();

  const extra = bump === tagSha ? [] : commitsAfter(git, bump, tagSha);
  const warnings = [];
  if (extra.length) {
    const list = extra.map((c) => `  ${c.sha.slice(0, 9)} ${c.subject}`).join('\n');
    const detail = `${tag} is on ${tagSha.slice(0, 9)}, ${extra.length} commit(s) after the version bump ${bump.slice(0, 9)} (${bumpSubject}). These shipped in the build but aren't covered by the bump PR's notes:\n${list}`;
    if (!allowPastBump) {
      throw new ReleaseNotesError(`${detail}\n\nEither retag on the bump commit:\n  git push origin :refs/tags/${tag} && git tag -d ${tag}\n  git tag -s ${tag} -m "<release message>" ${bump} && git push origin ${tag}\nor update the bump PR's notes to cover them and re-run with the override (repository variable RELEASE_NOTES_ALLOW_PAST_BUMP set to ${tag}).`);
    }
    warnings.push(`${detail}\nContinuing because the past-bump override is set for ${tag}.`);
  }

  const pulls = github.pullsForCommit(bump) ?? [];
  // Prefer the PR GitHub records as merging this commit, then the squash
  // subject's (#N); any other linked PR may just have the commit on its branch.
  const pr = pulls.find((p) => p.merge_commit_sha === bump)?.number
    ?? prFromSubject(bumpSubject)
    ?? pulls.find((p) => p.merged_at)?.number
    ?? null;
  if (!pr) throw new ReleaseNotesError(`No PR found for the bump commit ${bump.slice(0, 9)} (${bumpSubject}).`);

  const { message, notes } = parsePrBody(github.pullBody(pr));
  const problems = validateNotes(notes);
  if (problems.length) {
    throw new ReleaseNotesError(`The notes from bump PR #${pr} can't be published:\n${problems.map((p) => `  - ${p}`).join('\n')}\nEdit the PR body and re-run.`);
  }
  const tagSubject = git(['tag', '-l', '--format=%(subject)', tag]).trim();
  return {
    version,
    bumpSha: bump,
    bumpPr: pr,
    pastBump: extra,
    warnings,
    message: message ?? tagSubject,
    notes,
  };
}

// ── Manifest rewriting ──────────────────────────────────────────────────────

/**
 * Locates the raw text of every value in a JSON document by path, so a single
 * value can be swapped without reformatting the rest of the file.
 * Returns a Map from JSON-encoded path to [start, end).
 */
export function valueSpans(text) {
  const spans = new Map();
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] ?? '')) i++; };
  const fail = () => { throw new Error(`Malformed JSON at offset ${i}`); };
  const str = () => {
    if (text[i] !== '"') fail();
    const start = i++;
    while (text[i] !== '"') {
      if (i >= text.length) fail();
      i += text[i] === '\\' ? 2 : 1;
    }
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const value = (p) => {
    ws();
    const start = i;
    if (text[i] === '{') {
      i++; ws();
      if (text[i] === '}') i++;
      else {
        for (;;) {
          ws();
          const key = str();
          ws();
          if (text[i++] !== ':') fail();
          value([...p, key]);
          ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i++] !== '}') fail();
          break;
        }
      }
    } else if (text[i] === '[') {
      i++; ws();
      if (text[i] === ']') i++;
      else {
        for (let n = 0; ; n++) {
          value([...p, n]);
          ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i++] !== ']') fail();
          break;
        }
      }
    } else if (text[i] === '"') {
      str();
    } else {
      const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
      if (!m) fail();
      i += m[0].length;
    }
    spans.set(JSON.stringify(p), [start, i]);
  };
  value([]);
  ws();
  if (i !== text.length) fail();
  return spans;
}

/** Encodes a string the way the file encodes non-ASCII text (raw UTF-8 or \u escapes). */
function encodeLike(fileText, value) {
  const json = JSON.stringify(value);
  const asciiOnly = /\\u(?!00[0-7])[0-9a-fA-F]{4}/.test(fileText) && !/[\u0080-\uffff]/.test(fileText);
  return asciiOnly ? json.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) : json;
}

/**
 * Replaces releaseNotes (and releaseMessage, when given) for `version` in a
 * manifest (`history: false`) or a history.json array (`history: true`).
 * Returns { status: 'updated' | 'unchanged' | 'skipped', text, reason? }.
 */
export function rewriteManifest(text, { version, notes, message = null, history = false }) {
  const doc = JSON.parse(text);
  let base;
  if (history) {
    if (!Array.isArray(doc)) throw new Error('history.json is not an array');
    const index = doc.findIndex((e) => e?.version === version);
    if (index === -1) return { status: 'skipped', text, reason: `no history entry for ${version}` };
    base = [index];
  } else {
    if (doc?.version !== version) return { status: 'skipped', text, reason: `the manifest is for ${doc?.version ?? 'no version'}, not ${version}` };
    base = [];
  }
  const changes = [['releaseNotes', notes]];
  if (message !== null) changes.push(['releaseMessage', message]);

  const spans = valueSpans(text);
  const edits = [];
  for (const [key, value] of changes) {
    const span = spans.get(JSON.stringify([...base, key]));
    if (!span) throw new Error(`The ${history ? 'history entry' : 'manifest'} for ${version} has no ${key}`);
    const original = text.slice(span[0], span[1]);
    if (typeof JSON.parse(original) !== 'string') throw new Error(`${key} for ${version} is not a string`);
    if (JSON.parse(original) !== value) edits.push([span, encodeLike(text, value)]);
  }
  if (!edits.length) return { status: 'unchanged', text };

  let out = text;
  for (const [[start, end], replacement] of edits.sort((a, b) => b[0][0] - a[0][0])) {
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  // Belt and braces: the result must parse to the input with only these fields changed.
  const expected = JSON.parse(text);
  const target = history ? expected[base[0]] : expected;
  for (const [key, value] of changes) target[key] = value;
  if (JSON.stringify(JSON.parse(out)) !== JSON.stringify(expected)) throw new Error('Rewritten manifest does not match the intended change');
  return { status: 'updated', text: out };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2);
    if (['allow-past-bump', 'github-output', 'history'].includes(key)) args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

function need(args, key) {
  if (!args[key]) throw new ReleaseNotesError(`--${key} is required`);
  return args[key];
}

/** Formats a $GITHUB_OUTPUT entry under a delimiter the value can't contain. */
export function outputEntry(name, value) {
  let delimiter;
  do delimiter = `EOF_${randomBytes(16).toString('hex')}`; while (value.includes(delimiter));
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

function appendGithubOutput(entry) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, entry);
}

function ghApi(endpoint) {
  return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
}

export function main(argv, {
  git = (a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
  github,
  appendOutput = appendGithubOutput,
} = {}) {
  const args = parseArgs(argv);
  const command = args._[0];

  if (command === 'extract') {
    const tag = need(args, 'tag');
    const repo = args.repo ?? process.env.GITHUB_REPOSITORY;
    github ??= {
      pullsForCommit: (sha) => ghApi(`repos/${need({ repo }, 'repo')}/commits/${sha}/pulls`),
      pullBody: (n) => ghApi(`repos/${need({ repo }, 'repo')}/pulls/${n}`).body ?? '',
    };
    const result = extract({ git, github, tag, allowPastBump: !!args['allow-past-bump'] });
    for (const w of result.warnings) console.log(`::warning::${w.split('\n')[0]}\n${w}`);
    console.log(`Release notes for ${tag} come from bump PR #${result.bumpPr} (${result.bumpSha.slice(0, 9)}).`);
    // The notes are PR-author text: stop the runner reading `::` lines in them as workflow commands.
    const token = randomBytes(16).toString('hex');
    console.log(`::stop-commands::${token}`);
    console.log(`Release message: ${result.message}`);
    console.log(`--- notes ---\n${result.notes}\n--- end notes ---`);
    console.log(`::${token}::`);
    if (args['notes-out']) fs.writeFileSync(args['notes-out'], `${result.notes}\n`);
    if (args['message-out']) fs.writeFileSync(args['message-out'], `${result.message}\n`);
    if (args['github-output']) {
      appendOutput(outputEntry('release_message', result.message));
      appendOutput(outputEntry('release_notes', result.notes));
      appendOutput(outputEntry('bump_sha', result.bumpSha));
      appendOutput(outputEntry('bump_pr', String(result.bumpPr)));
    }
    return 0;
  }

  if (command === 'validate') {
    const file = need(args, 'notes-file');
    const notes = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').trim();
    const problems = validateNotes(notes);
    if (problems.length) throw new ReleaseNotesError(`The notes can't be published:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    // Normalised in place so the release body and the manifests get the same text.
    fs.writeFileSync(file, `${notes}\n`);
    console.log('Notes are valid.');
    return 0;
  }

  if (command === 'validate-message') {
    const file = need(args, 'message-file');
    const message = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').trim();
    if (!message || message.includes('\n')) throw new ReleaseNotesError('The release message must be a single non-empty line.');
    fs.writeFileSync(file, `${message}\n`);
    return 0;
  }

  if (command === 'rewrite-manifest') {
    const readTrimmed = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n?/g, '\n').trim();
    const result = rewriteManifest(fs.readFileSync(need(args, 'file'), 'utf8'), {
      version: need(args, 'version'),
      notes: readTrimmed(need(args, 'notes-file')),
      message: args['message-file'] ? readTrimmed(args['message-file']) : null,
      history: !!args.history,
    });
    fs.writeFileSync(need(args, 'out'), result.text);
    console.log(`status=${result.status}${result.reason ? `\nreason=${result.reason}` : ''}`);
    return 0;
  }

  throw new ReleaseNotesError(`Unknown command "${command ?? ''}". Use extract, validate, validate-message or rewrite-manifest.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`::error::${message.split('\n')[0]}`);
    console.error(message);
    process.exit(1);
  }
}
