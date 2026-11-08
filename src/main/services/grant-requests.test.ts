import { afterEach, describe, expect, it, vi } from 'vitest';
import { GRANT_REQUEST_TTL_MS, MAX_PENDING_GRANT_REQUESTS_PER_AGENT } from '../../shared/grant-requests';
import {
  callKey, consumeCallApproval, dropGrantRequestsFor, listGrantRequests, onGrantRequestsChanged,
  peekGrantRequest, recordGrantRequest, takeGrantRequest, _resetGrantRequestsForTesting,
} from './grant-requests';

const base = { kind: 'call' as const, agentId: 'a1', agentName: 'Ada', projectPath: '/p', actions: ['settings.app.write' as const], where: 'the app', toolName: 'set_helper_presets' };

afterEach(() => {
  vi.useRealTimers();
  _resetGrantRequestsForTesting();
});

describe('permission requests (#2970)', () => {
  it('records a request, and the same call from the same agent reuses it', () => {
    const changes: string[] = [];
    onGrantRequestsChanged((c) => changes.push(c.kind));
    const key = callKey('a1', 'set_helper_presets', { revision: 'r1', reset: {} });
    const first = recordGrantRequest(key, base, 1000);
    expect(first).toMatchObject({ ok: true, reused: false, request: { agentId: 'a1', createdAt: new Date(1000).toISOString(), expiresAt: new Date(1000 + GRANT_REQUEST_TTL_MS).toISOString() } });
    // Argument order doesn't make another call.
    const again = recordGrantRequest(callKey('a1', 'set_helper_presets', { reset: {}, revision: 'r1' }), base, 2000);
    expect(again).toMatchObject({ ok: true, reused: true });
    expect(listGrantRequests(2000)).toHaveLength(1);
    expect(changes).toEqual(['added']);
  });

  it('caps the requests one agent has waiting', () => {
    for (let i = 0; i < MAX_PENDING_GRANT_REQUESTS_PER_AGENT; i++) expect(recordGrantRequest(`k${i}`, base, 0).ok).toBe(true);
    expect(recordGrantRequest('more', base, 0)).toEqual({ ok: false, reason: 'too_many', waiting: MAX_PENDING_GRANT_REQUESTS_PER_AGENT });
    expect(recordGrantRequest('other', { ...base, agentId: 'a2' }, 0).ok).toBe(true);
  });

  it('expires after 24 hours, and says so', () => {
    vi.useFakeTimers({ now: 0 });
    const closed: string[][] = [];
    onGrantRequestsChanged((c) => { if (c.kind === 'closed') closed.push(c.requestIds); });
    const r = recordGrantRequest('k', base, 0);
    if (!r.ok) throw new Error('not recorded');
    vi.advanceTimersByTime(GRANT_REQUEST_TTL_MS - 1);
    expect(listGrantRequests(Date.now())).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(closed).toEqual([[r.request.requestId]]);
    expect(peekGrantRequest(r.request.requestId, Date.now())).toBeNull();
  });

  it('an allowed call becomes a one-time approval; a declined one doesn\'t', () => {
    const key = callKey('a1', 't', { x: 1 });
    const r = recordGrantRequest(key, base, 0);
    if (!r.ok) throw new Error('not recorded');
    expect(takeGrantRequest(r.request.requestId, true, 10)).toMatchObject({ requestId: r.request.requestId });
    expect(takeGrantRequest(r.request.requestId, true, 10)).toBeNull();
    expect(consumeCallApproval(key, 20)).toBe(true);
    expect(consumeCallApproval(key, 20)).toBe(false);

    const declined = recordGrantRequest(key, base, 0);
    if (!declined.ok) throw new Error('not recorded');
    takeGrantRequest(declined.request.requestId, false, 10);
    expect(consumeCallApproval(key, 20)).toBe(false);
  });

  it('an approval lapses when its request would have expired', () => {
    const key = callKey('a1', 't', {});
    const r = recordGrantRequest(key, base, 0);
    if (!r.ok) throw new Error('not recorded');
    takeGrantRequest(r.request.requestId, true, 10);
    expect(consumeCallApproval(key, GRANT_REQUEST_TTL_MS + 1)).toBe(false);
  });

  it('an allowed permission request leaves no call approval', () => {
    const r = recordGrantRequest('grant-key', { ...base, kind: 'grant' }, 0);
    if (!r.ok) throw new Error('not recorded');
    takeGrantRequest(r.request.requestId, true, 10);
    expect(consumeCallApproval('grant-key', 20)).toBe(false);
  });

  it('drops an agent\'s requests and approvals', () => {
    const key = callKey('a1', 't', {});
    const r = recordGrantRequest(key, base, 0);
    if (!r.ok) throw new Error('not recorded');
    takeGrantRequest(r.request.requestId, true, 10);
    recordGrantRequest('k2', base, 0);
    recordGrantRequest('k3', { ...base, agentId: 'a2' }, 0);
    expect(dropGrantRequestsFor('a1')).toHaveLength(1);
    expect(consumeCallApproval(key, 20)).toBe(false);
    expect(listGrantRequests(20).map((x) => x.agentId)).toEqual(['a2']);
  });
});
