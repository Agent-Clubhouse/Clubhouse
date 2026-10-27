import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDisposeRequestsForTesting, findDisposeRequest, listDisposeRequests, onDisposeRequestsChanged,
  recordDisposeRequest, takeDisposeRequest, updateDisposeRequestChecks,
} from './helper-dispose-requests';
import type { HelperDisposeRequest } from '../../shared/types';

const request = (helperId = 'helper', extra: Partial<HelperDisposeRequest> = {}): HelperDisposeRequest => ({
  projectPath: '/p', orchestratorId: 'orch', helperId, helperName: 'Docs',
  checks: { dirty: 1, unpushed: 0, unmerged: 0 }, forceRequested: false, ...extra,
});

afterEach(() => _resetDisposeRequestsForTesting());

describe('helper dispose requests', () => {
  it('answers a recorded request once, and only for its orchestrator', () => {
    recordDisposeRequest('/p', 'helper', 'orch');
    expect(takeDisposeRequest('/p', 'helper', 'other')).toBe(false);
    expect(takeDisposeRequest('/p/', 'helper', 'orch')).toBe(true);
    expect(takeDisposeRequest('/p', 'helper', 'orch')).toBe(false);
  });

  it('lists only requests recorded in full, oldest first (#159)', () => {
    recordDisposeRequest('/p', 'bare', 'orch');
    recordDisposeRequest('/p', 'b', 'orch', request('b'), Date.parse('2026-10-26T10:05:00Z'));
    recordDisposeRequest('/p', 'a', 'orch', request('a'), Date.parse('2026-10-26T10:00:00Z'));
    const list = listDisposeRequests();
    expect(list.map((p) => p.request.helperId)).toEqual(['a', 'b']);
    expect(list[0]).toMatchObject({ requestId: expect.stringMatching(/^hdispose_/), createdAt: '2026-10-26T10:00:00.000Z' });
    expect(findDisposeRequest(list[1].requestId)?.request.helperId).toBe('b');
    expect(findDisposeRequest('hdispose_missing')).toBeNull();
  });

  it('says when a request is added, replaced and answered', () => {
    const changes = vi.fn();
    onDisposeRequestsChanged(changes);
    recordDisposeRequest('/p', 'helper', 'orch', request());
    const first = listDisposeRequests()[0].requestId;
    recordDisposeRequest('/p', 'helper', 'orch', request('helper', { forceRequested: true }));
    const second = listDisposeRequests()[0].requestId;
    expect(second).not.toBe(first);
    takeDisposeRequest('/p', 'helper', 'orch');
    expect(changes.mock.calls.map(([c]) => [c.kind, c.kind === 'closed' ? c.replaced ?? false : null])).toEqual([
      ['added', null], ['closed', true], ['added', null], ['closed', false],
    ]);
    expect(listDisposeRequests()).toEqual([]);
  });

  it('reissues a request under a new id when its checks change', () => {
    recordDisposeRequest('/p', 'helper', 'orch', request());
    const { requestId, createdAt } = listDisposeRequests()[0];
    const changes = vi.fn();
    onDisposeRequestsChanged(changes);
    const next = updateDisposeRequestChecks(requestId, { dirty: 4, unpushed: 2, unmerged: 0 });
    expect(next).toMatch(/^hdispose_/);
    expect(next).not.toBe(requestId);
    expect(findDisposeRequest(requestId)).toBeNull();
    expect(findDisposeRequest(next!)).toMatchObject({ createdAt, request: { checks: { dirty: 4, unpushed: 2 } } });
    expect(changes).toHaveBeenCalledWith(expect.objectContaining({ kind: 'closed', requestId, replaced: true }));
    expect(updateDisposeRequestChecks('hdispose_missing', { dirty: 0, unpushed: 0, unmerged: 0 })).toBeNull();
    // Still answerable by its orchestrator.
    expect(takeDisposeRequest('/p', 'helper', 'orch')).toBe(true);
  });

  it('keeps notifying when one listener throws', () => {
    const after = vi.fn();
    onDisposeRequestsChanged(() => { throw new Error('boom'); });
    const off = onDisposeRequestsChanged(after);
    recordDisposeRequest('/p', 'helper', 'orch', request());
    expect(after).toHaveBeenCalledTimes(1);
    off();
    takeDisposeRequest('/p', 'helper', 'orch');
    expect(after).toHaveBeenCalledTimes(1);
  });
});
