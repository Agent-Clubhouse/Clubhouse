import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', () => ({ mkdir: vi.fn(), stat: vi.fn(), appendFile: vi.fn(), readdir: vi.fn(), unlink: vi.fn() }));
vi.mock('./log-settings', () => ({ getSettings: vi.fn() }));

import * as fsp from 'fs/promises';
import * as logSettings from './log-settings';
import { appLog, flush } from './log-service';
import { ATTR } from '../../shared/telemetry/attributes';
import { abortPending, setRuntime } from '../telemetry/facade';
import { LOG_LEVEL_SEVERITY } from '../telemetry/log-bridge';
import type { TelemetryRuntime } from '../telemetry/types';

const events: Array<{ name: string; attrs: unknown; severity?: string }> = [];
let traceIds: { traceId: string; spanId: string } | undefined;

function runtime(): TelemetryRuntime {
  return {
    level: 'standard',
    event: (name: string, attrs: unknown, opts?: { severity?: string }) => events.push({ name, attrs, severity: opts?.severity }),
    activeTraceIds: () => traceIds,
    flow: vi.fn(), step: vi.fn(), count: vi.fn(), exception: vi.fn(), replaySpan: vi.fn(), replayTree: vi.fn(),
    preview: () => [], recentExports: () => [], forceFlush: async () => {}, shutdown: async () => {},
  } as unknown as TelemetryRuntime;
}

async function writtenLines(): Promise<Array<Record<string, unknown>>> {
  await flush();
  return vi.mocked(fsp.appendFile).mock.calls
    .flatMap((c) => String(c[1]).split('\n').filter(Boolean))
    .map((l) => JSON.parse(l));
}

beforeEach(async () => {
  await flush();
  vi.clearAllMocks();
  events.length = 0;
  traceIds = undefined;
  vi.mocked(logSettings.getSettings).mockReturnValue({ enabled: true, namespaces: {}, retention: 'medium', minLogLevel: 'info' });
});
afterEach(() => {
  setRuntime(null);
  abortPending();
});

describe('appLog telemetry bridge', () => {
  it('exports only the declared event and attributes, never the message or meta', () => {
    setRuntime(runtime());
    appLog('core:config-pipeline', 'error', 'Failed to restore /Users/alice/repo/.claude/settings.json', {
      meta: { filePath: '/Users/alice/repo/.claude/settings.json', error: 'EACCES' },
      telemetry: { event: 'clubhouse.config.restore_failed', attrs: [ATTR.configFormat('json')] },
    });
    expect(events).toEqual([{ name: 'clubhouse.config.restore_failed', attrs: [ATTR.configFormat('json')], severity: 'error' }]);
    expect(JSON.stringify(events)).not.toMatch(/alice|EACCES|Failed to restore/);
  });

  it('does not export appLog calls without a telemetry field', () => {
    setRuntime(runtime());
    appLog('core:x', 'error', 'boom', { meta: { a: 1 } });
    expect(events).toEqual([]);
  });

  it('maps levels to severity and never exports debug', () => {
    setRuntime(runtime());
    for (const level of ['debug', 'info', 'warn', 'error', 'fatal'] as const) {
      appLog('core:x', level, 'm', { telemetry: { event: 'clubhouse.annex.heartbeat_timeout' } });
    }
    expect(events.map((e) => e.severity)).toEqual(['info', 'warn', 'error', 'fatal']);
    expect(LOG_LEVEL_SEVERITY.debug).toBeNull();
  });

  it('bridges even when local logging is off, and the local filters are unchanged', async () => {
    setRuntime(runtime());
    vi.mocked(logSettings.getSettings).mockReturnValue({ enabled: false, namespaces: {}, retention: 'medium', minLogLevel: 'info' });
    appLog('core:annex-client', 'warn', 'Heartbeat pong timeout', { telemetry: { event: 'clubhouse.annex.heartbeat_timeout' } });
    expect(events).toHaveLength(1);
    expect(await writtenLines()).toEqual([]);
  });

  it('adds traceId/spanId to the local JSONL line only while a span is active', async () => {
    setRuntime(runtime());
    appLog('core:x', 'info', 'no span');
    traceIds = { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331' };
    appLog('core:x', 'info', 'in span');
    const lines = await writtenLines();
    expect(lines[0]).not.toHaveProperty('traceId');
    expect(lines[1]).toMatchObject({ msg: 'in span', traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331' });
  });

  it('is a no-op for telemetry while it is off', async () => {
    appLog('core:x', 'error', 'm', { telemetry: { event: 'clubhouse.annex.heartbeat_timeout' } });
    expect(events).toEqual([]);
    expect((await writtenLines())[0]).not.toHaveProperty('traceId');
  });
});
