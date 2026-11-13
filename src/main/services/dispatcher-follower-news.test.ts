/** A follower's news goes to the lead's controller over the controller link (#3352). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  following: true, role: 'follower' as 'peer' | 'lead' | 'follower', lead: 'laptop' as string | null,
  controller: { agentId: 'lead-controller', enabled: true, name: 'Dispatcher controller' } as { agentId: string | null; enabled: boolean; name: string } | undefined,
  result: { content: [{ type: 'text', text: 'Delivered.' }] } as { content: Array<{ type: string; text: string }>; isError?: boolean },
  delivered: new Set<string>(),
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-agent-calls', () => ({
  forwardAgentCall: vi.fn(async () => h.result),
  getDelivery: (_caller: string, id: string) => (h.delivered.has(id) ? { state: 'delivered' } : undefined),
}));
vi.mock('./dispatcher-federation', () => ({ remoteFederationController: () => h.controller }));
vi.mock('./dispatcher-federation-lead', () => ({
  isFollowingLead: () => h.following, leadRole: () => h.role, leadRecord: () => ({ lead: h.lead }),
}));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherAgentId: () => 'my-controller' }));
vi.mock('./dispatcher/dispatcher-channel', () => ({ deliverUpdateToChat: vi.fn(async () => ({ outcome: 'delivered' })) }));

import { forwardAgentCall } from './annex-agent-calls';
import { deliverUpdateToChat } from './dispatcher/dispatcher-channel';
import {
  _resetFollowerNewsForTesting, dismissLocalNews, followerNewsMessage, forwardNewsToLead, isForwardedNewsCall, localNewsState,
  newsDeliveryFailed, readForwardedNews, receiveFollowerNews, startFollowerNews,
} from './dispatcher-follower-news';

const NEWS = { v: 1 as const, kind: 'needs_user' as const, text: 'Merge to main?', fromName: 'docs-agent', request: 'req_7' };
const MESSAGE = { text: '[FROM:Clubhouse] docs-agent needs the user for this.', routed: [{ fromClubhouse: true as const, text: 'Merge to main?' }], forward: NEWS };
let online = true;

beforeEach(() => {
  _resetFollowerNewsForTesting();
  Object.assign(h, { following: true, role: 'follower', lead: 'laptop', controller: { agentId: 'lead-controller', enabled: true, name: 'Dispatcher controller' },
    result: { content: [{ type: 'text', text: 'Delivered.' }] } });
  h.delivered.clear();
  online = true;
  vi.mocked(forwardAgentCall).mockClear();
  vi.mocked(deliverUpdateToChat).mockClear();
  startFollowerNews({ connected: () => online, machineName: (m) => (m === 'desk' ? 'Desk' : undefined) });
});

describe('sending news to the lead (#3352)', () => {
  it('goes over the controller link as send_message with the news as fields', async () => {
    expect(await forwardNewsToLead(MESSAGE)).toBe(true);
    expect(forwardAgentCall).toHaveBeenCalledWith('my-controller', 'lead-controller@laptop', 'Dispatcher controller', 'send_message',
      { message: 'News from docs-agent: Merge to main?', news: NEWS });
    expect(localNewsState().count).toBe(0);
  });

  it('stays here, and the pane is told, with the lead offline, its Dispatcher off, or a refusal', async () => {
    online = false;
    expect(await forwardNewsToLead(MESSAGE)).toBe(false);
    online = true;
    h.controller = { agentId: 'lead-controller', enabled: false, name: 'x' };
    expect(await forwardNewsToLead(MESSAGE)).toBe(false);
    h.controller = { agentId: 'lead-controller', enabled: true, name: 'x' };
    h.result = { content: [{ type: 'text', text: 'no' }], isError: true };
    expect(await forwardNewsToLead(MESSAGE)).toBe(false);
    vi.mocked(forwardAgentCall).mockRejectedValueOnce(new Error('gone'));
    expect(await forwardNewsToLead(MESSAGE)).toBe(false);
    expect(localNewsState()).toEqual({ count: 4, needsUser: true });
    dismissLocalNews();
    expect(localNewsState()).toEqual({ count: 0, needsUser: false });
  });

  it('isn’t sent, or noted, when not following', async () => {
    h.following = false;
    expect(await forwardNewsToLead(MESSAGE)).toBe(false);
    expect(forwardAgentCall).not.toHaveBeenCalled();
    expect(localNewsState().count).toBe(0);
  });

  it('news the lead refuses after it was queued reaches this computer’s chat instead', async () => {
    h.result = { content: [{ type: 'text', text: 'Queued for Dispatcher on Laptop. delivery_id=call_42. This confirms a durable queue, not model execution.' }] };
    expect(await forwardNewsToLead(MESSAGE)).toBe(true);
    const notice = { callId: 'call_42', callerId: 'my-controller', targetId: 'lead-controller@laptop', tool: 'send_message', state: 'refused' as const,
      queuedAt: '', updatedAt: '', attempts: 1, reason: 'not_lead' };
    expect(await newsDeliveryFailed(notice)).toBe(true);
    expect(deliverUpdateToChat).toHaveBeenCalledWith(MESSAGE);
    expect(localNewsState()).toEqual({ count: 1, needsUser: true });
    // Once only, and an ordinary message's failure isn't news.
    expect(await newsDeliveryFailed(notice)).toBe(false);
    expect(await newsDeliveryFailed({ ...notice, callId: 'other' })).toBe(false);
  });
});

describe('one place for each piece of news (#3352)', () => {
  const notice = (callId: string) => ({ callId, callerId: 'my-controller', targetId: 'lead-controller@laptop', tool: 'send_message', state: 'refused' as const,
    queuedAt: '', updatedAt: '', attempts: 1, reason: 'not_lead' });

  it('a refusal reported while the call is under way isn’t shown again; the call keeps the news here once', async () => {
    let reported: boolean | undefined;
    vi.mocked(forwardAgentCall).mockImplementationOnce(async () => {
      reported = await newsDeliveryFailed(notice('call_now'));
      return { content: [{ type: 'text', text: 'Refused.' }], isError: true };
    });
    expect(await forwardNewsToLead(MESSAGE)).toBe(false);
    expect(reported).toBe(true);
    expect(deliverUpdateToChat).not.toHaveBeenCalled();
    expect(localNewsState().count).toBe(1);
    // After the call, an ordinary message's failure is reported as usual.
    expect(await newsDeliveryFailed(notice('call_later'))).toBe(false);
  });

  it('forgets news the lead has taken', async () => {
    h.result = { content: [{ type: 'text', text: 'Queued. delivery_id=call_1. This confirms a durable queue, not model execution.' }] };
    await forwardNewsToLead(MESSAGE);
    h.delivered.add('call_1');
    h.result = { content: [{ type: 'text', text: 'Queued. delivery_id=call_2. This confirms a durable queue, not model execution.' }] };
    await forwardNewsToLead(MESSAGE);
    // call_1 was taken, so a late failure for it isn't news any more.
    expect(await newsDeliveryFailed(notice('call_1'))).toBe(false);
    expect(await newsDeliveryFailed(notice('call_2'))).toBe(true);
  });
});

describe('the lead receiving it (#3352)', () => {
  const deliver = vi.fn(async (message: string) => ({ content: [{ type: 'text', text: message }] }));
  beforeEach(() => deliver.mockClear());

  it('tells this computer’s controller, named with the machine the connection names, never one the text claims', async () => {
    h.role = 'lead';
    const result = await receiveFollowerNews('desk', { ...NEWS, fromName: 'docs-agent' }, deliver);
    expect(result.isError).toBeFalsy();
    const [message] = deliver.mock.calls[0];
    expect(message).toContain('tell_user, kind needs_user, from "docs-agent on Desk"');
    expect(message).toContain('send it back to Desk\'s Dispatcher with send_message, naming its request req_7');
    expect(message.endsWith('\n\nMerge to main?')).toBe(true);
    expect(followerNewsMessage({ v: 1, kind: 'check_in', text: '- built the site' }, 'Desk')).toContain('Desk\'s Dispatcher\'s check-in');
  });

  it('fails closed as refused: not the lead, or malformed news', async () => {
    h.role = 'follower';
    expect(await receiveFollowerNews('desk', NEWS, deliver)).toMatchObject({ isError: true, annexDelivery: { state: 'refused', reason: 'not_lead' } });
    h.role = 'lead';
    for (const bad of [null, {}, { ...NEWS, v: 2 }, { ...NEWS, kind: 'approve' }, { ...NEWS, text: '' }, { ...NEWS, text: 'x'.repeat(8001) }, { ...NEWS, fromName: 7 }]) {
      expect(await receiveFollowerNews('desk', bad, deliver)).toMatchObject({ isError: true, annexDelivery: { state: 'refused', reason: 'invalid_news' } });
    }
    expect(deliver).not.toHaveBeenCalled();
  });

  it('is told apart from an ordinary message, and reads only its own fields', () => {
    expect(isForwardedNewsCall('send_message', { message: 'hi', news: NEWS })).toBe(true);
    expect(isForwardedNewsCall('send_message', { message: 'hi' })).toBe(false);
    expect(isForwardedNewsCall('send_file', { news: NEWS })).toBe(false);
    expect(readForwardedNews({ ...NEWS, extra: 'ignored' })).toEqual(NEWS);
  });
});
