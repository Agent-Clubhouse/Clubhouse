import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Agent } from '../../../shared/types';
import type { DispatcherLeadState } from '../../../shared/dispatcher-lead';
import type { FollowedLead } from './leadStore';

vi.mock('../agents/chat/AgentRuntimePane', () => ({
  AgentRuntimePane: ({ agent }: { agent: Agent }) => <div data-testid="runtime-pane" data-agent-id={agent.id} />,
}));
vi.mock('../agents/chat/ChatStream', () => ({
  ChatStream: ({ state, emptyMessage }: { state: { agentId: string }; emptyMessage: string }) => (
    <div data-testid="chat-stream" data-agent-id={state.agentId}>{emptyMessage}</div>
  ),
}));
vi.mock('../agents/chat/useChatSession', () => ({
  useChatTranscript: vi.fn(), useChatState: () => undefined, useChatLoading: () => false,
}));

import { FollowerDispatcherView, outboxLines } from './FollowerDispatcherView';

const OUTBOX = { waiting: 0, oldestAt: null, expired: 0, failed: null };
const STATE: DispatcherLeadState = {
  available: true, role: 'follower', following: true, tookBack: false,
  lead: { machine: 'laptop', name: 'Laptop', self: false, online: true },
  choices: [], confirmedBy: [], waitingOn: [], clearedFor: null, changedByName: 'Desk', changedAt: '2026-11-13T10:00:00.000Z',
  leadLastSeen: '2026-11-13T09:00:00.000Z', outbox: OUTBOX, localNews: { count: 0, needsUser: false },
};
const LEAD_AGENT = { id: 'remote||sat-laptop||chat-1', projectId: 'remote||sat-laptop||__dispatcher__', name: 'Rosie', kind: 'durable', status: 'running', executionMode: 'chat' } as unknown as Agent;
const lead = (over: Partial<FollowedLead> = {}, state: Partial<DispatcherLeadState> = {}): FollowedLead => ({
  state: { ...STATE, ...state }, machineName: 'Laptop', agent: LEAD_AGENT, online: true, ...over,
});

beforeEach(() => {
  Object.assign(window.clubhouse.dispatcher, {
    takeBack: vi.fn(async () => STATE),
    queueForLead: vi.fn(async () => ({ id: 'q1' })),
    dismissLeadNotice: vi.fn(async () => STATE),
  });
});

describe('the follower’s Dispatcher pane (#3352, #3353)', () => {
  it('shows the lead’s live chat, named with its computer', () => {
    render(<FollowerDispatcherView lead={lead()} localChatId="local-chat" localName="Rex" />);
    expect(screen.getByTestId('follower-heading').textContent).toBe('Following Rosie on Laptop');
    expect(screen.getByTestId('runtime-pane').dataset.agentId).toBe(LEAD_AGENT.id);
    expect(screen.queryByTestId('follower-lead-offline')).toBeNull();
  });

  it('keeps this computer’s earlier chat one click away, read-only, and comes back', () => {
    render(<FollowerDispatcherView lead={lead()} localChatId="local-chat" localName="Rex" />);
    fireEvent.click(screen.getByTestId('follower-earlier-toggle'));
    expect(screen.getByTestId('follower-heading').textContent).toBe('This computer’s earlier chat with Rex. Read only.');
    expect(screen.getByTestId('chat-stream').dataset.agentId).toBe('local-chat');
    expect(screen.queryByTestId('runtime-pane')).toBeNull();
    expect(screen.queryByTestId('follower-offline-input')).toBeNull();
    fireEvent.click(screen.getByTestId('follower-earlier-toggle'));
    expect(screen.getByTestId('runtime-pane')).toBeTruthy();
  });

  it('with the lead offline: says so, keeps its chat readable, and keeps messages for later', async () => {
    render(<FollowerDispatcherView lead={lead({ online: false })} localChatId="local-chat" localName="Rex" />);
    expect(screen.getByTestId('follower-lead-offline').textContent).toMatch(/^Lead \(Laptop\) is offline, last seen .+\. What you send waits until it’s back, for up to a day\./);
    expect(screen.getByTestId('chat-stream').dataset.agentId).toBe(LEAD_AGENT.id);
    fireEvent.change(screen.getByTestId('follower-offline-input'), { target: { value: 'Rebuild the docs' } });
    fireEvent.click(screen.getByTestId('follower-offline-send'));
    await waitFor(() => expect(window.clubhouse.dispatcher.queueForLead).toHaveBeenCalledWith('Rebuild the docs'));
    await waitFor(() => expect((screen.getByTestId('follower-offline-input') as HTMLTextAreaElement).value).toBe(''));
  });

  it('keeps the draft and says why when a message can’t be kept', async () => {
    window.clubhouse.dispatcher.queueForLead = vi.fn(async () => { throw new Error('20 messages are already waiting for the lead.'); });
    render(<FollowerDispatcherView lead={lead({ online: false })} localChatId="local-chat" localName="Rex" />);
    fireEvent.change(screen.getByTestId('follower-offline-input'), { target: { value: 'one more' } });
    fireEvent.click(screen.getByTestId('follower-offline-send'));
    expect((await screen.findByTestId('follower-error')).textContent).toContain('20 messages are already waiting');
    expect((screen.getByTestId('follower-offline-input') as HTMLTextAreaElement).value).toBe('one more');
  });

  it('Take back is a person’s click', async () => {
    render(<FollowerDispatcherView lead={lead({ online: false })} localChatId="local-chat" localName="Rex" />);
    expect(window.clubhouse.dispatcher.takeBack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('follower-take-back'));
    await waitFor(() => expect(window.clubhouse.dispatcher.takeBack).toHaveBeenCalledTimes(1));
  });

  it('says what waits, what expired and what was refused, until dismissed', async () => {
    render(<FollowerDispatcherView lead={lead({}, { outbox: { waiting: 2, oldestAt: null, expired: 1, failed: null } })} localChatId="local-chat" localName="Rex" />);
    expect(screen.getByTestId('follower-waiting').textContent).toBe('2 messages waiting for Laptop.');
    expect(screen.getByTestId('follower-outbox-problem').textContent).toContain('1 message expired before Laptop came back, and wasn’t sent.');
    fireEvent.click(screen.getByTestId('follower-outbox-dismiss'));
    await waitFor(() => expect(window.clubhouse.dispatcher.dismissLeadNotice).toHaveBeenCalled());
    expect(outboxLines({ ...OUTBOX, failed: 'Refused.' }, 'Laptop')).toEqual({ waiting: null, problem: 'Refused.' });
  });

  it('says when news stayed in this computer’s chat, and that a question there needs Take back', async () => {
    render(<FollowerDispatcherView lead={lead({}, { localNews: { count: 1, needsUser: true } })} localChatId="local-chat" localName="Rex" />);
    expect(screen.getByTestId('follower-local-news').textContent).toContain('An update from this computer’s Dispatcher is in its own chat, because the lead couldn’t take it. One needs your answer');
    fireEvent.click(screen.getByTestId('follower-local-news-show'));
    expect(screen.getByTestId('follower-earlier-chat')).toBeTruthy();
    fireEvent.click(screen.getByTestId('follower-local-news-dismiss'));
    await waitFor(() => expect(window.clubhouse.dispatcher.dismissLeadNotice).toHaveBeenCalled());
  });

  it('with no chat from the lead yet, says why', () => {
    const { rerender } = render(<FollowerDispatcherView lead={lead({ agent: null })} localChatId="local-chat" localName="Rex" />);
    expect(screen.getByTestId('follower-no-lead-chat').textContent).toBe('Laptop’s Dispatcher is off. Its chat shows here when it’s on.');
    rerender(<FollowerDispatcherView lead={lead({ agent: null, online: false })} localChatId="local-chat" localName="Rex" />);
    expect(screen.getByTestId('follower-no-lead-chat').textContent).toBe('Waiting for Laptop to connect.');
  });
});
