import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log-settings', () => ({ getSettings: vi.fn() }));

import * as logSettings from './log-settings';
import { appLog, flush } from './log-service';
import { ATTR } from '../../shared/telemetry/attributes';
import { abortPending } from '../telemetry/facade';
import { setProducingRuntime } from '../telemetry/__test-utils__/producing-runtime';
import { LOG_LEVEL_SEVERITY } from '../telemetry/log-bridge';
import type { TelemetryRuntime } from '../telemetry/types';
import { _resetDiagForTests, setDiagSink, type DiagRecord } from '../telemetry/diag';

const events: Array<{ name: string; attrs: unknown; severity?: string }> = [];

function runtime(): TelemetryRuntime {
  return {
    level: 'standard',
    event: (name: string, attrs: unknown, opts?: { severity?: string }) => events.push({ name, attrs, severity: opts?.severity }),
    activeTraceIds: () => undefined,
    flow: vi.fn(), step: vi.fn(), count: vi.fn(), exception: vi.fn(), replaySpan: vi.fn(), replayTree: vi.fn(),
    preview: () => [], recentExports: () => [], forceFlush: async () => {}, shutdown: async () => {},
  } as unknown as TelemetryRuntime;
}

const diagLines: DiagRecord[] = [];

beforeEach(async () => {
  await flush();
  vi.clearAllMocks();
  events.length = 0;
  diagLines.length = 0;
  _resetDiagForTests();
  setDiagSink({ writeDiag: (r) => diagLines.push(r), noteDiagDropped: vi.fn(), flush: async () => {}, flushSync: vi.fn() });
  vi.mocked(logSettings.getSettings).mockReturnValue({ enabled: true, namespaces: {}, retention: 'medium', minLogLevel: 'info' });
});
afterEach(() => {
  _resetDiagForTests();
  setProducingRuntime(null);
  abortPending();
});

describe('appLog telemetry bridge', () => {
  it('exports only the declared event and attributes, never the message or meta', () => {
    setProducingRuntime(runtime());
    appLog('core:config-pipeline', 'error', 'Failed to restore /Users/alice/repo/.claude/settings.json', {
      meta: { filePath: '/Users/alice/repo/.claude/settings.json', error: 'EACCES' },
      telemetry: { event: 'clubhouse.config.restore_failed', attrs: [ATTR.configFormat('json')] },
    });
    expect(events).toEqual([{ name: 'clubhouse.config.restore_failed', attrs: [ATTR.configFormat('json')], severity: 'error' }]);
    expect(JSON.stringify(events)).not.toMatch(/alice|EACCES|Failed to restore/);
  });

  it('does not export appLog calls without a telemetry field', () => {
    setProducingRuntime(runtime());
    appLog('core:x', 'error', 'boom', { meta: { a: 1 } });
    expect(events).toEqual([]);
  });

  it('maps levels to severity and never exports debug', () => {
    setProducingRuntime(runtime());
    for (const level of ['debug', 'info', 'warn', 'error', 'fatal'] as const) {
      appLog('core:x', level, 'm', { telemetry: { event: 'clubhouse.annex.heartbeat_timeout' } });
    }
    expect(events.map((e) => e.severity)).toEqual(['info', 'warn', 'error', 'fatal']);
    expect(LOG_LEVEL_SEVERITY.debug).toBeNull();
  });

  it('bridges even when local logging is off, and the local filters are unchanged', () => {
    setProducingRuntime(runtime());
    vi.mocked(logSettings.getSettings).mockReturnValue({ enabled: false, namespaces: {}, retention: 'medium', minLogLevel: 'info' });
    appLog('core:annex-client', 'warn', 'Heartbeat pong timeout', { telemetry: { event: 'clubhouse.annex.heartbeat_timeout' } });
    expect(events).toHaveLength(1);
    expect(diagLines).toEqual([]);
  });

  it('is a no-op for telemetry while it is off', () => {
    appLog('core:x', 'error', 'm', { telemetry: { event: 'clubhouse.annex.heartbeat_timeout' } });
    expect(events).toEqual([]);
  });
});
