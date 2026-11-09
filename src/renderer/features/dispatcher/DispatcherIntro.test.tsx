import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent } from '../../../shared/types';
import { DISPATCHER_PROJECT_ID } from '../../../shared/dispatcher-types';
import type { DispatcherTeaching } from '../../../shared/dispatcher-teaching';
import { createChatViewState, foldChatEvents } from '../../stores/chatStore';
import { ChatViewBody } from '../agents/chat/ChatView';
import { useChatDraftStore, type ChatActions } from '../agents/chat/useChatSession';
import { chatFixture, FIXTURE_AGENT_ID } from '../agents/chat/fixtures';
import { DispatcherChatIntro, DispatcherIntro } from './DispatcherIntro';

const TWO: DispatcherTeaching = {
  agents: [
    { id: 'lead', name: 'webapp-lead', running: true, purpose: 'Owns checkout' },
    { id: 'rel', name: 'release-lead', running: false },
  ],
};

function suggestions(): Array<{ kind: string | null; text: string | null }> {
  return screen.getAllByTestId('dispatcher-suggestion').map((b) => ({ kind: b.getAttribute('data-kind'), text: b.textContent }));
}

describe('DispatcherIntro (#3048)', () => {
  it('introduces itself by name with how many agents it reaches, then offers things to ask', () => {
    render(<DispatcherIntro name="Rosie" teaching={TWO} onPick={vi.fn()} />);
    const intro = screen.getByTestId('dispatcher-intro');
    expect(intro.textContent).toContain('Hi, I\'m Rosie. I can reach 2 of your agents.');
    expect(intro.textContent).toContain('I remember what we decide');
    expect(suggestions()).toEqual([
      { kind: 'status', text: 'What\'s everyone working on?' },
      { kind: 'agent', text: 'Catch me up on webapp-lead' },
      { kind: 'agent', text: 'What does release-lead need from me?' },
      { kind: 'manage', text: 'Wake release-lead and ask what\'s left on its list' },
      { kind: 'schedule', text: 'Every weekday at 9, have webapp-lead post its plan for the day' },
      { kind: 'abilities', text: 'What else can you do?' },
    ]);
  });

  it('with no agents connected, says so and still has a scheduling and a management example', () => {
    render(<DispatcherIntro name="Rosie" teaching={{ agents: [] }} onPick={vi.fn()} />);
    expect(screen.getByTestId('dispatcher-intro').textContent).toContain('No agents are connected to me yet.');
    expect(suggestions().map((s) => s.kind)).toEqual(['status', 'manage', 'schedule', 'abilities']);
  });

  it('sends the picked suggestion word for word', () => {
    const onPick = vi.fn();
    render(<DispatcherIntro name="Rosie" teaching={TWO} onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: 'What else can you do?' }));
    expect(onPick).toHaveBeenCalledWith('What else can you do?');
  });

  it('draws each suggestion as a button: outlined, with a send arrow (#3184)', () => {
    render(<DispatcherIntro name="Rosie" teaching={TWO} onPick={vi.fn()} />);
    for (const b of screen.getAllByTestId('dispatcher-suggestion')) {
      expect(b.tagName).toBe('BUTTON');
      expect(b).toHaveClass('border', 'border-surface-1', 'rounded-md', 'cursor-pointer');
      expect(within(b).getByTestId('dispatcher-suggestion-arrow')).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('waits for its agents before saying a count', () => {
    render(<DispatcherIntro name="Rosie" teaching={null} onPick={vi.fn()} />);
    expect(screen.queryByTestId('dispatcher-intro')).toBeNull();
    expect(screen.getByTestId('dispatcher-intro-loading')).toBeTruthy();
  });

  it('can\'t send while the composer can\'t', () => {
    render(<DispatcherIntro name="Rosie" teaching={TWO} onPick={vi.fn()} disabled />);
    for (const b of screen.getAllByTestId('dispatcher-suggestion')) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('DispatcherChatIntro', () => {
  const original = window.clubhouse.dispatcher;
  let cardChanged: ((agentId: string) => void) | null = null;
  beforeEach(() => {
    window.clubhouse.dispatcher = {
      ...original,
      getTeaching: vi.fn(async () => ({ agents: [] })),
      onAgentCardChanged: (cb: (agentId: string) => void) => { cardChanged = cb; return () => { cardChanged = null; }; },
    };
  });
  afterEach(() => { window.clubhouse.dispatcher = original; });

  it('reads its agents from main, and again when a card changes', async () => {
    const getTeaching = vi.mocked(window.clubhouse.dispatcher.getTeaching);
    render(<DispatcherChatIntro name="Rosie" onPick={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('dispatcher-intro').textContent).toContain('No agents are connected'));
    getTeaching.mockResolvedValue(TWO);
    act(() => cardChanged?.('lead'));
    await waitFor(() => expect(screen.getByTestId('dispatcher-intro').textContent).toContain('I can reach 2 of your agents'));
  });

  it('reads a failed read as no agents', async () => {
    vi.mocked(window.clubhouse.dispatcher.getTeaching).mockRejectedValue(new Error('down'));
    render(<DispatcherChatIntro name="Rosie" onPick={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('dispatcher-intro').textContent).toContain('No agents are connected'));
  });
});

describe('the Dispatcher chat\'s empty state', () => {
  const original = window.clubhouse.dispatcher;
  beforeEach(() => {
    useChatDraftStore.setState({ drafts: {}, attachments: {} });
    window.clubhouse.dispatcher = { ...original, getTeaching: vi.fn(async () => TWO) };
  });
  afterEach(() => { window.clubhouse.dispatcher = original; });

  const dispatcher: Agent = { id: FIXTURE_AGENT_ID, projectId: DISPATCHER_PROJECT_ID, name: 'Rosie', kind: 'durable', status: 'running', color: 'emerald' };
  const other: Agent = { ...dispatcher, projectId: 'proj-1', name: 'gallant-swift' };

  function actions(): ChatActions & { send: ReturnType<typeof vi.fn> } {
    return {
      send: vi.fn(async () => ({ delivery: 'prompt' as const })),
      interrupt: vi.fn(async () => true),
      respondPermission: vi.fn(async () => true),
      answerQuestion: vi.fn(async () => true),
      setLevel: vi.fn(async () => true),
      removeQueued: vi.fn(async () => true),
    };
  }

  it('opens with the intro, and a suggestion goes out as the user\'s message', async () => {
    const a = actions();
    render(<ChatViewBody agent={dispatcher} state={createChatViewState(FIXTURE_AGENT_ID)} actions={a} />);
    const intro = await screen.findByTestId('dispatcher-intro');
    expect(intro.textContent).toContain('Hi, I\'m Rosie.');
    fireEvent.click(within(intro).getByRole('button', { name: 'What\'s everyone working on?' }));
    await waitFor(() => expect(a.send).toHaveBeenCalledWith('What\'s everyone working on?', 'auto'));
  });

  it('is not shown once the conversation has messages', () => {
    render(<ChatViewBody agent={dispatcher} state={foldChatEvents(undefined, FIXTURE_AGENT_ID, chatFixture('claude', 'conversation'))} actions={actions()} />);
    expect(screen.queryByTestId('dispatcher-intro')).toBeNull();
  });

  it('is not shown while the conversation loads, nor for any other agent', () => {
    const { unmount } = render(<ChatViewBody agent={dispatcher} state={createChatViewState(FIXTURE_AGENT_ID)} actions={actions()} loading />);
    expect(screen.queryByTestId('dispatcher-intro')).toBeNull();
    unmount();
    render(<ChatViewBody agent={other} state={createChatViewState(FIXTURE_AGENT_ID)} actions={actions()} />);
    expect(screen.queryByTestId('dispatcher-intro')).toBeNull();
    expect(screen.getByText('No messages yet. Send one to start.')).toBeTruthy();
  });
});
