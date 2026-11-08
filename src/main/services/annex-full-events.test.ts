import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../shared/chat';
import { _forgetReviewedForTest, findFullEvent, forgetReviewedBy, fullEventDigest, rememberReviewed, wasReviewed } from './annex-full-events';

const request = (rawInput: Record<string, unknown> = { file_path: '/x', content: 'big' }) => ({
  v: 1, type: 'permission_request', agentId: 'a', sessionId: 's', seq: 3, ts: 1,
  data: { requestId: 'r', title: 'Write', toolName: 'Write', rawInput, options: [{ optionId: 'ok', kind: 'allow_once', name: 'Allow' }] },
}) as unknown as Extract<ChatEvent, { type: 'permission_request' }>;

describe('full chat events (#2731)', () => {
  beforeEach(() => _forgetReviewedForTest());

  it('gives the same digest whatever the key order, and a different one for different content', () => {
    const a = request({ file_path: '/x', content: 'big' });
    const b = request({ content: 'big', file_path: '/x' });
    expect(fullEventDigest(a)).toBe(fullEventDigest(b));
    expect(fullEventDigest(request({ file_path: '/x', content: 'other' }))).not.toBe(fullEventDigest(a));
  });

  it('finds an event by session and seq', () => {
    const event = request();
    expect(findFullEvent([event], 's', 3)).toBe(event);
    expect(findFullEvent([event], 'other', 3)).toBeUndefined();
    expect(findFullEvent([event], 's', 4)).toBeUndefined();
  });

  it('counts a review only for the device and epoch that fetched it, quoting the same digest', () => {
    const event = request();
    const digest = fullEventDigest(event);
    expect(wasReviewed('phone', 'e1', event, digest)).toBe(false);
    rememberReviewed('phone', 'e1', event);
    expect(wasReviewed('phone', 'e1', event, digest)).toBe(true);
    expect(wasReviewed('phone', 'e1', event, undefined)).toBe(false);
    expect(wasReviewed('phone', 'e1', event, 'sha256:other')).toBe(false);
    expect(wasReviewed('other-phone', 'e1', event, digest)).toBe(false);
    expect(wasReviewed(undefined, 'e1', event, digest)).toBe(false);
    expect(wasReviewed('phone', 'e2', event, digest)).toBe(false);
    // The request changed after the fetch: the old digest no longer describes it.
    const changed = request({ file_path: '/x', content: 'changed' });
    expect(wasReviewed('phone', 'e1', changed, digest)).toBe(false);
    expect(wasReviewed('phone', 'e1', changed, fullEventDigest(changed))).toBe(false);
  });

  it('forgets what a device fetched when its pairing is removed, and only that device', () => {
    const event = request();
    const digest = fullEventDigest(event);
    rememberReviewed('phone', 'e1', event);
    rememberReviewed('phone-2', 'e1', event);
    forgetReviewedBy('phone');
    expect(wasReviewed('phone', 'e1', event, digest)).toBe(false);
    expect(wasReviewed('phone-2', 'e1', event, digest)).toBe(true);
  });
});
