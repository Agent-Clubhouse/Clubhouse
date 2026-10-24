import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ active: true, generation: 1, tc: undefined as string | undefined }));
vi.mock('./facade', () => ({ currentTraceparent: () => state.tc, isTelemetryActive: () => state.active, getRecordingGeneration: () => state.generation }));
import { captureFeedbackCorrelation, rememberAnnexIncidentPhone, rememberAnnexIncidentTrace, _resetFeedbackIncidentForTests } from './feedback-incident';
import { telemetryInstanceId } from './instance';
const phone = '11111111-1111-4111-8111-111111111111';
const connection = '22222222-2222-4222-8222-222222222222';
const tc = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
const now = Date.parse('2026-10-24T12:00:00.000Z');
beforeEach(() => { Object.assign(state, { active: true, generation: 1, tc: undefined }); _resetFeedbackIncidentForTests(); });
describe('feedback incident snapshot', () => {
  it('copies a bounded real phone/host/socket context at opening and freezes all nested references', () => {
    rememberAnnexIncidentPhone('clubhouse-go', phone, connection, now - 2000);
    state.tc = tc;
    rememberAnnexIncidentTrace(now - 1000);
    state.tc = undefined;
    const snapshot = captureFeedbackCorrelation(now);
    expect(snapshot.data.incident).toMatchObject({ phoneInstanceId: phone, hostInstanceIds: [telemetryInstanceId], connectionIds: [connection],
      availability: 'recorded', capturedAt: new Date(now).toISOString(), windowStart: new Date(now - 2000).toISOString() });
    expect(snapshot.data.traceId).toBe(tc.slice(3, 35));
    expect(Object.isFrozen(snapshot.data.incident?.traces[0])).toBe(true);
    expect(Object.isFrozen(snapshot.data.incident?.connectionIds)).toBe(true);
    rememberAnnexIncidentPhone('clubhouse-go', phone, '33333333-3333-4333-8333-333333333333', now + 1);
    expect(snapshot.data.incident?.connectionIds).toEqual([connection]);
  });
  it('never invents a phone for a desktop-only trace, and removes ambiguous multi-phone metadata', () => {
    state.tc = tc;
    expect(captureFeedbackCorrelation(now)).toMatchObject({ summary: { scope: 'trace-only' } });
    rememberAnnexIncidentPhone('clubhouse-go', phone, connection, now);
    rememberAnnexIncidentPhone('clubhouse-go', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', now);
    expect(captureFeedbackCorrelation(now).data.incident).toBeUndefined();
  });
  it('expires recent references and fences off/re-enabled recording generations', () => {
    state.tc = tc;
    rememberAnnexIncidentTrace(now);
    rememberAnnexIncidentPhone('clubhouse-go', phone, connection, now);
    state.tc = undefined;
    expect(captureFeedbackCorrelation(now + 300001).summary).toBeUndefined();
    state.tc = tc;
    rememberAnnexIncidentTrace(now + 300002);
    state.active = false;
    expect(captureFeedbackCorrelation(now + 300003).summary).toBeUndefined();
    state.active = true; state.tc = undefined; state.generation++;
    expect(captureFeedbackCorrelation(now + 300004).summary).toBeUndefined();
  });
  it('rejects non-phone services, malformed/full-string IDs and malformed trace context', () => {
    rememberAnnexIncidentPhone('clubhouse', phone, connection, now);
    rememberAnnexIncidentPhone('clubhouse-go', phone + '\n', connection, now);
    rememberAnnexIncidentPhone('clubhouse-go', phone, 'https://private-host', now);
    state.tc = tc + '\n';
    expect(captureFeedbackCorrelation(now).summary).toBeUndefined();
  });
  it('reports unavailable traces honestly with known phone context and caps recent references', () => {
    rememberAnnexIncidentPhone('clubhouse-go', phone, connection, now);
    expect(captureFeedbackCorrelation(now).data.incident).toMatchObject({ availability: 'unavailable', traces: [] });
    for (let i = 1; i <= 40; i++) {
      state.tc = `00-${i.toString(16).padStart(32, '0')}-${i.toString(16).padStart(16, '0')}-01`;
      rememberAnnexIncidentTrace(now + i);
    }
    expect(captureFeedbackCorrelation(now + 41).data.incident?.traces).toHaveLength(8);
  });
  it('does not claim a unique phone after the bounded peer cache overflows', () => {
    state.tc = tc;
    for (let i = 1; i <= 33; i++) rememberAnnexIncidentPhone('clubhouse-go', phone, `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, now);
    expect(captureFeedbackCorrelation(now)).toMatchObject({ summary: { scope: 'trace-only' } });
    expect(captureFeedbackCorrelation(now).data.incident).toBeUndefined();
  });
});
