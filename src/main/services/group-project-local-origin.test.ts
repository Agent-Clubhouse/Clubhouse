import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isLocalGroupPost, noteLocalGroupPost, noteLocalGroupRequest, noteLocalGroupRequestResult, resetLocalGroupPostsForTesting } from './group-project-local-origin';
beforeEach(() => { vi.useFakeTimers(); resetLocalGroupPostsForTesting(); });
afterEach(() => { resetLocalGroupPostsForTesting(); vi.useRealTimers(); });
it('keeps provenance local, group scoped and short lived', () => {
  expect(isLocalGroupPost('g', 'p')).toBe(false);
  noteLocalGroupPost('g', 'p');
  expect(isLocalGroupPost('g', 'p')).toBe(true);
  expect(isLocalGroupPost('other', 'p')).toBe(false);
  vi.advanceTimersByTime(10 * 60_000 + 1);
  expect(isLocalGroupPost('g', 'p')).toBe(false);
});
it('marks a queued result only for a request created in this process', () => {
  noteLocalGroupRequestResult('remote-claim', 'g', 'remote-post');
  expect(isLocalGroupPost('g', 'remote-post')).toBe(false);
  noteLocalGroupRequest('local-request', 'local-post');
  noteLocalGroupRequestResult('local-request', 'g', 'forged-result');
  expect(isLocalGroupPost('g', 'forged-result')).toBe(false);
  noteLocalGroupRequestResult('local-request', 'g', 'local-post');
  expect(isLocalGroupPost('g', 'local-post')).toBe(true);
  noteLocalGroupRequestResult('local-request', 'g', 'different-post');
  expect(isLocalGroupPost('g', 'different-post')).toBe(false);
});
