import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTR, EVENTS } from '../../shared/telemetry/attributes';
import { setProducingRuntime } from './__test-utils__/producing-runtime';
import { chatResumeResult, recordResumeOutcome, recordSessionCapture, recordStaleSessionCleared } from './session-telemetry';
import type { TelemetryRuntime } from './types';

function producing(level: TelemetryRuntime['level']): ReturnType<typeof vi.fn> {
  const event = vi.fn();
  setProducingRuntime({ level, event } as unknown as TelemetryRuntime);
  return event;
}
afterEach(() => setProducingRuntime(null));

describe('session telemetry (#2305)', () => {
  it('records a capture with enums, the exit code and the agent id for hashing', () => {
    const event = producing('standard');
    recordSessionCapture({ orchestrator: 'codex-cli', agentId: 'a1', runtime: 'pty', result: 'captured', source: 'run_store', exitCode: 0 });
    expect(event).toHaveBeenCalledWith('clubhouse.agent.session_capture', [
      ATTR.orchestrator('codex-cli'), ATTR.agentIdHash('a1'), ATTR.agentRuntime('pty'),
      ATTR.sessionCaptureResult('captured'), ATTR.sessionCaptureSource('run_store'), ATTR.exitCode(0),
    ]);
    expect(ATTR.agentIdHash('a1').kind).toBe('hash');
  });

  it('buckets an unknown orchestrator and omits a missing runtime', () => {
    const event = producing('standard');
    recordResumeOutcome('my-cli', 'a1', 'fresh_user');
    expect(event).toHaveBeenCalledWith('clubhouse.agent.resume_outcome', [
      ATTR.orchestrator('other'), ATTR.agentIdHash('a1'), ATTR.sessionResumeResult('fresh_user'),
    ]);
  });

  it('stale clears are an Errors-level signal; capture and resume are Standard', () => {
    expect(EVENTS['clubhouse.agent.session_stale_cleared'].level).toBe('errors');
    expect(EVENTS['clubhouse.agent.session_capture'].level).toBe('standard');
    expect(EVENTS['clubhouse.agent.resume_outcome'].level).toBe('standard');
    const event = producing('errors');
    recordStaleSessionCleared('copilot-cli', 'a1', 'store_missing');
    recordResumeOutcome('copilot-cli', 'a1', 'fresh_not_found');
    expect(event.mock.calls.map(([name]) => name)).toEqual(['clubhouse.agent.session_stale_cleared']);
  });

  it('records nothing when telemetry is off', () => {
    const event = producing('detailed');
    setProducingRuntime(null);
    recordSessionCapture({ orchestrator: 'claude-code', agentId: 'a1', runtime: 'chat', result: 'kept_previous', source: 'none' });
    recordStaleSessionCleared('claude-code', 'a1', 'exit_early');
    recordResumeOutcome('claude-code', 'a1', 'resumed');
    expect(event).not.toHaveBeenCalled();
  });

  describe('chatResumeResult', () => {
    it.each([
      ['s1', 's1', undefined, 'resumed'],
      // Claude learns its id after the first prompt.
      ['s1', undefined, undefined, 'resumed'],
      ['s1', 's2', 'not_found', 'fresh_not_found'],
      ['s1', 's2', 'stalled', 'fresh_stalled'],
      ['s1', 's2', undefined, 'fresh_other'],
    ] as const)('asked %s, got %s, fallback %s: %s', (requested, native, fallback, result) => {
      expect(chatResumeResult(requested, native, fallback)).toBe(result);
    });
  });
});
