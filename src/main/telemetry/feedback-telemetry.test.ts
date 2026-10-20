import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTR, getAttributeSpec } from '../../shared/telemetry/attributes';
import { setProducingRuntime } from './__test-utils__/producing-runtime';
import {
  feedbackErrorClass,
  recordFeedbackAccess,
  recordFeedbackCaptured,
  recordFeedbackFailed,
  recordFeedbackRefused,
  recordFeedbackSubmitted,
} from './feedback-telemetry';
import type { TelemetryRuntime } from './types';

let rt: TelemetryRuntime;
function install(level: TelemetryRuntime['level']): void {
  rt = { level, event: vi.fn(), count: vi.fn() } as unknown as TelemetryRuntime;
  setProducingRuntime(rt);
}
beforeEach(() => install('standard'));
afterEach(() => setProducingRuntime(null));

const events = () => vi.mocked(rt.event).mock.calls.map(([name, attrs]) => [name, attrs]);

describe('feedback telemetry', () => {
  it('keeps registered error codes and never a message', () => {
    expect(feedbackErrorClass(Object.assign(new Error('Local feedback storage is full'), { code: 'storage-full' }))).toBe('storage-full');
    expect(feedbackErrorClass(Object.assign(new Error('x'), { code: 'EACCES /Users/someone/data' }))).toBe('unknown');
    expect(feedbackErrorClass(new Error('/Users/someone/secret note'))).toBe('unknown');
    expect(feedbackErrorClass(null)).toBe('unknown');
    expect(feedbackErrorClass('capture-failed')).toBe('unknown');
  });

  it('records a capture with booleans and counts only', () => {
    recordFeedbackCaptured({ screenshot: true, shots: 2, windows: 3, trigger: 'shortcut' });
    expect(events()).toEqual([['clubhouse.feedback.captured', [
      ATTR.feedbackScreenshot(true), ATTR.feedbackShots(2), ATTR.feedbackWindows(3), ATTR.feedbackTrigger('shortcut'),
    ]]]);
  });

  it('records a submit with the access state, unknown states as other', () => {
    recordFeedbackSubmitted({ screenshot: true, annotated: true, shots: 1, accessState: 'offline' });
    recordFeedbackSubmitted({ screenshot: false, annotated: false, shots: 0, accessState: 'some-new-state' });
    expect(events()[0]).toEqual(['clubhouse.feedback.submitted', [
      ATTR.feedbackScreenshot(true), ATTR.feedbackAnnotated(true), ATTR.feedbackShots(1), ATTR.feedbackAccessState('offline'),
    ]]);
    expect((events()[1][1] as Array<{ value: unknown }>)[3].value).toBe('other');
  });

  it('records access transitions to settled states only', () => {
    recordFeedbackAccess(null, 'checking', null);
    recordFeedbackAccess('checking', 'connected', null);
    recordFeedbackAccess('connected', 'connecting', null);
    recordFeedbackAccess('connecting', 'access-required', 'access-required');
    expect(events()).toEqual([
      ['clubhouse.feedback.access', [ATTR.feedbackAccessState('connected'), ATTR.feedbackAccessFrom('checking'), ATTR.feedbackNotice('none')]],
      ['clubhouse.feedback.access', [ATTR.feedbackAccessState('access-required'), ATTR.feedbackAccessFrom('connecting'), ATTR.feedbackNotice('access-required')]],
    ]);
  });

  it('records refusals by reason', () => {
    recordFeedbackRefused('unauthorized-caller');
    expect(events()).toEqual([['clubhouse.feedback.request_refused', [ATTR.feedbackRefusal('unauthorized-caller')]]]);
  });

  it('sends only failures at the Errors level', () => {
    install('errors');
    recordFeedbackCaptured({ screenshot: true, shots: 1, windows: 1, trigger: 'button' });
    recordFeedbackAccess('connected', 'offline', null);
    recordFeedbackFailed('deliver', 'undeliverable');
    expect(events()).toEqual([['clubhouse.feedback.failed', [ATTR.feedbackStage('deliver'), ATTR.feedbackError('undeliverable')]]]);
  });

  it('declares no string attribute that could carry a report id or notes', () => {
    const keys = Object.values(ATTR).map((make) => (make as (v: never) => { key: string })('x' as never).key).filter((k) => k.startsWith('clubhouse.feedback.'));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(['enum', 'int', 'bool']).toContain(getAttributeSpec(key)?.kind);
  });
});
