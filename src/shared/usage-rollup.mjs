// Totals from the `core:usage` log lines (docs/usage-attribution.md), for
// scripts/usage-rollup.mjs and the app. Plain ESM with typings beside it
// (usage-rollup.d.mts), so a node script can use it without a build.
//
// Rules:
// - Only `Usage turn` lines are added. `Usage session total` lines are running
//   totals (a resumed session's carries earlier runs) and are counted, never added.
// - A figure a line leaves out is not zero: `missing` counts the turns without it,
//   and a figure no turn of a row (or of the totals) reported is `null`, not 0.
//   A turn with no figures at all is in `turnsWithoutUsage`.
// - A turn is added once per agent, session and turn id, so a log read twice
//   (or a line repeated) doesn't double it. A turn line without a turn id can't
//   be told from a repeat: it is added, and counted in `turnsWithoutId`.
// - `uncachedInput` is input minus cached input, from turns that report both
//   (`null` when none did).
// - An unreadable line (a `null` record) or a usage line without its fields is
//   counted in `malformed`. `noLines` says no turn line was found at all.
// - Days are UTC, from each line's own time.

export const USAGE_ROLLUP_DIMENSIONS = ['day', 'provider', 'driver', 'model', 'effort', 'role', 'agentId', 'parentAgentId', 'source'];
export const USAGE_ROLLUP_FIGURES = ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'];

const NS = 'core:usage';
const TURN = 'Usage turn';
const FINAL = 'Usage session total';

const valid = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const text = (v, fallback) => (typeof v === 'string' && v ? v : fallback);

function emptyTotals() {
  const t = { turns: 0, turnsWithoutUsage: 0, turnsWithoutId: 0, uncachedInput: 0, uncachedTurns: 0, missing: {}, sources: {} };
  for (const k of USAGE_ROLLUP_FIGURES) t[k] = 0;
  return t;
}

const dimensionsOf = (list) => list.filter((d) => USAGE_ROLLUP_DIMENSIONS.includes(d));

function sortRows(rows, groupBy) {
  return [...rows.values()].sort((a, b) => {
    for (const d of groupBy) if (a[d] !== b[d]) return a[d] < b[d] ? -1 : 1;
    return 0;
  });
}

/**
 * Add up `core:usage` turn lines. `records` are parsed log lines (any other
 * line is skipped). `groupBy` picks the dimensions rows are split by (default:
 * day, provider, role, agentId). `alsoGroupBy` asks for more groupings from the
 * same single pass, returned in `also` in order. `since`/`until` are inclusive UTC days.
 */
export function rollupUsage(records, options = {}) {
  const groupBy = dimensionsOf(options.groupBy ?? ['day', 'provider', 'role', 'agentId']);
  const groupings = [groupBy, ...(options.alsoGroupBy ?? []).map(dimensionsOf)];
  const { since, until } = options;
  const rowMaps = groupings.map(() => new Map());
  const seen = new Set();
  const totals = emptyTotals();
  let sessionTotalsSkipped = 0;
  let repeats = 0;
  let malformed = 0;
  for (const r of records) {
    if (r === null) {
      malformed++;
      continue;
    }
    if (typeof r !== 'object' || r.ns !== NS) continue;
    if (r.msg === FINAL) {
      sessionTotalsSkipped++;
      continue;
    }
    if (r.msg !== TURN) continue;
    const m = r.meta;
    const day = typeof r.ts === 'string' ? r.ts.slice(0, 10) : '';
    if (!m || typeof m !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      malformed++;
      continue;
    }
    if ((since && day < since) || (until && day > until)) continue;
    const hasId = typeof m.turnId === 'string' && m.turnId;
    if (hasId) {
      const key = `${m.agentId}\u0000${m.sessionId}\u0000${m.turnId}`;
      if (seen.has(key)) {
        repeats++;
        continue;
      }
      seen.add(key);
    }
    const dims = {
      day,
      provider: text(m.provider, 'unknown'),
      driver: text(m.driver, 'unknown'),
      model: text(m.model, 'unknown'),
      effort: text(m.effort, 'unknown'),
      role: text(m.role, 'unknown'),
      agentId: text(m.agentId, 'unknown'),
      parentAgentId: text(m.parentAgentId, 'none'),
      source: text(m.source, 'unknown'),
    };
    const targets = [totals];
    groupings.forEach((dimsList, i) => {
      const key = JSON.stringify(dimsList.map((d) => dims[d]));
      let row = rowMaps[i].get(key);
      if (!row) {
        row = { ...Object.fromEntries(dimsList.map((d) => [d, dims[d]])), ...emptyTotals() };
        rowMaps[i].set(key, row);
      }
      targets.push(row);
    });
    for (const t of targets) {
      add(t, m, dims.source);
      if (!hasId) t.turnsWithoutId++;
    }
  }
  for (const map of rowMaps) for (const t of map.values()) finish(t);
  finish(totals);
  const [rows, ...also] = rowMaps.map((map, i) => sortRows(map, groupings[i]));
  return { groupBy, rows, also, totals, noLines: totals.turns === 0, sessionTotalsSkipped, repeats, malformed };
}

function add(t, m, source) {
  t.turns++;
  t.sources[source] = (t.sources[source] ?? 0) + 1;
  let reported = false;
  for (const k of USAGE_ROLLUP_FIGURES) {
    if (valid(m[k])) {
      t[k] += m[k];
      reported = true;
    } else {
      t.missing[k] = (t.missing[k] ?? 0) + 1;
    }
  }
  if (!reported) t.turnsWithoutUsage++;
  if (valid(m.input) && valid(m.cachedInput)) {
    t.uncachedInput += Math.max(0, m.input - m.cachedInput);
    t.uncachedTurns++;
  }
}

/** A figure no turn reported is null, not 0; a reported 0 stays 0. */
function finish(t) {
  for (const k of USAGE_ROLLUP_FIGURES) if ((t.missing[k] ?? 0) === t.turns) t[k] = null;
  if (t.uncachedTurns === 0) t.uncachedInput = null;
  delete t.uncachedTurns;
}
