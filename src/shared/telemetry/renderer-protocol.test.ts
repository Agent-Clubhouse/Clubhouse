import { describe, expect, it } from 'vitest';
import { ATTR } from './attributes';
import { DIAG_MAX_STRING_CHARS } from './diag';
import {
  MAX_BATCH_ITEMS,
  MAX_RENDERER_DIAG_META_BYTES,
  MAX_RENDERER_STACK_CHARS,
  RENDERER_PROTOCOL_VERSION,
  parseAttr,
  parseRendererBatch,
  parseTelemetryState,
} from './renderer-protocol';

const batch = (items: unknown[]) => ({ v: RENDERER_PROTOCOL_VERSION, items });

describe('parseAttr', () => {
  it('keeps registered attributes that match their kind', () => {
    expect(parseAttr(ATTR.view('canvas'))).toEqual({ key: 'clubhouse.view', kind: 'enum', value: 'canvas' });
    expect(parseAttr({ key: 'process.exit.code', value: 3.7 })).toEqual({ key: 'process.exit.code', kind: 'int', value: 3 });
    expect(parseAttr({ key: 'clubhouse.exception.handled', value: true })?.value).toBe(true);
  });

  it('drops unknown keys, wrong kinds and enum values outside the set', () => {
    expect(parseAttr({ key: 'cwd', value: '/Users/someone/repo' })).toBeUndefined();
    expect(parseAttr({ key: 'clubhouse.view', value: '/Users/someone' })).toBeUndefined();
    expect(parseAttr({ key: 'clubhouse.view', value: 'other-ish' })).toBeUndefined();
    expect(parseAttr({ key: 'process.exit.code', value: 'nope' })).toBeUndefined();
    expect(parseAttr({ key: 'clubhouse.exception.handled', value: 'true' })).toBeUndefined();
    expect(parseAttr(null)).toBeUndefined();
  });

  it('uses the registered kind, not the one the renderer claims', () => {
    expect(parseAttr({ key: 'clubhouse.view', kind: 'hash', value: 'canvas' })?.kind).toBe('enum');
  });

  it('only accepts version strings for version attributes', () => {
    expect(parseAttr({ key: 'clubhouse.update.from_version', value: '0.43.0-beta.2' })).toBeDefined();
    expect(parseAttr({ key: 'clubhouse.update.from_version', value: '/tmp/x' })).toBeUndefined();
  });
});

describe('parseRendererBatch', () => {
  it('rejects anything that is not a v1 batch', () => {
    expect(parseRendererBatch(undefined)).toEqual([]);
    expect(parseRendererBatch({ v: 2, items: [] })).toEqual([]);
    expect(parseRendererBatch({ v: 1, items: 'x' })).toEqual([]);
  });

  it('parses known spans, metrics and events and drops unknown names', () => {
    const items = parseRendererBatch(batch([
      { t: 'span', name: 'clubhouse.renderer.unresponsive', startMs: 1000, endMs: 1500, attrs: [], outcome: 'ok' },
      { t: 'span', name: 'clubhouse.made.up', startMs: 1, endMs: 2, attrs: [] },
      { t: 'count', name: 'clubhouse.renderer.long_frames', value: 3, attrs: [ATTR.view('terminal')] },
      { t: 'count', name: 'clubhouse.nope', value: 1, attrs: [] },
      { t: 'event', name: 'clubhouse.renderer.gone', attrs: [] },
      { t: 'unknown' },
    ]));
    expect(items.map((i) => i.t)).toEqual(['span', 'count', 'event']);
  });

  it('rejects negative or day-long spans and negative counts', () => {
    expect(parseRendererBatch(batch([
      { t: 'span', name: 'clubhouse.renderer.unresponsive', startMs: 10, endMs: 5, attrs: [] },
      { t: 'span', name: 'clubhouse.renderer.unresponsive', startMs: 0, endMs: 25 * 3600 * 1000, attrs: [] },
      { t: 'count', name: 'clubhouse.renderer.long_frames', value: -1, attrs: [] },
    ]))).toEqual([]);
  });

  it('never lets a renderer forge an exception record as a plain event', () => {
    expect(parseRendererBatch(batch([{ t: 'event', name: 'clubhouse.exception', attrs: [] }]))).toEqual([]);
  });

  it('keeps only a safe type name and a capped stack for exceptions', () => {
    const [item] = parseRendererBatch(batch([
      { t: 'exception', errorType: 'TypeError: secret /Users/x', stack: 'x'.repeat(MAX_RENDERER_STACK_CHARS + 50), handled: true, attrs: [] },
    ]));
    expect(item).toMatchObject({ t: 'exception', errorType: 'Error', origin: 'renderer', handled: true });
    expect(item.t === 'exception' && item.stack?.length).toBe(MAX_RENDERER_STACK_CHARS);
  });

  it('caps the batch size', () => {
    const many = Array.from({ length: MAX_BATCH_ITEMS + 20 }, () => ({ t: 'event', name: 'clubhouse.renderer.gone', attrs: [] }));
    expect(parseRendererBatch(batch(many))).toHaveLength(MAX_BATCH_ITEMS);
  });

  it('drops invalid error types and outcomes on spans', () => {
    const [item] = parseRendererBatch(batch([
      { t: 'span', name: 'clubhouse.renderer.unresponsive', startMs: 1, endMs: 2, attrs: [], outcome: 'weird', errorType: 'not_a_type' },
    ]));
    expect(item).toMatchObject({ outcome: 'ok' });
    expect(item.t === 'span' && item.errorType).toBeUndefined();
  });
});

describe('renderer diag items (#2299)', () => {
  it('keeps a valid namespace, level and message, and plain meta', () => {
    expect(parseRendererBatch(batch([
      { t: 'diag', ns: 'ui:perf', level: 'warn', msg: 'slow', meta: { maxMs: 900 } },
      { t: 'diag', ns: 'plugin:com.example/hub', level: 'debug', msg: 'x' },
    ]))).toEqual([
      { t: 'diag', ns: 'ui:perf', level: 'warn', msg: 'slow', meta: { maxMs: 900 } },
      { t: 'diag', ns: 'plugin:com.example/hub', level: 'debug', msg: 'x' },
    ]);
  });

  it('drops bad namespaces, levels and messages', () => {
    expect(parseRendererBatch(batch([
      { t: 'diag', ns: '', level: 'info', msg: 'x' },
      { t: 'diag', ns: 'has space', level: 'info', msg: 'x' },
      { t: 'diag', ns: 'a'.repeat(200), level: 'info', msg: 'x' },
      { t: 'diag', ns: ':leading', level: 'info', msg: 'x' },
      { t: 'diag', ns: 'core:x', level: 'trace', msg: 'x' },
      { t: 'diag', ns: 'core:x', level: 'info', msg: 42 },
    ]))).toEqual([]);
  });

  it('caps the message and drops oversized or non-object meta', () => {
    const [long, big, arr] = parseRendererBatch(batch([
      { t: 'diag', ns: 'core:x', level: 'info', msg: 'm'.repeat(DIAG_MAX_STRING_CHARS * 3) },
      { t: 'diag', ns: 'core:x', level: 'info', msg: 'big', meta: { s: 'x'.repeat(MAX_RENDERER_DIAG_META_BYTES) } },
      { t: 'diag', ns: 'core:x', level: 'info', msg: 'arr', meta: [1, 2] },
    ]));
    // Slack for main's redaction, which cuts to DIAG_MAX_STRING_CHARS after.
    expect((long as { msg: string }).msg).toHaveLength(DIAG_MAX_STRING_CHARS * 2);
    expect(big).toEqual({ t: 'diag', ns: 'core:x', level: 'info', msg: 'big' });
    expect(arr).toEqual({ t: 'diag', ns: 'core:x', level: 'info', msg: 'arr' });
  });
});

describe('parseTelemetryState', () => {
  it('defaults to disabled', () => {
    expect(parseTelemetryState(undefined)).toEqual({ enabled: false, level: null });
    expect(parseTelemetryState({ enabled: true, level: 'loud' })).toEqual({ enabled: false, level: null });
  });

  it('accepts a valid enabled state', () => {
    expect(parseTelemetryState({ enabled: true, level: 'detailed' })).toEqual({ enabled: true, level: 'detailed' });
  });

  it('keeps the diag flag with or without signals', () => {
    expect(parseTelemetryState({ enabled: false, level: null, diag: true })).toEqual({ enabled: false, level: null, diag: true });
    expect(parseTelemetryState({ enabled: true, level: 'standard', producers: true, diag: true })).toEqual({ enabled: true, level: 'standard', producers: true, diag: true });
    expect(parseTelemetryState({ enabled: false, level: null, diag: 'yes' })).toEqual({ enabled: false, level: null });
  });
});
