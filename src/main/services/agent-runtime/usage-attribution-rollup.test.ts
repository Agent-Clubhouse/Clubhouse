/** The logger's own lines, as the local recorder writes them, add up in the rollup (S1 of docs/usage-attribution.md). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../dispatcher/dispatcher-service', () => ({ isDispatcherIdentityAgentId: () => false }));
vi.mock('../app-event-sources', () => ({ knownAgent: () => undefined }));
vi.mock('../project-store', () => ({ list: async () => [], projectPathKey: (p: string) => p, onProjectsChanged: () => () => {} }));

import type { ChatEvent } from '../../../shared/chat';
import { rollupUsage } from '../../../shared/usage-rollup.mjs';
// @ts-expect-error -- plain .mjs script, no types
import { usageRecords } from '../../../../scripts/usage-rollup.mjs';
import { _resetUsageAttributionForTesting, _setUsageAttributionDepsForTesting, logUsageChatEvent } from './usage-attribution-log';

let tmp: string;
let seq = 0;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-rollup-'));
  _resetUsageAttributionForTesting();
});
afterEach(() => {
  _resetUsageAttributionForTesting();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function emit(type: string, data: unknown, turnId?: string): void {
  logUsageChatEvent({ v: 1, agentId: 'h1', sessionId: 's1', seq: ++seq, ts: seq, type, data, ...(turnId && { turnId }) } as unknown as ChatEvent);
}

describe('usage log to rollup', () => {
  it('sums the turns a resumed session logged, without its lifetime total', () => {
    const file = path.join(tmp, 'telemetry-2026-11-24T10-00-00.000.jsonl');
    const out: string[] = [JSON.stringify({ t: 'signal', name: 'other' })];
    _setUsageAttributionDepsForTesting({
      agentInfo: () => ({ role: 'helper', parentAgentId: 'orch' }),
      // As the local recorder writes a diag line.
      log: (msg, meta) => out.push(JSON.stringify({ t: 'diag', ts: '2026-11-24T10:00:00.000Z', ns: 'core:usage', level: 'info', msg, meta })),
      now: () => 0,
    });
    emit('session_started', { driver: 'codex_app_server', provider: 'codex-cli', cwd: '/w', resumed: true, capabilities: {} });
    for (const [id, input] of [['t1', 100], ['t2', 50]] as const) {
      emit('turn_started', { trigger: 'prompt' }, id);
      emit('usage', { scope: 'session', threadId: 'th', tokens: { input: 10_000 + input, output: 10 } }, id);
      emit('turn_ended', { stopReason: 'end_turn', usage: { input, cachedInput: input / 2, output: 1 } }, id);
    }
    emit('session_ended', { reason: 'stopped' });
    fs.writeFileSync(file, `${out.join('\n')}\n`);

    const result = rollupUsage(usageRecords([file]), { groupBy: ['provider', 'role', 'parentAgentId', 'source'] });
    expect(result.rows).toEqual([expect.objectContaining({ provider: 'codex-cli', role: 'helper', parentAgentId: 'orch', source: 'cumulative_delta', turns: 2, input: 150, cachedInput: 75, output: 2 })]);
    expect(result.sessionTotalsSkipped).toBe(1);
  });
});
