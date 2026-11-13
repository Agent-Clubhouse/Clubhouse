/** A follower's news goes to the lead's chat over the controller link (#3352). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  following: true, role: 'follower' as 'peer' | 'lead' | 'follower', lead: 'laptop' as string | null,
  controller: { agentId: 'lead-controller', enabled: true, name: 'Dispatcher controller' } as { agentId: string | null; enabled: boolean; name: string } | undefined,
  result: { content: [{ type: 'text', text: 'Delivered.' }] } as { content: unknown[]; isError?: boolean },
  delivered: { outcome: 'delivered' } as { outcome: string; error?: string },
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-agent-calls', () => ({ forwardAgentCall: vi.fn(async () => h.result) }));
vi.mock('./dispatcher-federation', () => ({ remoteFederationController: () => h.controller }));
vi.mock('./dispatcher-federation-lead', () => ({
  isFollowingLead: () => h.following, leadRole: () => h.role, leadRecord: () => ({ lead: h.lead }),
}));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherAgentId: () => 'my-controller' }));
vi.mock('./dispatcher/dispatcher-channel', () => ({ deliverForwardedNews: vi.fn(async () => h.delivered) }));

import { forwardAgentCall } from './annex-agent-calls';
import { deliverForwardedNews } from './dispatcher/dispatcher-channel';
import { forwardNewsToLead, isForwardedNewsCall, readForwardedNews, receiveFollowerNews, startFollowerNews } from './dispatcher-follower-news';

const NEWS = { v: 1 as const, kind: 'needs_user' as const, text: 'Merge to main?', fromName: 'docs-agent' };
let online = true;

beforeEach(() => {
  Object.assign(h, { following: true, role: 'follower', lead: 'laptop', controller: { agentId: 'lead-controller', enabled: true, name: 'Dispatcher controller' },
    result: { content: [{ type: 'text', text: 'Delivered.' }] }, delivered: { outcome: 'delivered' } });
  online = true;
  vi.mocked(forwardAgentCall).mockClear();
  vi.mocked(deliverForwardedNews).mockClear();
  startFollowerNews({ connected: () => online, machineName: (m) => (m === 'desk' ? 'Desk' : undefined) });
});

describe('sending news to the lead (#3352)', () => {
  it('goes over the controller link as send_message with the news as fields', async () => {
    expect(await forwardNewsToLead(NEWS)).toBe(true);
    expect(forwardAgentCall).toHaveBeenCalledWith('my-controller', 'lead-controller@laptop', 'Dispatcher controller', 'send_message',
      { message: 'News from docs-agent: Merge to main?', news: NEWS });
  });

  it('stays here when not following, after Take back, with the lead offline, its Dispatcher off, or a refusal', async () => {
    online = false;
    expect(await forwardNewsToLead(NEWS)).toBe(false);
    online = true;
    h.following = false;
    expect(await forwardNewsToLead(NEWS)).toBe(false);
    h.following = true;
    h.controller = { agentId: 'lead-controller', enabled: false, name: 'x' };
    expect(await forwardNewsToLead(NEWS)).toBe(false);
    h.controller = undefined;
    expect(await forwardNewsToLead(NEWS)).toBe(false);
    h.controller = { agentId: 'lead-controller', enabled: true, name: 'x' };
    h.result = { content: [], isError: true };
    expect(await forwardNewsToLead(NEWS)).toBe(false);
    vi.mocked(forwardAgentCall).mockRejectedValueOnce(new Error('gone'));
    expect(await forwardNewsToLead(NEWS)).toBe(false);
  });
});

describe('the lead receiving it (#3352)', () => {
  it('puts it in the chat under the machine the connection names, never one the text claims', async () => {
    h.role = 'lead';
    const result = await receiveFollowerNews('desk', { ...NEWS, fromName: 'docs-agent on Studio' });
    expect(result.isError).toBeFalsy();
    expect(deliverForwardedNews).toHaveBeenCalledWith(expect.objectContaining({ fromName: 'docs-agent on Studio' }), 'Desk');
  });

  it('fails closed: not the lead, malformed news, or a chat that can’t take it', async () => {
    h.role = 'follower';
    expect((await receiveFollowerNews('desk', NEWS)).isError).toBe(true);
    h.role = 'lead';
    for (const bad of [null, {}, { ...NEWS, v: 2 }, { ...NEWS, kind: 'approve' }, { ...NEWS, text: '' }, { ...NEWS, text: 'x'.repeat(8001) }, { ...NEWS, fromName: 7 }]) {
      expect((await receiveFollowerNews('desk', bad)).isError).toBe(true);
    }
    expect(deliverForwardedNews).not.toHaveBeenCalled();
    h.delivered = { outcome: 'off', error: 'The Dispatcher is turned off.' };
    expect((await receiveFollowerNews('desk', NEWS)).isError).toBe(true);
  });

  it('is told apart from an ordinary message, and reads only its own fields', () => {
    expect(isForwardedNewsCall('send_message', { message: 'hi', news: NEWS })).toBe(true);
    expect(isForwardedNewsCall('send_message', { message: 'hi' })).toBe(false);
    expect(isForwardedNewsCall('send_file', { news: NEWS })).toBe(false);
    expect(readForwardedNews({ ...NEWS, extra: 'ignored', request: 'req_1' })).toEqual({ ...NEWS, request: 'req_1' });
  });
});
