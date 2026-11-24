#!/usr/bin/env node
// Totals of what each agent used, from the `core:usage` lines in the local
// log folder (~/.clubhouse/logs/telemetry-*.jsonl). Every provider an agent
// ran in chat; see docs/usage-attribution.md for what is and isn't covered.
// Reads only those lines' numbers and ids.
//
//   node scripts/usage-rollup.mjs                              # by day, provider, role, agent
//   node scripts/usage-rollup.mjs --by provider,role --since 2026-11-24
//   node scripts/usage-rollup.mjs --dir <log folder> --json

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollupUsage, USAGE_ROLLUP_DIMENSIONS } from '../src/shared/usage-rollup.mjs';
import { readLines } from './codex-usage-summary.mjs';

/** Parsed `core:usage` lines from the log files, skipping everything else unparsed. */
export function* usageRecords(files, read = readLines) {
  for (const file of files) {
    for (const line of read(file)) {
      if (!line.includes('"core:usage"')) continue;
      try {
        yield JSON.parse(line);
      } catch {
        yield null;
      }
    }
  }
}

function logFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^telemetry-.*\.jsonl$/.test(n)).sort().map((n) => path.join(dir, n));
}

const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const dir = arg('--dir') ?? path.join(os.homedir(), '.clubhouse', 'logs');
  const by = arg('--by')?.split(',').map((s) => s.trim());
  const bad = by?.filter((d) => !USAGE_ROLLUP_DIMENSIONS.includes(d)) ?? [];
  if (bad.length > 0) {
    console.error(`Unknown --by ${bad.join(', ')}. Choose from: ${USAGE_ROLLUP_DIMENSIONS.join(', ')}`);
    process.exit(2);
  }
  const files = logFiles(dir);
  const result = rollupUsage(usageRecords(files), { groupBy: by, since: arg('--since'), until: arg('--until') });
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ files: files.length, ...result }, null, 2)}\n`);
    return;
  }
  if (result.totals.turns === 0) {
    console.log(`No usage turn lines in ${files.length} log files. They are written by builds with usage attribution, while Settings › Logging is on with core:usage at info or lower.`);
    return;
  }
  console.log(`${files.length} log files; ${result.totals.turns} turns (${result.totals.turnsWithoutUsage} reported no usage); ${result.sessionTotalsSkipped} session totals not added; ${result.repeats} repeated turns skipped`);
  console.log([...result.groupBy, 'turns', 'no usage', 'uncached in', 'cached in', 'output', 'reasoning', 'sources', 'missing'].join('\t'));
  for (const r of result.rows) {
    const sources = Object.entries(r.sources).map(([k, n]) => `${k}:${n}`).join(',');
    const missing = Object.entries(r.missing).map(([k, n]) => `${k}:${n}`).join(',') || '-';
    console.log([...result.groupBy.map((d) => r[d]), r.turns, r.turnsWithoutUsage, fmt(r.uncachedInput), fmt(r.cachedInput), fmt(r.output), fmt(r.reasoning), sources, missing].join('\t'));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
