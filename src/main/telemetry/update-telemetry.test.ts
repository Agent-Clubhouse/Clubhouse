import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { ATTR } from '../../shared/telemetry/attributes';
import { setProducingRuntime } from './__test-utils__/producing-runtime';
import { classifyUpdateError, recordApplyVerification, recordUpdateApply, recordUpdateCheck, recordUpdateDownload } from './update-telemetry';
import type { TelemetryRuntime } from './types';

function fakeRuntime(): TelemetryRuntime {
  return {
    level: 'standard', flow: vi.fn(), step: vi.fn(), count: vi.fn(), event: vi.fn(), exception: vi.fn(),
    replaySpan: vi.fn(), replayTree: vi.fn(), preview: () => [], forceFlush: vi.fn(async () => {}), shutdown: vi.fn(async () => {}),
  };
}

let rt: TelemetryRuntime;
beforeEach(() => {
  rt = fakeRuntime();
  setProducingRuntime(rt);
});
afterEach(() => setProducingRuntime(null));

describe('classifyUpdateError', () => {
  it.each([
    [new Error('SHA-256 checksum verification failed'), 'integrity_mismatch'],
    [new Error('Too many redirects'), 'redirect_blocked'],
    [new Error('HTTP 404 for manifest'), 'http_4xx'],
    [new Error('HTTP 503'), 'http_5xx'],
    [new Error('Both stable and preview manifests unavailable'), 'manifests_unavailable'],
    [new Error('Unexpected token < in JSON'), 'manifest_invalid'],
    [Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 'network_transient'],
    [new Error('Request timed out'), 'timeout'],
    ['weird', 'unknown'],
  ])('%s → %s', (err, expected) => {
    expect(classifyUpdateError(err)).toBe(expected);
  });
});

describe('update records', () => {
  it('records a check span and counter, plus a failure when it errors', () => {
    recordUpdateCheck({ startMs: Date.now() - 50, trigger: 'periodic', preview: true, result: 'failed', error: new Error('HTTP 500') });
    expect(rt.replaySpan).toHaveBeenCalledWith(expect.objectContaining({ name: 'clubhouse.update.check', outcome: 'error', errorType: 'http_5xx' }));
    expect(rt.count).toHaveBeenCalledWith('clubhouse.update.checks', 1, [ATTR.updateResult('failed'), ATTR.updateChannel('preview'), ATTR.updateTrigger('periodic')]);
    expect(rt.count).toHaveBeenCalledWith('clubhouse.update.failures', 1, [ATTR.updatePhase('check'), ATTR.errorType('http_5xx')]);
  });

  it('records download duration only for real downloads', () => {
    recordUpdateDownload({ startMs: Date.now() - 2000, result: 'already_downloaded' });
    expect(rt.count).not.toHaveBeenCalledWith('clubhouse.update.download.duration', expect.anything(), undefined);
    recordUpdateDownload({ startMs: Date.now() - 2000, result: 'downloaded' });
    expect(rt.count).toHaveBeenCalledWith('clubhouse.update.download.duration', expect.any(Number), undefined);
  });

  it('treats an unclassifiable apply failure as apply_failed', () => {
    recordUpdateApply({ startMs: Date.now(), mode: 'on_quit', ok: false, error: 'boom' });
    expect(rt.count).toHaveBeenCalledWith('clubhouse.update.failures', 1, [ATTR.updatePhase('apply_on_quit'), ATTR.errorType('apply_failed')]);
  });

  it('skips install-kind detection entirely while telemetry is off', async () => {
    setProducingRuntime(null);
    await recordApplyVerification(true);
    expect(rt.event).not.toHaveBeenCalled();
  });

  it('reports whether the last applied update took, with the install kind', async () => {
    await recordApplyVerification(false);
    expect(rt.event).toHaveBeenCalledWith('clubhouse.update.apply_verified', [ATTR.applyVerified('not_taken'), ATTR.installKind('dev')]);
  });
});
