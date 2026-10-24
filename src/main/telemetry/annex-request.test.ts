import { EventEmitter } from 'events';
import type { ServerResponse } from 'http';
import { describe, it, expect, vi } from 'vitest';
vi.mock('./facade', () => ({ currentTraceparent: () => '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' }));
import { traceHttpResponse } from './annex-request';
function response() {
  return Object.assign(new EventEmitter(), { setHeader: vi.fn(), headersSent: false, writableFinished: false, destroyed: false });
}
describe('Annex HTTP trace lifetime', () => {
  it.each(['finish', 'close'])('waits for callback-based responses until %s', async (event) => {
    const res = response(); let complete = false;
    const pending = traceHttpResponse(res as unknown as ServerResponse, async () => {}).then(() => { complete = true; });
    await Promise.resolve();
    expect(complete).toBe(false);
    expect(res.setHeader).toHaveBeenCalledWith('traceparent', expect.stringMatching(/^00-/));
    res.emit(event); await pending;
    expect(res.listenerCount('finish') + res.listenerCount('close')).toBe(0);
  });
  it('cleans listeners and preserves handler failures', async () => {
    const res = response();
    await expect(traceHttpResponse(res as unknown as ServerResponse, async () => { throw new Error('failure'); })).rejects.toThrow('failure');
    expect(res.listenerCount('finish') + res.listenerCount('close')).toBe(0);
  });
});
