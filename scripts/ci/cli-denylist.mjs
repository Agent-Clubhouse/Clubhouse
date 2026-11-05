#!/usr/bin/env node
// Checks chat's CLI kill switch list and writes it into update manifests. Used
// by .github/workflows/release.yml and scripts/ci/publish-cli-denylist.sh; the
// operation is in docs/release-publishing.md.
//
// release/chat-cli-denylist.json holds one of three things:
//   null        No list. A release leaves the field out, which keeps every
//               client's saved list. Nothing can be published from this state.
//   [entries]   The list. Every manifest carries it, and it replaces a client's
//               saved list.
//   []          Cleared on purpose. Every manifest carries [], which empties a
//               client's saved list. It stays [] so a client that was offline
//               when the list was cleared still clears it later.
//
//   node scripts/ci/cli-denylist.mjs validate --list FILE
//
// prints `state=none|clear|entries` and `count=N`, or fails.
//
//   node scripts/ci/cli-denylist.mjs add-to-manifest --file FILE --list FILE
//
// is the release path: writes the list into a freshly generated manifest, in
// place. `status=omitted` when the list is null.
//
//   node scripts/ci/cli-denylist.mjs rewrite-manifest --file FILE --list FILE --out FILE [--allow-clear]
//
// is the publish path: sets chatCliDenylist in a live manifest, leaving every
// other byte as it was. Prints `status=updated|unchanged`. A null list fails, and
// [] fails without --allow-clear.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeLike, valueSpans } from './release-notes.mjs';

const FIELD = 'chatCliDenylist';

// The client's rules, from sanitizeDenylist in
// src/main/services/agent-runtime/chat-version-policy.ts. A client drops a bad
// entry without telling anyone, so here it fails the publish instead.
// cli-denylist.test.ts runs both over the same inputs to keep them in step.
export const MAX_DENYLIST_ENTRIES = 100;
export const MAX_VERSIONS_PER_ENTRY = 200;
const MAX_VERSION_LENGTH = 64;
const MAX_REASON_LENGTH = 300;
const EXACT_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

// Stricter than the client, because each of these is accepted there and then
// does the wrong thing silently: an unknown id never matches, so the entry blocks
// nothing, and an unknown key is ignored, so `{ form, to }` becomes `{ to }` and
// blocks every older version. A new driver or provider has to be added here, and
// until then the publish refuses it by name.
export const KNOWN_DRIVERS = ['claude_agent_sdk', 'claude_stream_json', 'codex_app_server', 'copilot_acp', 'copilot_sdk', 'acp'];
export const KNOWN_PROVIDERS = ['claude-code', 'codex-cli', 'copilot-cli'];
const ENTRY_KEYS = ['driver', 'provider', 'versions', 'range', 'reason'];
const RANGE_KEYS = ['from', 'to'];

export class DenylistError extends Error {}

/** A problem with one version value, or undefined when it's what a client would store. */
function versionProblem(raw) {
  if (typeof raw !== 'string') return `${JSON.stringify(raw)} is not a string`;
  if (raw.length > MAX_VERSION_LENGTH) return `"${raw.slice(0, 20)}…" is longer than ${MAX_VERSION_LENGTH} characters`;
  const m = EXACT_VERSION_RE.exec(raw);
  if (!m) return `"${raw}" is not a plain x.y.z[-prerelease] version`;
  const canonical = `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}${m[4] ? `-${m[4]}` : ''}`;
  if (canonical !== raw) return `"${raw}" should be written "${canonical}", which is the form clients compare`;
  return undefined;
}

/** SemVer precedence. The same order as compareCliVersions in chat-version-policy.ts. */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, ...rest] = v.split('-');
    return { nums: core.split('.').map(Number), pre: rest.length ? rest.join('-').split('.') : undefined };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  }
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function entryProblems(e) {
  if (!isObject(e)) return ['is not an object'];
  const problems = [];
  for (const key of Object.keys(e)) {
    if (!ENTRY_KEYS.includes(key)) problems.push(`has an unknown field "${key}"`);
  }

  if (typeof e.reason !== 'string' || !e.reason.trim()) problems.push('needs a reason, which users see');
  else if (e.reason.length > MAX_REASON_LENGTH) problems.push(`has a reason longer than ${MAX_REASON_LENGTH} characters`);

  if (e.driver === undefined && e.provider === undefined) problems.push('needs a driver or a provider');
  // A client ignores provider when driver is set, so one of them would be decoration.
  else if (e.driver !== undefined && e.provider !== undefined) problems.push('has both a driver and a provider; use one');
  else if (e.driver !== undefined && !KNOWN_DRIVERS.includes(e.driver)) problems.push(`names an unknown driver ${JSON.stringify(e.driver)}; known: ${KNOWN_DRIVERS.join(', ')}`);
  else if (e.provider !== undefined && !KNOWN_PROVIDERS.includes(e.provider)) problems.push(`names an unknown provider ${JSON.stringify(e.provider)}; known: ${KNOWN_PROVIDERS.join(', ')}`);

  if (e.versions !== undefined) {
    if (!Array.isArray(e.versions) || e.versions.length === 0) problems.push('has versions that are not a non-empty array');
    else if (e.versions.length > MAX_VERSIONS_PER_ENTRY) problems.push(`has more than ${MAX_VERSIONS_PER_ENTRY} versions`);
    else {
      for (const v of e.versions) {
        const problem = versionProblem(v);
        if (problem) problems.push(`has a bad version: ${problem}`);
      }
    }
  }

  if (e.range !== undefined) {
    if (!isObject(e.range)) problems.push('has a range that is not an object');
    else {
      for (const key of Object.keys(e.range)) {
        if (!RANGE_KEYS.includes(key)) problems.push(`has an unknown range field "${key}"`);
      }
      const { from, to } = e.range;
      if (from === undefined && to === undefined) problems.push('has a range with neither from nor to, which would match every version');
      const fromProblem = from === undefined ? undefined : versionProblem(from);
      const toProblem = to === undefined ? undefined : versionProblem(to);
      if (fromProblem) problems.push(`has a bad range.from: ${fromProblem}`);
      if (toProblem) problems.push(`has a bad range.to: ${toProblem}`);
      if (from !== undefined && to !== undefined && !fromProblem && !toProblem && compareVersions(from, to) > 0) {
        problems.push(`has a range from ${from} to ${to}, which matches nothing`);
      }
    }
  }

  if (e.versions === undefined && e.range === undefined) problems.push('needs versions or a range');
  return problems;
}

/** Every reason this value can't be published; empty when a client would keep all of it unchanged. */
export function validateDenylist(list) {
  if (!Array.isArray(list)) return [`the list must be an array, or null for no list; it is ${JSON.stringify(list)}`];
  const problems = [];
  if (list.length > MAX_DENYLIST_ENTRIES) problems.push(`the list has ${list.length} entries; clients read the first ${MAX_DENYLIST_ENTRIES} and ignore the rest`);
  list.forEach((entry, i) => {
    for (const problem of entryProblems(entry)) problems.push(`entry ${i} ${problem}`);
  });
  return problems;
}

/** The list from a file: null, or a valid array. Anything else throws. */
export function readList(file) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new DenylistError(`Can't read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (value === null) return null;
  const problems = validateDenylist(value);
  if (problems.length) throw new DenylistError(`${file} can't be published:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return value;
}

/**
 * Sets chatCliDenylist in a manifest's text, replacing the value in place or
 * adding the field after the last one. No other byte changes.
 * Returns { status: 'updated' | 'unchanged', text }.
 */
export function setManifestList(text, list) {
  const doc = JSON.parse(text);
  if (!isObject(doc) || typeof doc.version !== 'string') throw new DenylistError('This is not an update manifest: it has no version');

  const spans = valueSpans(text);
  const span = spans.get(JSON.stringify([FIELD]));
  const encoded = encodeLike(text, list);
  let out;
  if (span) {
    if (JSON.stringify(JSON.parse(text.slice(span[0], span[1]))) === JSON.stringify(list)) return { status: 'unchanged', text };
    out = text.slice(0, span[0]) + encoded + text.slice(span[1]);
  } else {
    const fieldEnds = [...spans].filter(([p]) => JSON.parse(p).length === 1).map(([, s]) => s[1]);
    const end = Math.max(...fieldEnds);
    const separator = /^\s*\{(\s*)/.exec(text)[1];
    out = `${text.slice(0, end)},${separator}${JSON.stringify(FIELD)}: ${encoded}${text.slice(end)}`;
  }
  // Belt and braces: the result must parse to the input with only this field changed.
  if (JSON.stringify(JSON.parse(out)) !== JSON.stringify({ ...doc, [FIELD]: list })) throw new DenylistError('Rewritten manifest does not match the intended change');
  return { status: 'updated', text: out };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'allow-clear') args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

function need(args, key) {
  if (!args[key]) throw new DenylistError(`--${key} is required`);
  return args[key];
}

export function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];

  if (command === 'validate') {
    const list = readList(need(args, 'list'));
    const state = list === null ? 'none' : list.length === 0 ? 'clear' : 'entries';
    console.log(`state=${state}\ncount=${list?.length ?? 0}`);
    return 0;
  }

  if (command === 'add-to-manifest') {
    const file = need(args, 'file');
    const list = readList(need(args, 'list'));
    if (list === null) {
      console.log('status=omitted');
      return 0;
    }
    const result = setManifestList(fs.readFileSync(file, 'utf8'), list);
    fs.writeFileSync(file, result.text);
    console.log(`status=${result.status}`);
    return 0;
  }

  if (command === 'rewrite-manifest') {
    const listFile = need(args, 'list');
    const list = readList(listFile);
    if (list === null) throw new DenylistError(`${listFile} is null, so there is no list to publish.`);
    if (list.length === 0 && !args['allow-clear']) {
      throw new DenylistError(`${listFile} is [], which empties the saved list on every client. Pass the clear option only if that is what you mean.`);
    }
    const result = setManifestList(fs.readFileSync(need(args, 'file'), 'utf8'), list);
    fs.writeFileSync(need(args, 'out'), result.text);
    console.log(`status=${result.status}`);
    return 0;
  }

  throw new DenylistError(`Unknown command "${command ?? ''}". Use validate, add-to-manifest or rewrite-manifest.`);
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
