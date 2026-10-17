import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortPending, setRuntime } from './facade';
import { blueprintTransfer, popoutOpened, settingsChanged, themeChanged } from './feature-events';
import { byteSizeBucket, classifyFetchError } from './workspace';
import type { TelemetryRuntime } from './types';

const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];

function runtime(): TelemetryRuntime {
  return {
    level: 'standard',
    event: (name: string, attrs: Array<{ key: string; value: unknown }> = []) =>
      events.push({ name, attrs: Object.fromEntries(attrs.map((a) => [a.key, a.value])) }),
    flow: vi.fn(), step: vi.fn(), count: vi.fn(), exception: vi.fn(), replaySpan: vi.fn(), replayTree: vi.fn(),
    preview: () => [], recentExports: () => [], forceFlush: async () => {}, shutdown: async () => {},
  } as unknown as TelemetryRuntime;
}

afterEach(() => {
  events.length = 0;
  setRuntime(null);
  abortPending();
});

describe('feature events', () => {
  it('sends the settings key only', () => {
    setRuntime(runtime());
    settingsChanged('editor');
    expect(events).toEqual([{ name: 'clubhouse.settings.changed', attrs: { 'clubhouse.settings.key': 'editor' } }]);
  });

  it('names built-in themes and hides plugin theme ids', () => {
    setRuntime(runtime());
    themeChanged('dracula');
    themeChanged('acme-corp-secret-theme');
    expect(events.filter((e) => e.name === 'clubhouse.theme.changed').map((e) => e.attrs)).toEqual([
      { 'clubhouse.theme.kind': 'builtin', 'clubhouse.theme.builtin_id': 'dracula' },
      { 'clubhouse.theme.kind': 'plugin', 'clubhouse.theme.builtin_id': 'other' },
    ]);
    expect(JSON.stringify(events)).not.toContain('acme');
  });

  it('records popouts and blueprint transfers', () => {
    setRuntime(runtime());
    popoutOpened('canvas');
    blueprintTransfer('exported', true);
    blueprintTransfer('imported', false);
    expect(events).toEqual([
      { name: 'clubhouse.popout.opened', attrs: { 'clubhouse.popout.type': 'canvas' } },
      { name: 'clubhouse.blueprint.exported', attrs: { 'clubhouse.outcome': 'ok' } },
      { name: 'clubhouse.blueprint.imported', attrs: { 'clubhouse.outcome': 'error' } },
    ]);
  });

  it('is silent while telemetry is off', () => {
    settingsChanged('mcp');
    expect(events).toEqual([]);
  });
});

describe('marketplace classifiers', () => {
  it('classifies fetch failures', () => {
    expect(classifyFetchError(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(classifyFetchError(new SyntaxError('Unexpected token <'))).toBe('invalid_json');
    expect(classifyFetchError(new Error('Failed to fetch custom registry "Acme": 404 Not Found'))).toBe('http_4xx');
    expect(classifyFetchError(new Error('Failed to fetch registry: 503 Service Unavailable'))).toBe('http_5xx');
    expect(classifyFetchError(new TypeError('fetch failed'))).toBe('network');
  });

  it('buckets download sizes', () => {
    expect([0, 500, 50_000, 500_000, 5_000_000, 50_000_000, 500_000_000].map(byteSizeBucket)).toEqual([
      '0', '<1KB', '<100KB', '<1MB', '<10MB', '<100MB', '>=100MB',
    ]);
  });
});
