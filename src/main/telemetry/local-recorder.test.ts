import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { ATTR, type TelAttr } from '../../shared/telemetry/attributes';
import { createLocalRecorder, LOCAL_FORMAT_VERSION, type LocalRecorder, type LocalRecorderOptions } from './local-recorder';
import { createScrubber } from './scrubber';
import { tagError } from './types';

const SALT = Buffer.alloc(32, 7);
const HOME = '/Users/sam-tester';

interface Harness {
  rec: LocalRecorder;
  files: Map<string, string>;
  /** Every written record, in write order. */
  records: () => Array<Record<string, any>>;
  raw: () => string;
}

const recorders: LocalRecorder[] = [];

function harness(overrides: Partial<LocalRecorderOptions> = {}): Harness {
  const files = new Map<string, string>();
  const rec = createLocalRecorder({
    dir: '/logs',
    fileBase: 'run',
    level: 'standard',
    hashSalt: SALT,
    scrub: createScrubber({ homeDir: HOME, username: 'sam-tester', hostname: 'sams-laptop' }),
    session: { appVersion: '1.2.3', platform: 'darwin', arch: 'arm64' },
    flushIntervalMs: 60_000,
    appendFile: async (file, data) => {
      files.set(file, (files.get(file) ?? '') + data);
    },
    mkdir: async () => {},
    ...overrides,
  });
  recorders.push(rec);
  const raw = () => [...files.values()].join('');
  const records = () => raw().trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { rec, files, records, raw };
}

afterEach(async () => {
  for (const r of recorders.splice(0)) await r.stop();
});

const ok = (attrs: TelAttr[] = []) => ({ set: vi.fn(), attrs });

describe('local telemetry recorder', () => {
  it('starts each file with a versioned session line', async () => {
    const h = harness();
    await h.rec.flush();
    expect(h.records()[0]).toMatchObject({ t: 'session', v: LOCAL_FORMAT_VERSION, appVersion: '1.2.3', platform: 'darwin', level: 'standard' });
    expect([...h.files.keys()]).toEqual([path.join('/logs', 'telemetry-run.jsonl')]);
  });

  it('records flows and steps with durations, outcomes and parent links', async () => {
    let t = 1_000;
    const h = harness({ now: () => t });
    const outer = ok();
    const result = h.rec.wrap('clubhouse.agent.spawn', { attrs: [ATTR.orchestrator('claude-code')] }, (span) => {
      span.set(ATTR.outcome('ok'));
      t += 40;
      return h.rec.wrap('clubhouse.provider.resolve', {}, () => {
        t += 10;
        return 'done';
      })(ok());
    })(outer);
    expect(result).toBe('done');
    // The handle passed in (the SDK's, when exporting) still receives every attribute.
    expect(outer.set).toHaveBeenCalledWith(ATTR.outcome('ok'));
    await h.rec.flush();
    const spans = h.records().filter((r) => r.t === 'span');
    const step = spans.find((s) => s.name === 'clubhouse.provider.resolve')!;
    const flow = spans.find((s) => s.name === 'clubhouse.agent.spawn')!;
    expect(flow).toMatchObject({ startMs: 1_000, durationMs: 50, outcome: 'ok', attrs: { 'clubhouse.orchestrator': 'claude-code' } });
    expect(flow.parentSpanId).toBeUndefined();
    expect(step).toMatchObject({ durationMs: 10, outcome: 'ok', traceId: flow.traceId, parentSpanId: flow.spanId });
    expect(flow.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(flow.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps async flow context, classification and cancellation', async () => {
    const h = harness();
    const ids: unknown[] = [];
    await h.rec.wrap('clubhouse.agent.spawn', {}, async () => {
      await Promise.resolve();
      ids.push(h.rec.activeTraceIds());
      return { exitCode: 1 };
    }, { classify: () => ({ error: 'timeout' }) })(ok());
    const ac = new AbortController();
    const p = h.rec.wrap('clubhouse.agent.run', { signal: ac.signal }, async () => {
      ac.abort();
      throw new Error('aborted');
    })(ok());
    await expect(p).rejects.toThrow('aborted');
    await h.rec.flush();
    const spans = h.records().filter((r) => r.t === 'span');
    expect(spans[0]).toMatchObject({ name: 'clubhouse.agent.spawn', outcome: 'error', errorType: 'timeout' });
    expect(ids[0]).toMatchObject({ traceId: spans[0].traceId, spanId: spans[0].spanId });
    expect(spans[1]).toMatchObject({ name: 'clubhouse.agent.run', outcome: 'cancelled' });
    expect(h.rec.activeTraceIds()).toBeUndefined();
  });

  it('records a thrown error as an error span plus a message-free, scrubbed exception', async () => {
    const h = harness();
    const err = tagError(new Error(`secret prompt text in ${HOME}/project/notes.md`), 'spawn_failed');
    err.stack = `Error: secret prompt text\n    at spawnAgent (${HOME}/src/Clubhouse/agent-system.ts:98:7)\n    at C:\\Users\\sam-tester\\app\\main.js:1:2`;
    expect(() => h.rec.wrap('clubhouse.agent.spawn', {}, () => {
      throw err;
    })(ok())).toThrow(err);
    await h.rec.flush();
    const [span] = h.records().filter((r) => r.t === 'span');
    const [ex] = h.records().filter((r) => r.t === 'exception');
    expect(span).toMatchObject({ outcome: 'error', errorType: 'spawn_failed' });
    expect(ex).toMatchObject({
      type: 'Error',
      traceId: span.traceId,
      spanId: span.spanId,
      attrs: { 'clubhouse.exception.origin': 'main', 'clubhouse.exception.handled': false },
    });
    expect(ex.stack).toBe('at spawnAgent (agent-system.ts:98:7)\nat main.js:1:2');
    const raw = h.raw();
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('sam-tester');
    expect(raw).not.toContain('/Users');
    expect(raw).not.toContain('notes.md');
  });

  it('applies the registry: unknown keys dropped, enums bounded, ids hashed', async () => {
    const h = harness();
    h.rec.event('clubhouse.telemetry.test', [
      ATTR.agentIdHash('agent-raw-id'),
      ATTR.orchestrator('not-a-real-cli' as never),
      { key: 'user.home', kind: 'enum', value: HOME } as TelAttr,
    ], { severity: 'warn' });
    await h.rec.flush();
    const [ev] = h.records().filter((r) => r.t === 'event');
    expect(ev).toMatchObject({ name: 'clubhouse.telemetry.test', severity: 'warn' });
    expect(ev.attrs['clubhouse.agent.id_hash']).toMatch(/^[0-9a-f]{16}$/);
    expect(ev.attrs['clubhouse.orchestrator']).toBe('other');
    expect(ev.attrs['user.home']).toBeUndefined();
    expect(h.raw()).not.toContain('agent-raw-id');
    expect(ev.traceId).toBeUndefined();
  });

  it('skips Detailed-only spans at its Standard level', async () => {
    const h = harness();
    expect(h.rec.wrap('clubhouse.ipc.invoke', {}, () => 1)(ok())).toBe(1);
    await h.rec.flush();
    expect(h.records().some((r) => r.t === 'span')).toBe(false);
  });

  it('aggregates metrics per interval instead of writing each call', async () => {
    let t = 0;
    const h = harness({ now: () => t });
    for (let i = 0; i < 1_000; i++) h.rec.count('clubhouse.app.sessions', 1, [ATTR.startupKind('cold')]);
    h.rec.count('clubhouse.app.startup.duration', 2);
    h.rec.count('clubhouse.app.startup.duration', 5);
    h.rec.count('clubhouse.process.eventloop.delay.p99', 0.1);
    h.rec.count('clubhouse.process.eventloop.delay.p99', 0.3);
    // A dimension the metric doesn't declare is dropped, like the SDK's views.
    h.rec.count('clubhouse.app.sessions', 1, [ATTR.startupKind('cold'), ATTR.agentIdHash('a')]);
    t = 60_000;
    await h.rec.flush();
    const metrics = h.records().filter((r) => r.t === 'metric');
    expect(metrics).toHaveLength(3);
    expect(metrics.find((m) => m.name === 'clubhouse.app.sessions')).toMatchObject({
      kind: 'counter', sum: 1_001, attrs: { 'clubhouse.startup.kind': 'cold' }, startMs: 0, durationMs: 60_000,
    });
    expect(metrics.find((m) => m.name === 'clubhouse.app.startup.duration')).toMatchObject({ kind: 'histogram', unit: 's', count: 2, sum: 7, min: 2, max: 5 });
    expect(metrics.find((m) => m.name === 'clubhouse.process.eventloop.delay.p99')).toMatchObject({ kind: 'gauge', value: 0.3 });
  });

  it('rotates to a new chunk at the chunk size and stops at the session cap', async () => {
    const h = harness({ maxChunkBytes: 400, maxSessionBytes: 1_500 });
    for (let i = 0; i < 40; i++) h.rec.event('clubhouse.telemetry.test');
    await h.rec.flush();
    const names = [...h.files.keys()];
    expect(names[0]).toBe(path.join('/logs', 'telemetry-run.jsonl'));
    expect(names[1]).toBe(path.join('/logs', 'telemetry-run.1.jsonl'));
    for (const [, data] of h.files) {
      // A chunk only passes its limit by the capped marker.
      expect(Buffer.byteLength(data.replace(/\{"t":"capped".*\n/, ''))).toBeLessThanOrEqual(400);
    }
    const records = h.records();
    expect(records[records.length - 1]).toMatchObject({ t: 'capped', maxBytes: 1_500 });
    const before = h.raw().length;
    h.rec.event('clubhouse.telemetry.test');
    await h.rec.flush();
    expect(h.raw().length).toBe(before);
  });

  it('caps queued lines and per-run record counts, and reports drops on stop', async () => {
    const h = harness({ maxPendingLines: 1_000, sessionCaps: { traces: 2, logs: 3 } });
    for (let i = 0; i < 5; i++) h.rec.wrap('clubhouse.agent.spawn', {}, () => i)(ok());
    for (let i = 0; i < 5; i++) h.rec.event('clubhouse.telemetry.test');
    await h.rec.stop();
    const records = h.records();
    expect(records.filter((r) => r.t === 'span')).toHaveLength(2);
    expect(records.filter((r) => r.t === 'event')).toHaveLength(3);
    expect(records[records.length - 1]).toMatchObject({ t: 'dropped', traces: 3, logs: 2, lines: 0 });
  });

  it('drops lines past the pending limit rather than growing memory', async () => {
    const append = vi.fn(async () => {});
    const h = harness({ maxPendingLines: 5, appendFile: append });
    // The session line plus four events fill the queue; the rest are dropped.
    for (let i = 0; i < 3; i++) h.rec.event('clubhouse.telemetry.test');
    expect(append).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) h.rec.event('clubhouse.telemetry.test');
    await h.rec.flush();
    const written = append.mock.calls.map((c) => (c as unknown as [string, string])[1]).join('');
    const lines = written.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.t !== 'dropped')).toHaveLength(5);
    expect(lines[lines.length - 1]).toMatchObject({ t: 'dropped', lines: 2 });
  });

  it('records replayed spans and trees with the root as parent', async () => {
    const h = harness();
    h.rec.replayTree({
      root: { name: 'clubhouse.app.startup', startMs: 0, endMs: 900, attrs: [ATTR.startupKind('cold')], outcome: 'ok' },
      children: [{ name: 'clubhouse.app.startup.main_ready', startMs: 0, endMs: 300, attrs: [], outcome: 'ok' }],
    });
    h.rec.replaySpan({ name: 'clubhouse.agent.run', startMs: 10, endMs: 30, attrs: [], outcome: 'error', errorType: 'timeout' });
    await h.rec.flush();
    const spans = h.records().filter((r) => r.t === 'span');
    const root = spans.find((s) => s.name === 'clubhouse.app.startup')!;
    expect(spans.find((s) => s.name === 'clubhouse.app.startup.main_ready')).toMatchObject({ parentSpanId: root.spanId, traceId: root.traceId, durationMs: 300 });
    expect(spans.find((s) => s.name === 'clubhouse.agent.run')).toMatchObject({ durationMs: 20, outcome: 'error', errorType: 'timeout' });
  });

  it('reports drops on every flush, not only on stop, as deltas', async () => {
    const h = harness({ sessionCaps: { traces: 50_000, logs: 1 } });
    h.rec.event('clubhouse.telemetry.test');
    h.rec.event('clubhouse.telemetry.test');
    await h.rec.flush();
    h.rec.event('clubhouse.telemetry.test');
    await h.rec.flush();
    expect(h.records().filter((r) => r.t === 'dropped')).toEqual([
      expect.objectContaining({ logs: 1, traces: 0, lines: 0 }),
      expect.objectContaining({ logs: 1 }),
    ]);
  });

  it('writes a whole metric window even past the pending line limit', async () => {
    const h = harness({ maxPendingLines: 5 });
    for (let i = 0; i < 20; i++) h.rec.count('clubhouse.app.startup.duration', i, [ATTR.startupKind(i % 2 ? 'cold' : 'after_update')]);
    for (let i = 0; i < 20; i++) h.rec.count('clubhouse.app.sessions', 1, [ATTR.startupKind('cold')]);
    h.rec.count('clubhouse.process.eventloop.delay.p99', 1);
    h.rec.count('clubhouse.process.eventloop.delay.max', 1);
    await h.rec.flush();
    expect(h.records().filter((r) => r.t === 'metric')).toHaveLength(5);
  });

  it('survives out-of-range times from a renderer', async () => {
    const h = harness();
    expect(() => h.rec.replaySpan({ name: 'clubhouse.agent.kill', startMs: 9e15, endMs: 9e15, attrs: [], outcome: 'ok' })).not.toThrow();
    await h.rec.flush();
    expect(h.records().find((r) => r.t === 'span')?.ts).toMatch(/^\d{4}-/);
  });

  it('never throws when the disk write fails', async () => {
    const h = harness({ appendFile: async () => {
      throw new Error('EACCES');
    } });
    h.rec.event('clubhouse.telemetry.test');
    await expect(h.rec.flush()).resolves.toBeUndefined();
    await expect(h.rec.stop()).resolves.toBeUndefined();
  });

  it('stops recording after stop()', async () => {
    const h = harness();
    await h.rec.stop();
    const before = h.raw();
    h.rec.event('clubhouse.telemetry.test');
    expect(h.rec.wrap('clubhouse.agent.spawn', {}, () => 3)(ok())).toBe(3);
    await h.rec.flush();
    expect(h.raw()).toBe(before);
  });
});
