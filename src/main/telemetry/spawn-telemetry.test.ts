import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTR, EVENTS, getAttributeSpec, SPANS, type TelAttr } from '../../shared/telemetry/attributes';
import { passThroughSink, setProducingRuntime } from './__test-utils__/producing-runtime';
import { setLocalSink, setRuntime } from './facade';
import { modelFamily, recordChatStart, recordSpawn, spawnAttrs } from './spawn-telemetry';
import { tagError, type TelemetryRuntime } from './types';

let count: ReturnType<typeof vi.fn>;
let replaySpan: ReturnType<typeof vi.fn>;
beforeEach(() => {
  count = vi.fn();
  replaySpan = vi.fn();
  setProducingRuntime({ level: 'standard', count, replaySpan } as unknown as TelemetryRuntime);
});
afterEach(() => setProducingRuntime(null));

describe('modelFamily', () => {
  it.each([
    [undefined, 'default'],
    ['default', 'default'],
    ['claude-opus-5-5', 'opus'],
    ['sonnet', 'sonnet'],
    ['claude-haiku-5-5', 'haiku'],
    ['gpt-5.1-codex', 'gpt-5'],
    ['my-private-finetune', 'other'],
  ])('%s → %s', (model, family) => {
    expect(modelFamily(model)).toBe(family);
  });
});

describe('recordChatStart', () => {
  let event: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    event = vi.fn();
    setProducingRuntime({ level: 'standard', count, replaySpan, event } as unknown as TelemetryRuntime);
  });

  const ctx = { orchestrator: 'claude-code', resume: false };
  /** Attributes as a key → value map. */
  const bag = (attrs: TelAttr[]) => Object.fromEntries(attrs.map((a) => [a.key, a.value]));
  const spans = () => replaySpan.mock.calls.map((c) => c[0] as { attrs: TelAttr[]; outcome: string; errorType?: string });
  const fallbacks = () => event.mock.calls.map((c) => { expect(c[0]).toBe('clubhouse.chat.fallback'); return bag(c[1] as TelAttr[]); });

  /** Every attribute is registered, and every enum value is in its closed set: no free text. */
  function expectNoFreeText(): void {
    const all = [...spans().flatMap((s) => s.attrs), ...event.mock.calls.flatMap((c) => c[1] as TelAttr[])];
    expect(all.length).toBeGreaterThan(0);
    for (const attr of all) {
      const spec = getAttributeSpec(attr.key);
      expect(spec, attr.key).toBeDefined();
      expect(['enum', 'int', 'bool']).toContain(spec!.kind);
      if (spec!.kind === 'enum') expect(spec!.values, `${attr.key}=${String(attr.value)}`).toContain(attr.value);
    }
  }

  it('records nothing for a spawn that was never chat', () => {
    recordChatStart(undefined, 'terminal', { attempts: [] }, ctx);
    expect(replaySpan).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
  });

  it('records a start on the first driver as chat, with its driver, version verdict and timings', () => {
    recordChatStart(1000, 'chat', {
      attempts: [{ driver: 'claude_agent_sdk', checkMs: 120.4, versionStatus: 'ok', sessionStartMs: 900 }],
    }, ctx, 2100);
    expect(event).not.toHaveBeenCalled();
    const [span] = spans();
    expect(replaySpan.mock.calls[0][0]).toMatchObject({ name: 'clubhouse.chat.start', startMs: 1000, endMs: 2100, outcome: 'ok', errorType: undefined });
    expect(bag(span.attrs)).toEqual({
      'clubhouse.orchestrator': 'claude-code',
      'clubhouse.chat.start.result': 'chat',
      'clubhouse.chat.drivers_tried': 1,
      'clubhouse.chat.check_ms': 120,
      'clubhouse.agent.resume': false,
      'clubhouse.chat.driver': 'claude_agent_sdk',
      'clubhouse.chat.cli_version.status': 'ok',
      'clubhouse.chat.session_start_ms': 900,
    });
    expectNoFreeText();
  });

  it('records chat on a lower driver as fallback, with one fallback event for the driver it left', () => {
    // The Claude SDK init deadline (#2283) fails the start with rpc_timeout.
    recordChatStart(1000, 'chat', {
      attempts: [
        { driver: 'claude_agent_sdk', checkMs: 100, versionStatus: 'ok', reason: 'start_failed', errorCode: 'rpc_timeout', sessionStartMs: 30_000 },
        { driver: 'claude_stream_json', checkMs: 50, versionStatus: 'ok', sessionStartMs: 800 },
      ],
    }, ctx, 33_000);
    expect(fallbacks()).toEqual([{
      'clubhouse.orchestrator': 'claude-code',
      'clubhouse.chat.fallback.to': 'driver',
      'clubhouse.chat.driver': 'claude_agent_sdk',
      'clubhouse.chat.check_ms': 100,
      'clubhouse.chat.start.reason': 'start_failed',
      'error.type': 'rpc_timeout',
      'clubhouse.chat.cli_version.status': 'ok',
      'clubhouse.chat.session_start_ms': 30_000,
    }]);
    expect(bag(spans()[0].attrs)).toMatchObject({
      'clubhouse.chat.start.result': 'fallback',
      'clubhouse.chat.drivers_tried': 2,
      'clubhouse.chat.check_ms': 150,
      'clubhouse.chat.driver': 'claude_stream_json',
    });
    expect(bag(spans()[0].attrs)).not.toHaveProperty('clubhouse.chat.start.reason');
    expect(spans()[0].outcome).toBe('ok');
    expectNoFreeText();
  });

  it('records a fall to the terminal: the last driver goes to the terminal, the span fails with the reason', () => {
    recordChatStart(1000, 'terminal', {
      attempts: [
        { driver: 'claude_agent_sdk', checkMs: 10_000, reason: 'handshake_failed', errorCode: 'rpc_timeout' },
        // #2275: no version could be read, then the start failed after the session was up.
        { driver: 'claude_stream_json', checkMs: 40, versionStatus: 'lookup_failed', reason: 'failed_after_session_start', sessionStartMs: 200 },
      ],
      reason: 'failed_after_session_start',
    }, ctx, 11_000);
    expect(fallbacks().map((f) => [f['clubhouse.chat.driver'], f['clubhouse.chat.fallback.to'], f['clubhouse.chat.start.reason']])).toEqual([
      ['claude_agent_sdk', 'driver', 'handshake_failed'],
      ['claude_stream_json', 'terminal', 'failed_after_session_start'],
    ]);
    expect(fallbacks()[1]['clubhouse.chat.cli_version.status']).toBe('lookup_failed');
    expect(spans()[0]).toMatchObject({ outcome: 'error', errorType: 'chat_start_failed' });
    expect(bag(spans()[0].attrs)).toMatchObject({
      'clubhouse.chat.start.result': 'terminal',
      'clubhouse.chat.start.reason': 'failed_after_session_start',
      'clubhouse.chat.driver': 'claude_stream_json',
    });
    expectNoFreeText();
  });

  it.each([
    ['login_required', 'auth_required'],
    ['version_below_min', undefined],
    ['version_known_bad', undefined],
    ['paused', undefined],
  ] as const)('records a check that sends the agent to the terminal: %s', (reason, errorType) => {
    recordChatStart(1000, 'terminal', {
      attempts: [{ driver: 'copilot_acp', checkMs: 300, reason, ...(errorType && { errorCode: errorType }) }],
      reason,
    }, { orchestrator: 'copilot-cli', resume: false }, 1400);
    const [fallback] = fallbacks();
    expect(fallback).toMatchObject({ 'clubhouse.chat.fallback.to': 'terminal', 'clubhouse.chat.start.reason': reason, 'clubhouse.orchestrator': 'copilot-cli' });
    expect(fallback['error.type']).toBe(errorType);
    expect(bag(spans()[0].attrs)['clubhouse.chat.start.reason']).toBe(reason);
    expectNoFreeText();
  });

  it.each(['no_driver', 'binary_missing'] as const)('records %s as a fallback event without a span (no start began)', (reason) => {
    recordChatStart(undefined, 'terminal', { attempts: [], reason, ...(reason === 'binary_missing' && { preferredDriver: 'codex_app_server' as const }) }, { orchestrator: 'codex-cli', resume: false });
    expect(replaySpan).not.toHaveBeenCalled();
    expect(fallbacks()).toEqual([{
      'clubhouse.orchestrator': 'codex-cli',
      'clubhouse.chat.fallback.to': 'terminal',
      'clubhouse.chat.start.reason': reason,
      ...(reason === 'binary_missing' && { 'clubhouse.chat.driver': 'codex_app_server', 'error.type': 'binary_not_found' }),
    }]);
    expectNoFreeText();
  });

  it.each(['killed', 'superseded'] as const)('records a cancelled start (%s) as cancelled, never a failure or a fallback', (reason) => {
    recordChatStart(1000, 'cancelled', { attempts: [{ driver: 'codex_app_server', checkMs: 80 }], reason }, ctx, 1500);
    expect(event).not.toHaveBeenCalled();
    expect(spans()[0]).toMatchObject({ outcome: 'cancelled', errorType: undefined });
    expect(bag(spans()[0].attrs)).toMatchObject({ 'clubhouse.chat.start.result': 'cancelled', 'clubhouse.chat.start.reason': reason });
    expectNoFreeText();
  });

  it('records a cancel after a failed driver as one fallback to the next driver, never to the terminal', () => {
    recordChatStart(1000, 'cancelled', {
      attempts: [{ driver: 'claude_agent_sdk', checkMs: 5, reason: 'start_failed' }, { driver: 'claude_stream_json', checkMs: 5 }],
      reason: 'superseded',
    }, ctx, 1100);
    expect(fallbacks().map((f) => f['clubhouse.chat.fallback.to'])).toEqual(['driver']);
    expect(bag(spans()[0].attrs)['clubhouse.chat.start.result']).toBe('cancelled');
  });

  it('records a throw after the last driver failed as a fallback to the terminal', () => {
    recordChatStart(1000, 'failed', { attempts: [{ driver: 'codex_app_server', checkMs: 5, reason: 'start_failed' }], reason: 'error' }, ctx, 1100);
    expect(fallbacks().map((f) => f['clubhouse.chat.fallback.to'])).toEqual(['terminal']);
  });

  it('records a start that threw as failed', () => {
    recordChatStart(1000, 'failed', { attempts: [], reason: 'error' }, ctx, 1100);
    expect(event).not.toHaveBeenCalled();
    expect(spans()[0]).toMatchObject({ outcome: 'error', errorType: 'chat_start_failed' });
    expect(bag(spans()[0].attrs)).toMatchObject({ 'clubhouse.chat.start.result': 'failed', 'clubhouse.chat.start.reason': 'error', 'clubhouse.chat.drivers_tried': 0 });
    expectNoFreeText();
  });

  it('records the resume: whether it was honored and the load timings of a stalled Copilot resume (#2296)', () => {
    recordChatStart(1000, 'chat', {
      attempts: [{ driver: 'copilot_acp', checkMs: 400, versionStatus: 'untested', sessionStartMs: 21_000 }],
      resumeHonored: false,
      resumeTiming: { loadMs: 20_001.6 },
    }, { orchestrator: 'copilot-cli', resume: true }, 22_000);
    expect(bag(spans()[0].attrs)).toMatchObject({
      'clubhouse.agent.resume': true,
      'clubhouse.chat.resume_honored': false,
      'clubhouse.chat.resume.load_ms': 20_002,
    });
    expect(bag(spans()[0].attrs)).not.toHaveProperty('clubhouse.chat.resume.first_reply_ms');
    replaySpan.mockClear();
    recordChatStart(1000, 'chat', {
      attempts: [{ driver: 'copilot_acp', checkMs: 400 }],
      resumeHonored: true,
      resumeTiming: { loadMs: 6300, firstReplyMs: 1600 },
    }, { orchestrator: 'copilot-cli', resume: true }, 9000);
    expect(bag(spans()[0].attrs)).toMatchObject({ 'clubhouse.chat.resume_honored': true, 'clubhouse.chat.resume.first_reply_ms': 1600 });
    expectNoFreeText();
  });

  it('drops an error code that is not a registered error.type, so no message text gets through', () => {
    recordChatStart(1000, 'terminal', {
      attempts: [{ driver: 'acp', checkMs: 1, reason: 'start_failed', errorCode: 'Error: ENOTFOUND api.example.com /Users/me/secret' }],
      reason: 'start_failed',
    }, ctx, 1001);
    expect(fallbacks()[0]).not.toHaveProperty('error.type');
    expectNoFreeText();
  });

  it('produces the same items with export on or off (parity), at the Standard level', () => {
    const facts = { attempts: [{ driver: 'claude_agent_sdk' as const, checkMs: 5, reason: 'handshake_failed' as const }], reason: 'handshake_failed' as const };
    const local = { ...passThroughSink('standard'), event: vi.fn(), replaySpan: vi.fn() };
    // Export off: local recording alone.
    setProducingRuntime(null);
    setLocalSink(local);
    recordChatStart(1000, 'terminal', facts, ctx, 1100);
    const offEvents = local.event.mock.calls.map((c) => c.slice(0, 2));
    const offSpans = local.replaySpan.mock.calls.map((c) => c[0]);
    expect(offEvents).toHaveLength(1);
    expect(offSpans).toHaveLength(1);
    // Export on: the same local items, and the exporter gets the same ones.
    local.event.mockClear();
    local.replaySpan.mockClear();
    setRuntime({ level: 'standard', count, replaySpan, event } as unknown as TelemetryRuntime);
    recordChatStart(1000, 'terminal', facts, ctx, 1100);
    expect(local.event.mock.calls.map((c) => c.slice(0, 2))).toEqual(offEvents);
    expect(local.replaySpan.mock.calls.map((c) => c[0])).toEqual(offSpans);
    expect(event.mock.calls.map((c) => c.slice(0, 2))).toEqual(offEvents);
    expect(replaySpan.mock.calls.map((c) => c[0])).toEqual(offSpans);
    // Standard items: the recorder drops both at the Errors level, local or exported.
    expect(EVENTS['clubhouse.chat.fallback'].level).toBe('standard');
    expect(SPANS['clubhouse.chat.start'].level).toBe('standard');
  });
});

describe('recordSpawn', () => {
  it('counts a success with its duration', () => {
    recordSpawn('durable', { runtime: 'pty', orchestrator: 'codex-cli' }, 1000, undefined, 3500);
    const dims = [ATTR.agentKind('durable'), ATTR.orchestrator('codex-cli'), ATTR.agentRuntime('pty')];
    expect(count).toHaveBeenCalledWith('clubhouse.agent.spawns', 1, [...dims, ATTR.outcome('ok')]);
    expect(count).toHaveBeenCalledWith('clubhouse.agent.spawn.duration', 2.5, dims);
  });

  it('counts a failure by its tagged error type, and a headless spawn without a PID as headless_no_pid', () => {
    recordSpawn('quick', { runtime: 'pty' }, 0, tagError(new Error('x'), 'cwd_invalid'));
    recordSpawn('quick', { runtime: 'headless', noPid: true }, 0, undefined);
    recordSpawn('quick', { runtime: 'pty' }, 0, new Error('untagged'));
    const types = count.mock.calls.filter((c) => c[0] === 'clubhouse.agent.spawns').map((c) => c[2].at(-1));
    expect(types).toEqual([ATTR.errorType('cwd_invalid'), ATTR.errorType('headless_no_pid'), ATTR.errorType('unknown')]);
    expect(count.mock.calls.some((c) => c[0] === 'clubhouse.agent.spawn.duration')).toBe(false);
  });

  it('only attaches the facts a spawn learned', () => {
    expect(spawnAttrs({ runtime: 'chat', orchestrator: 'weird', model: 'opus' })).toEqual([
      ATTR.orchestrator('other'), ATTR.modelFamily('opus'), ATTR.agentRuntime('chat'),
    ]);
    expect(spawnAttrs({})).toEqual([ATTR.orchestrator('other'), ATTR.modelFamily('default')]);
  });
});
