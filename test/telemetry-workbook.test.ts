/**
 * KQL-vs-registry test (telemetry spec §6.10): every span, metric, event and
 * attribute name a Workbook query references must exist in the attribute
 * registry. Renaming an attribute then fails the build instead of silently
 * blanking a chart.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  EVENTS,
  METRICS,
  SDK_ATTRIBUTE_KEYS,
  SPANS,
  allAttributeKeys,
} from '../src/shared/telemetry/attributes';

const WORKBOOK = path.join(__dirname, '..', 'docs', 'telemetry', 'workbook', 'clubhouse.workbook.json');

interface Item {
  type: number;
  name?: string;
  content?: { query?: string; items?: Item[]; parameters?: Array<{ query?: string }> };
}

async function loadWorkbook(): Promise<{ items: Item[] }> {
  return JSON.parse(await fs.promises.readFile(WORKBOOK, 'utf-8'));
}

function collectQueries(items: Item[], out: Array<{ name: string; query: string }> = []) {
  for (const item of items) {
    if (item.content?.query) out.push({ name: item.name ?? '?', query: item.content.query });
    for (const p of item.content?.parameters ?? []) if (p.query) out.push({ name: `${item.name}:param`, query: p.query });
    if (item.content?.items) collectQueries(item.content.items, out);
  }
  return out;
}

const names = new Set<string>([...Object.keys(SPANS), ...Object.keys(METRICS), ...Object.keys(EVENTS)]);
const attributes = new Set<string>([...allAttributeKeys(), ...Object.values(SDK_ATTRIBUTE_KEYS)]);

describe('Clubhouse Workbook', () => {
  it('has the v1 tabs plus Workspace, Plugins and Agents', async () => {
    const wb = await loadWorkbook();
    const groups = wb.items.filter((i) => i.type === 12).map((i) => i.name);
    expect(groups).toEqual(['tab-overview', 'tab-reliability', 'tab-startup', 'tab-integrity', 'tab-workspace', 'tab-plugins', 'tab-agents']);
  });

  it('only queries span, metric and event names that exist in the registry', async () => {
    const queries = collectQueries((await loadWorkbook()).items);
    expect(queries.length).toBeGreaterThan(20);
    const unknown: string[] = [];
    for (const { name, query } of queries) {
      for (const m of query.matchAll(/"(clubhouse\.[a-z0-9_.]+)"/g)) {
        const ref = m[1];
        // A trailing dot is a prefix match (`startswith`): some registered name must extend it.
        const ok = ref.endsWith('.') ? [...names].some((n) => n.startsWith(ref)) : names.has(ref) || attributes.has(ref);
        if (!ok) unknown.push(`${name}: ${ref}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('only reads customDimensions keys that are registered attributes', async () => {
    const queries = collectQueries((await loadWorkbook()).items);
    const unknown: string[] = [];
    for (const { name, query } of queries) {
      for (const m of query.matchAll(/customDimensions\["([^"]+)"\]/g)) {
        if (!attributes.has(m[1])) unknown.push(`${name}: ${m[1]}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('never queries hashed ids or anything outside the allowlist', async () => {
    const all = collectQueries((await loadWorkbook()).items).map((q) => q.query).join('\n');
    expect(all).not.toMatch(/id_hash/);
    expect(all).not.toMatch(/\bmessage\b/);
  });

  it('ships an ARM wrapper and alert rules that match the generator (run scripts/build-workbook-arm.mjs)', async () => {
    const { buildAll } = await import('../scripts/build-workbook-arm.mjs');
    for (const [file, content] of Object.entries(buildAll() as Record<string, string>)) {
      // Windows checkouts may convert to CRLF; the generator writes LF.
      const onDisk = (await fs.promises.readFile(path.join(path.dirname(WORKBOOK), file), 'utf-8')).replace(/\r\n/g, '\n');
      expect(onDisk, file).toBe(content);
    }
    const deploy = JSON.parse(await fs.promises.readFile(path.join(path.dirname(WORKBOOK), 'azuredeploy.json'), 'utf-8'));
    expect(JSON.parse(deploy.resources[0].properties.serializedData)).toEqual(await loadWorkbook());
  });

  it('has an alert rule for every P0 hot spot with signals, and names the rest as pending', async () => {
    const { ALERTS, PENDING_P0 } = await import('../scripts/build-workbook-arm.mjs');
    const covered = new Set((ALERTS as Array<{ hotspot: string }>).map((a) => a.hotspot));
    const pending = Object.keys(PENDING_P0 as Record<string, string>);
    // spec §12.4: P0 flows are H1, H2, H3, H5, H6, H7, H9, the H11 save path and H8's bulletin post.
    expect([...covered, ...pending].sort()).toEqual(['H1', 'H11', 'H2', 'H3', 'H5', 'H6', 'H7', 'H8', 'H9']);
    expect(pending.filter((h) => covered.has(h))).toEqual([]);
  });

  it('alert queries only use registered names and never hashed ids or messages', async () => {
    const { ALERTS } = await import('../scripts/build-workbook-arm.mjs');
    const unknown: string[] = [];
    for (const a of ALERTS as Array<{ id: string; query: string[] }>) {
      const q = a.query.join('\n');
      for (const m of q.matchAll(/"(clubhouse\.[a-z0-9_.]+)"/g)) {
        if (!names.has(m[1]) && !attributes.has(m[1])) unknown.push(`${a.id}: ${m[1]}`);
      }
      for (const m of q.matchAll(/customDimensions\["([^"]+)"\]/g)) {
        if (!attributes.has(m[1])) unknown.push(`${a.id}: ${m[1]}`);
      }
      expect(q).not.toMatch(/id_hash|\bmessage\b/);
    }
    expect(unknown).toEqual([]);
  });
});
