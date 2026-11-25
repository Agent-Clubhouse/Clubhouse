import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../telemetry/local-control', () => ({ getLogDir: () => '/nonexistent-log-dir' }));
vi.mock('./log-settings', () => ({ getSettings: () => ({ enabled: true, namespaces: {}, minLogLevel: 'info' }) }));
vi.mock('./provider-quota', () => ({ readProviderQuota: vi.fn() }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { readUsageSummary } from './usage-summary';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-summary-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const line = (meta: Record<string, unknown>, ts = '2026-11-24T10:00:00.000Z') => JSON.stringify({ t: 'diag', ts, ns: 'core:usage', level: 'info', msg: 'Usage turn', meta });
const quota = { state: 'known' as const, source: 'cli_query' as const, asOf: null, limitingWindow: 'weekly' as const, weekly: { usedPercent: 40, resetsAt: null } };

describe('readUsageSummary', () => {
  it('lists every provider, reads limits only where they can be read, and totals usage by provider and role', async () => {
    fs.writeFileSync(path.join(dir, 'telemetry-a.jsonl'), [
      JSON.stringify({ t: 'signal', name: 'other' }),
      line({ agentId: 'a', sessionId: 's', turnId: 't1', provider: 'codex-cli', role: 'helper', input: 100, cachedInput: 90, output: 5 }),
      line({ agentId: 'b', sessionId: 's', turnId: 't1', provider: 'claude-code', role: 'dispatcher', input: 10, output: 1 }),
      line({ agentId: 'c', sessionId: 's', turnId: 't1', provider: 'future-cli', role: 'agent', input: 1, output: 1 }),
      line({ agentId: 'a', sessionId: 's', turnId: 'old', provider: 'codex-cli', role: 'helper', input: 999 }, '2026-11-20T10:00:00.000Z'),
      '{"ns":"core:usage" broken',
    ].join('\n') + '\n');
    const readQuota = vi.fn(async () => quota);
    const summary = await readUsageSummary(1, { dir, now: NOW, readQuota, linesRecorded: true });

    expect(summary.since).toBe('2026-11-24');
    expect(summary.noLines).toBe(false);
    const byId = Object.fromEntries(summary.providers.map((p) => [p.id, p]));
    expect(Object.keys(byId)).toEqual(expect.arrayContaining(['claude-code', 'codex-cli', 'copilot-cli']));
    // Limits are read only for providers with a reader; Copilot's are unknown.
    expect(byId['copilot-cli']).toMatchObject({ quotaKind: 'unknown' });
    expect(byId['copilot-cli'].quota).toBeUndefined();
    expect(readQuota).not.toHaveBeenCalledWith('copilot-cli');
    expect(byId['codex-cli']).toMatchObject({ quotaKind: 'reader', quota, usage: { turns: 1, input: 100, cachedInput: 90, output: 5, reasoning: null } });
    expect(byId['copilot-cli'].usage).toBeUndefined();
    expect(summary.otherProviders).toEqual([expect.objectContaining({ provider: 'future-cli', input: 1 })]);
    expect(summary.roles.map((r) => r.role)).toEqual(['agent', 'dispatcher', 'helper']);
  });

  it('says there are no lines, not zero use, and whether lines are being recorded', async () => {
    const summary = await readUsageSummary(7, { dir, now: NOW, readQuota: vi.fn(async () => quota), linesRecorded: false });
    expect(summary).toMatchObject({ days: 7, since: '2026-11-18', noLines: true, linesRecorded: false, roles: [], otherProviders: [] });
    expect(summary.providers.every((p) => p.usage === undefined)).toBe(true);
  });

  it('a quota read that fails leaves the limit unknown', async () => {
    const summary = await readUsageSummary(1, { dir, now: NOW, readQuota: vi.fn(async () => { throw new Error('boom'); }), linesRecorded: true });
    expect(summary.providers.find((p) => p.id === 'claude-code')?.quota).toBeUndefined();
  });
});
