#!/usr/bin/env node
// Summarizes local Codex token use per agent, UTC day, model and effort, from
// the rollout files Codex writes under ~/.codex/sessions. Metadata only: it
// reads session_meta (id, cwd, subagent parent), turn_context (model, effort)
// and token_usage_record lines, and never prints message text, tool input or
// output, instructions or paths beyond the agent's folder name.
//
//   node scripts/codex-usage-summary.mjs                       # every day found
//   node scripts/codex-usage-summary.mjs --since 2026-11-17 --until 2026-11-23
//   node scripts/codex-usage-summary.mjs --dir <sessions dir> --json
//
// How it counts:
// - Each token_usage_record is one model response, counted once by its
//   response_id across every file. A record without one is counted and
//   reported as unkeyed.
// - The record's own `usage` is used, never the thread or turn running totals,
//   so a resumed thread (Codex appends to the same file) and a forked subagent
//   thread (its own file, starting from zero) can't be counted twice.
// - A figure a record leaves out is not zero: it is counted in `missing`.
// - The day is the record's own timestamp (UTC), not the file's start day.
// - `uncachedInput` is input minus cached input; cached is reported apart.
//   Raw tokens are never converted to plan or limit percentages.
// - Cross-check: the positive differences of each file's token_count running
//   totals. It runs a little under the records (some responses get no
//   token_count after them), and is reported, not used.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIGURES = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];

/** The agent a rollout belongs to, from its working folder: its Clubhouse agent folder name, or the folder's own name. */
export function agentLabel(cwd) {
  if (typeof cwd !== 'string' || !cwd) return '(unknown)';
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const at = parts.lastIndexOf('agents');
  if (at > 0 && parts[at - 1] === '.clubhouse' && parts[at + 1]) return parts[at + 1];
  // The Dispatcher's two agents work in ~/.clubhouse/dispatcher and ~/.clubhouse/dispatcher-chat.
  const at2 = parts.lastIndexOf('.clubhouse');
  if (at2 !== -1 && /^dispatcher(-chat)?$/.test(parts[at2 + 1] ?? '')) return 'Dispatcher';
  return parts[parts.length - 1] ?? '(unknown)';
}

function emptyTotals() {
  const t = { responses: 0, uncachedInput: 0, missing: {} };
  for (const k of FIGURES) t[k] = 0;
  return t;
}

/**
 * Summarize rollout files. `files` is [{ name, lines: Iterable<string> }].
 * Returns { rows, crossCheck, unkeyed, duplicates, unparsable }.
 */
export function summarizeRollouts(files, { since, until } = {}) {
  const rows = new Map();
  const seen = new Set();
  let unkeyed = 0;
  let duplicates = 0;
  let unparsable = 0;
  const crossCheck = { records: 0, tokenCountDiffs: 0, resets: 0 };
  for (const file of files) {
    let label;
    let subagent = false;
    const turns = new Map();
    let lastTotal;
    for (const line of file.lines) {
      if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_usage_record"') && !line.includes('"token_count"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        unparsable++;
        continue;
      }
      const p = o && typeof o.payload === 'object' && o.payload ? o.payload : {};
      if (o.type === 'session_meta') {
        // A forked subagent's file repeats its parent's meta after its own: the first is the file's.
        if (label === undefined) {
          label = agentLabel(p.cwd);
          subagent = typeof p.source === 'object' && p.source !== null && 'subagent' in p.source;
        }
        continue;
      }
      if (o.type === 'turn_context') {
        if (typeof p.turn_id === 'string') turns.set(p.turn_id, { model: p.model, effort: p.effort });
        continue;
      }
      const day = typeof o.timestamp === 'string' ? o.timestamp.slice(0, 10) : '(no date)';
      const inRange = (!since || day >= since) && (!until || day <= until);
      if (o.type === 'event_msg' && p.type === 'token_count') {
        const total = p.info?.total_token_usage?.total_tokens;
        if (typeof total !== 'number') continue;
        if (lastTotal !== undefined && total < lastTotal) crossCheck.resets++;
        else if (inRange) crossCheck.tokenCountDiffs += total - (lastTotal ?? 0);
        lastTotal = total;
        continue;
      }
      if (o.type !== 'token_usage_record') continue;
      const id = p.response_id;
      if (typeof id === 'string' && id) {
        if (seen.has(id)) {
          duplicates++;
          continue;
        }
        seen.add(id);
      } else {
        unkeyed++;
      }
      if (!inRange) continue;
      const turn = turns.get(p.turn_id) ?? {};
      const agent = `${label ?? '(unknown)'}${subagent ? ' (subagent)' : ''}`;
      const model = typeof turn.model === 'string' ? turn.model : '(unknown)';
      const effort = typeof turn.effort === 'string' ? turn.effort : '(none)';
      const key = JSON.stringify([day, agent, model, effort]);
      let row = rows.get(key);
      if (!row) rows.set(key, (row = { day, agent, model, effort, ...emptyTotals() }));
      row.responses++;
      const usage = p.usage && typeof p.usage === 'object' ? p.usage : {};
      for (const k of FIGURES) {
        const v = usage[k];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) row[k] += v;
        else row.missing[k] = (row.missing[k] ?? 0) + 1;
      }
      if (typeof usage.input_tokens === 'number' && typeof usage.cached_input_tokens === 'number') {
        row.uncachedInput += Math.max(0, usage.input_tokens - usage.cached_input_tokens);
      }
      if (typeof usage.total_tokens === 'number') crossCheck.records += usage.total_tokens;
    }
  }
  const sorted = [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || b.total_tokens - a.total_tokens);
  return { rows: sorted, crossCheck, unkeyed, duplicates, unparsable };
}

/** A file's lines, read in chunks: a long-running thread's rollout can pass 1 GB. */
export function* readLines(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    let rest = Buffer.alloc(0);
    for (let n = fs.readSync(fd, chunk); n > 0; n = fs.readSync(fd, chunk)) {
      const buf = Buffer.concat([rest, chunk.subarray(0, n)]);
      let start = 0;
      for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, start)) {
        yield buf.toString('utf-8', start, i);
        start = i + 1;
      }
      rest = Buffer.from(buf.subarray(start));
    }
    if (rest.length > 0) yield rest.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

function rolloutFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path.join(entry.parentPath ?? entry.path, entry.name));
  }
  return out.sort();
}

const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const dir = arg('--dir') ?? path.join(os.homedir(), '.codex', 'sessions');
  const paths = rolloutFiles(dir);
  const result = summarizeRollouts(paths.map((p) => ({ name: p, lines: readLines(p) })), { since: arg('--since'), until: arg('--until') });
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ files: paths.length, ...result }, null, 2)}\n`);
    return;
  }
  console.log(`${paths.length} rollout files; ${result.duplicates} repeated response ids skipped; ${result.unkeyed} records without a response id; ${result.unparsable} unreadable lines`);
  console.log(['day', 'agent', 'model', 'effort', 'responses', 'uncached in', 'cached in', 'output', 'reasoning', 'total', 'missing'].join('\t'));
  for (const r of result.rows) {
    const missing = Object.entries(r.missing).map(([k, n]) => `${k}:${n}`).join(',') || '-';
    console.log([r.day, r.agent, r.model, r.effort, r.responses, fmt(r.uncachedInput), fmt(r.cached_input_tokens), fmt(r.output_tokens), fmt(r.reasoning_output_tokens), fmt(r.total_tokens), missing].join('\t'));
  }
  const { records, tokenCountDiffs, resets } = result.crossCheck;
  console.log(`cross-check: records ${fmt(records)} total, token_count differences ${fmt(tokenCountDiffs)}, running-total resets ${resets}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
