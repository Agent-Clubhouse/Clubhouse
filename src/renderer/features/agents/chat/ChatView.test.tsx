import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import type { ChatEvent } from '../../../../shared/chat';
import { foldChatEvents, useChatStore, type ChatViewState } from '../../../stores/chatStore';
import { CANVAS_TRANSCRIPT_TAIL, ChatView, ChatViewBody } from './ChatView';
import { useChatDraftStore, type ChatActions } from './useChatSession';
import { chatFixture, FIXTURE_AGENT_ID, PROFILES, type FixtureProvider } from './fixtures';
import { useAgentDetailsStore } from '../details/detailsStore';
import { useProjectStore } from '../../../stores/projectStore';

const agent: Agent = {
  id: FIXTURE_AGENT_ID,
  projectId: 'proj-1',
  name: 'gallant-swift',
  kind: 'durable',
  status: 'running',
  color: 'emerald',
};

function makeActions(): ChatActions & { [K in keyof ChatActions]: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn(async () => ({ delivery: 'prompt' as const })),
    interrupt: vi.fn(async () => true),
    respondPermission: vi.fn(async () => true),
    answerQuestion: vi.fn(async () => true),
    setLevel: vi.fn(async () => true),
  };
}

function fold(events: ChatEvent[]): ChatViewState {
  return foldChatEvents(undefined, FIXTURE_AGENT_ID, events);
}

function renderState(state: ChatViewState, actions = makeActions()) {
  const utils = render(<ChatViewBody agent={agent} state={state} actions={actions} providerName="Provider" onSwitchToTerminal={vi.fn()} />);
  return { ...utils, actions };
}

function renderFixture(p: FixtureProvider, scenario: Parameters<typeof chatFixture>[1], actions = makeActions()) {
  return renderState(fold(chatFixture(p, scenario)), actions);
}

beforeEach(() => {
  useChatDraftStore.setState({ drafts: {}, attachments: {} });
});

/** Append events after a fixture, continuing its seq. */
function extend(events: ChatEvent[], ...more: Array<Pick<ChatEvent, 'type' | 'data'>>): ChatEvent[] {
  const last = events[events.length - 1];
  return [...events, ...more.map((m, i) => ({ ...last, seq: last.seq + 1 + i, type: m.type, data: m.data }) as ChatEvent)];
}

describe('ChatView conversation', () => {
  it.each(['claude', 'codex', 'copilot'] as const)('renders one stream for %s', (p) => {
    renderFixture(p, 'conversation');
    expect(screen.getByTestId('chat-user-message')).toHaveTextContent('The agent list rows are too tall');
    expect(screen.getByTestId('chat-thought')).toHaveTextContent('Thought for 6s');
    expect(screen.getByTestId('chat-explore-group')).toHaveTextContent('Explored 3 files, 2 searches');
    const diffs = screen.getAllByTestId('chat-diff-card');
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toHaveTextContent('src/renderer/features/agents/AgentListItem.tsx');
    expect(diffs[0]).toHaveTextContent('+3');
    expect(diffs[0]).toHaveTextContent('−2');
    expect(diffs[1]).toHaveTextContent('Created');
    const cmd = screen.getByTestId('chat-command-card');
    expect(cmd).toHaveTextContent('$ npm run typecheck');
    expect(cmd).toHaveTextContent('exit 0');
    expect(cmd).toHaveTextContent('0 errors');
    expect(screen.getAllByTestId('chat-agent-message')).toHaveLength(2);
    expect(screen.getByTestId('chat-turn-footer')).toHaveTextContent('Turn 1');
    expect(screen.getByTestId('chat-turn-footer')).toHaveTextContent('1m 12s');
    expect(screen.getByTestId('pane-status')).toHaveTextContent('Done');
    expect(screen.getByTestId('pane-usage')).toHaveTextContent(/\d+%/);
  });

  it('expands the explore group to show each call', () => {
    renderFixture('claude', 'conversation');
    expect(screen.queryAllByTestId('chat-tool-row')).toHaveLength(0);
    fireEvent.click(within(screen.getByTestId('chat-explore-group')).getByRole('button'));
    expect(screen.getAllByTestId('chat-tool-row')).toHaveLength(5);
  });

  it('shows cost only when the driver reports dollars', () => {
    renderFixture('claude', 'conversation');
    expect(screen.getByTestId('chat-turn-footer')).toHaveTextContent('≈ $0.31 at API rates');
  });

  it('shows cached input tokens for token-reporting drivers', () => {
    renderFixture('codex', 'conversation');
    const footer = screen.getByTestId('chat-turn-footer');
    expect(footer).toHaveTextContent('24.6k in (19.1k cached)');
    expect(footer).not.toHaveTextContent('$');
  });

  it('shows tokens without cost for the Copilot driver', () => {
    renderFixture('copilot', 'conversation');
    const footer = screen.getByTestId('chat-turn-footer');
    expect(footer).toHaveTextContent('26.1k in · 900 out');
    expect(footer).not.toHaveTextContent('$');
  });

  it('hides tokens and cost when the driver reports only context fill', () => {
    const state = fold(chatFixture('copilot', 'conversation'));
    renderState({ ...state, capabilities: { ...state.capabilities!, usage: 'context' } });
    const footer = screen.getByTestId('chat-turn-footer');
    expect(footer).not.toHaveTextContent(' in');
    expect(footer).not.toHaveTextContent('$');
  });

  it.each([['claude', 2], ['codex', 2], ['copilot', 0]] as const)('shows plan-limit meters by capability (%s)', (p, n) => {
    renderFixture(p, 'conversation');
    const label = screen.getByTestId('pane-usage').getAttribute('aria-label') ?? '';
    expect(label.split(', ').filter((l) => / limit:/.test(l))).toHaveLength(n);
  });

  it('streams text and thinking before the final events arrive', () => {
    const events = chatFixture('claude', 'conversation');
    const firstChunk = events.findIndex((e) => e.type === 'agent_message_chunk');
    const thoughtChunk = events.findIndex((e) => e.type === 'agent_thought_chunk');
    const thinking = fold(events.slice(0, thoughtChunk + 1));
    const { unmount } = renderState(thinking);
    expect(screen.getByTestId('chat-thought')).toHaveTextContent('Thinking…');
    expect(screen.getByTestId('pane-status')).toHaveTextContent('Working');
    unmount();

    renderState(fold(events.slice(0, firstChunk + 2)));
    expect(screen.getByLabelText('Streaming')).toBeInTheDocument();
  });

  it('marks the command card running while output streams', () => {
    const events = chatFixture('codex', 'conversation');
    const firstOutput = events.findIndex((e) => e.type === 'tool_call_update' && e.data.toolCallId === 'cmd-1');
    renderState(fold(events.slice(0, firstOutput + 1)));
    const card = screen.getByTestId('chat-command-card');
    expect(card).toHaveAttribute('data-status', 'in_progress');
    expect(card).toHaveTextContent('running');
    expect(card).toHaveTextContent('tsc --noEmit');
  });
});

describe('ChatView approvals', () => {
  it.each(['claude', 'codex', 'copilot'] as const)('docks the provider options in place of the composer (%s)', (p) => {
    const { actions } = renderFixture(p, 'approval');
    const card = screen.getByTestId('chat-permission');
    expect(screen.queryByTestId('chat-composer')).not.toBeInTheDocument();
    expect(card).toHaveTextContent(PROFILES[p].installTitle);
    const labels = within(card).getAllByRole('button').map((b) => b.textContent);
    expect(labels).toHaveLength(PROFILES[p].installOptions.length);
    PROFILES[p].installOptions.forEach((o, i) => expect(labels[i]).toContain(o.label));
    expect(screen.getByTestId('pane-status')).toHaveTextContent('Needs you');
    expect(screen.getByTestId('chat-command-card')).toHaveTextContent('waiting for approval');

    fireEvent.click(within(card).getAllByRole('button')[1]);
    expect(actions.respondPermission).toHaveBeenCalledWith('perm-1', PROFILES[p].installOptions[1].optionId);
  });

  it('shows what an always-allow option covers', () => {
    renderFixture('claude', 'approval');
    expect(screen.getByTestId('chat-permission')).toHaveTextContent('Bash(npm install:*)');
  });

  it('answers with Enter, Esc and number keys', () => {
    const a1 = makeActions();
    const { unmount } = renderFixture('codex', 'approval', a1);
    fireEvent.keyDown(screen.getByTestId('chat-permission'), { key: 'Enter' });
    expect(a1.respondPermission).toHaveBeenCalledWith('perm-1', 'accept');
    unmount();

    const a2 = makeActions();
    const r2 = renderFixture('codex', 'approval', a2);
    fireEvent.keyDown(screen.getByTestId('chat-permission'), { key: 'Escape' });
    expect(a2.respondPermission).toHaveBeenCalledWith('perm-1', 'decline');
    r2.unmount();

    const a3 = makeActions();
    renderFixture('codex', 'approval', a3);
    fireEvent.keyDown(screen.getByTestId('chat-permission'), { key: '5' });
    expect(a3.respondPermission).toHaveBeenCalledWith('perm-1', 'cancel');
  });

  it('answers only once', () => {
    const { actions } = renderFixture('claude', 'approval');
    const card = screen.getByTestId('chat-permission');
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(actions.respondPermission).toHaveBeenCalledTimes(1);
  });

  it('returns to the composer once the request is resolved', () => {
    const events = chatFixture('claude', 'approval');
    const resolved = fold([...events, { ...events[events.length - 1], seq: events.length + 1, type: 'permission_resolved', data: { requestId: 'perm-1', decision: 'allow', by: 'user' } } as ChatEvent]);
    renderState(resolved);
    expect(screen.queryByTestId('chat-permission')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-composer')).toBeInTheDocument();
  });
});

describe('ChatView plans and questions', () => {
  it('shows a plan document with its structured approval (planApproval)', () => {
    const { actions } = renderFixture('claude', 'plan');
    expect(screen.getByTestId('chat-plan-document')).toHaveTextContent('Ready for review');
    expect(screen.getByTestId('chat-plan-document')).toHaveTextContent('Row layout.');
    const card = screen.getByTestId('chat-permission');
    expect(card).toHaveTextContent('Plan ready for review');
    expect(card).toHaveTextContent('acceptEdits mode');
    fireEvent.click(within(card).getByText("Allow and don't ask again"));
    expect(actions.respondPermission).toHaveBeenCalledWith('perm-plan', 'allow_always');
  });

  it('asks a question with options and free text', () => {
    const { actions } = renderFixture('codex', 'plan');
    expect(screen.getByTestId('chat-plan-document')).toHaveTextContent('Writing…');
    const q = screen.getByTestId('chat-question');
    const send = within(q).getByText('Send answer');
    expect(send).toBeDisabled();
    fireEvent.click(within(q).getByText('Replace the tooltips'));
    fireEvent.click(send);
    expect(actions.answerQuestion).toHaveBeenCalledWith('q-1', { tooltips: 'replace' });
  });

  it('submits a free-text answer', () => {
    const { actions } = renderFixture('codex', 'plan');
    fireEvent.change(screen.getByLabelText(/^Answer:/), { target: { value: 'Neither, remove them' } });
    fireEvent.click(screen.getByText('Send answer'));
    expect(actions.answerQuestion).toHaveBeenCalledWith('q-1', { tooltips: 'Neither, remove them' });
  });

  it('offers Clubhouse\'s own hand-off when the driver has no plan approval', async () => {
    const { actions } = renderFixture('copilot', 'plan');
    expect(screen.getByTestId('chat-tasks')).toHaveTextContent('0/4');
    fireEvent.click(screen.getByText('Switch to Ask first and implement'));
    await waitFor(() => expect(actions.send).toHaveBeenCalledWith('Implement the plan.', 'auto'));
    expect(actions.setLevel).toHaveBeenCalledWith('ask');
  });
});

describe('ChatView composer', () => {
  function type(text: string) {
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
  }

  it('sends with Enter when idle', () => {
    const { actions } = renderFixture('claude', 'conversation');
    expect(screen.getByTestId('chat-send')).toBeDisabled();
    type('Yes, do that too');
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    expect(actions.send).toHaveBeenCalledWith('Yes, do that too', 'auto');
    expect(screen.getByLabelText('Message')).toHaveValue('');
  });

  it('keeps Shift+Enter as a newline when idle', () => {
    const { actions } = renderFixture('claude', 'conversation');
    type('line one');
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter', shiftKey: true });
    expect(actions.send).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex'] as const)('steers with Enter and queues with Shift+Enter during a turn (%s)', (p) => {
    const { actions } = renderFixture(p, 'steer');
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Steer');
    expect(screen.getByTestId('chat-send-secondary')).toHaveTextContent('Queue');
    type('Keep the hover delay at 300ms');
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    expect(actions.send).toHaveBeenLastCalledWith('Keep the hover delay at 300ms', 'steer');
    type('Then rebase');
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter', shiftKey: true });
    expect(actions.send).toHaveBeenLastCalledWith('Then rebase', 'queued');
  });

  it('offers Stop & send when the driver cannot steer', async () => {
    const { actions } = renderFixture('copilot', 'steer');
    expect(screen.getByTestId('chat-send-primary')).toHaveTextContent('Stop & send');
    type('Actually, skip the tests');
    fireEvent.click(screen.getByTestId('chat-send-primary'));
    await waitFor(() => expect(actions.send).toHaveBeenCalledWith('Actually, skip the tests', 'auto'));
    expect(actions.interrupt).toHaveBeenCalled();
    expect(actions.interrupt.mock.invocationCallOrder[0]).toBeLessThan(actions.send.mock.invocationCallOrder[0]);
  });

  it('stops the turn with Esc or the Stop button', () => {
    const { actions } = renderFixture('claude', 'steer');
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Escape' });
    fireEvent.click(screen.getByTestId('chat-stop'));
    expect(actions.interrupt).toHaveBeenCalledTimes(2);
  });

  it('hides Stop when the driver cannot interrupt', () => {
    const state = fold(chatFixture('claude', 'steer'));
    renderState({ ...state, capabilities: { ...state.capabilities!, interrupt: false } });
    expect(screen.queryByTestId('chat-stop')).not.toBeInTheDocument();
  });

  it('shows tasks and the queue above the composer', () => {
    renderFixture('codex', 'steer');
    expect(screen.getByTestId('chat-tasks')).toHaveTextContent('3/4');
    const queue = screen.getByTestId('chat-queue');
    expect(queue).toHaveTextContent('2 · sent when this turn ends');
    expect(queue).toHaveTextContent('Then open a draft PR');
  });

  it('shows the model, effort and level', () => {
    renderFixture('claude', 'conversation');
    expect(screen.getByTestId('chat-model-pill')).toHaveTextContent('claude-opus-5-5');
    expect(screen.getByTestId('chat-effort-pill')).toHaveTextContent('High effort');
    expect(screen.getByTestId('chat-level-pill')).toHaveTextContent('Ask first');
  });

  it('lists only the levels the driver can switch to live', () => {
    const { actions } = renderFixture('copilot', 'conversation');
    fireEvent.click(screen.getByTestId('chat-level-pill'));
    const items = screen.getAllByRole('menuitemradio');
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(items[0]).toHaveTextContent('Plan');
    expect(items[1]).toHaveTextContent('Ask first');
    expect(items[2]).toHaveTextContent('Full access');
    fireEvent.click(items.find((i) => i.textContent?.startsWith('Plan'))!);
    expect(actions.setLevel).toHaveBeenCalledWith('plan');
  });

  it('disables the level menu when the driver reports no live levels', () => {
    const state = fold(chatFixture('claude', 'conversation'));
    renderState({ ...state, capabilities: { ...state.capabilities!, liveLevels: [] } });
    expect(screen.getByTestId('chat-level-pill')).toBeDisabled();
  });

  it('suggests slash commands only when the driver supports them', () => {
    const withCommands = (p: FixtureProvider) => {
      const f = chatFixture(p, 'conversation');
      const last = f[f.length - 1];
      return fold([...f, { ...last, seq: last.seq + 1, type: 'commands_available', data: { commands: [{ name: 'compact', description: 'Compact the context' }, { name: 'review' }] } } as ChatEvent]);
    };
    const { unmount } = renderState(withCommands('claude'));
    type('/co');
    expect(screen.getByTestId('chat-slash-menu')).toHaveTextContent('/compact');
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Tab' });
    expect(screen.getByLabelText('Message')).toHaveValue('/compact ');
    unmount();

    renderState(withCommands('codex'));
    type('/co');
    expect(screen.queryByTestId('chat-slash-menu')).not.toBeInTheDocument();
  });
});

describe('ChatView attachments', () => {
  const png = (name = 'shot.png') => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });
  const paste = (files: File[]) => fireEvent.paste(screen.getByLabelText('Message'), { clipboardData: { files } });
  /** Main's staging, faked: images are images, pasted when named like a paste, everything else a file. */
  function stageLike(overrides: Partial<{ pasted: boolean; kind: 'image' | 'file' }> = {}) {
    const stage = vi.fn(async (_agentId: string, f: File) => ({
      id: `staged-${f.name}`, name: f.name, size: f.size,
      kind: overrides.kind ?? (f.type.startsWith('image/') ? 'image' as const : 'file' as const),
      pasted: overrides.pasted ?? f.name.startsWith('image'),
      ...(f.type.startsWith('image/') ? { mimeType: f.type } : {}),
    }));
    window.clubhouse.chat.stageAttachment = stage as typeof window.clubhouse.chat.stageAttachment;
    return stage;
  }

  it('stages a pasted image, shows a thumbnail and sends only its staged id', async () => {
    const stage = stageLike();
    const { actions } = renderFixture('claude', 'conversation');
    paste([png('image.png')]);
    const chip = await screen.findByTestId('chat-attachment');
    expect(stage).toHaveBeenCalledWith(FIXTURE_AGENT_ID, expect.any(File), { imagesAllowed: true });
    expect(chip.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'What is wrong here?' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    expect(actions.send).toHaveBeenCalledWith('What is wrong here?', 'auto', ['staged-image.png']);
    expect(screen.queryByTestId('chat-attachment')).not.toBeInTheDocument();
  });

  it('sends dropped files without text, with a drop hint while dragging', async () => {
    stageLike();
    const { actions } = renderFixture('claude', 'conversation');
    const composer = screen.getByTestId('chat-composer');
    fireEvent.dragOver(composer, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByTestId('chat-drop-hint')).toHaveTextContent('Drop files to attach them');
    const notes = new File(['# notes'], 'notes.md', { type: 'text/markdown' });
    fireEvent.drop(composer, { dataTransfer: { files: [notes, png()], types: ['Files'] } });
    expect(screen.queryByTestId('chat-drop-hint')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId('chat-attachment')).toHaveLength(2));
    fireEvent.click(screen.getByTestId('chat-send'));
    expect(actions.send).toHaveBeenCalledWith('', 'auto', ['staged-notes.md', 'staged-shot.png']);
  });

  it('keeps the drop hint while dragging over the composer\'s own children', () => {
    stageLike();
    renderFixture('claude', 'conversation');
    const composer = screen.getByTestId('chat-composer');
    fireEvent.dragOver(composer, { dataTransfer: { types: ['Files'] } });
    // jsdom's DragEvent drops relatedTarget; a MouseEvent of the same type carries it.
    const leave = (relatedTarget: Element) => fireEvent(composer, new MouseEvent('dragleave', { bubbles: true, relatedTarget }));
    leave(screen.getByLabelText('Message'));
    expect(screen.getByTestId('chat-drop-hint')).toBeInTheDocument();
    leave(document.body);
    expect(screen.queryByTestId('chat-drop-hint')).not.toBeInTheDocument();
  });

  it('shows an image on disk as a file when the agent cannot take images', async () => {
    stageLike({ pasted: false });
    const state = fold(chatFixture('claude', 'conversation'));
    const { actions } = renderState({ ...state, capabilities: { ...state.capabilities!, images: false } });
    fireEvent.change(screen.getByTestId('chat-attach-input'), { target: { files: [png()] } });
    const chip = await screen.findByTestId('chat-attachment');
    expect(chip.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-send'));
    expect(actions.send).toHaveBeenCalledWith('', 'auto', ['staged-shot.png']);
  });

  it('explains why a pasted image cannot be attached when the agent cannot take images', async () => {
    const stage = stageLike({ pasted: true });
    const state = fold(chatFixture('claude', 'conversation'));
    renderState({ ...state, capabilities: { ...state.capabilities!, images: false } });
    paste([png('image.png')]);
    expect(await screen.findByTestId('chat-attach-error')).toHaveTextContent("can't take pasted images");
    // Staging is told, so it refuses before saving anything.
    expect(stage).toHaveBeenCalledWith(FIXTURE_AGENT_ID, expect.any(File), { imagesAllowed: false });
    expect(screen.queryByTestId('chat-attachment')).not.toBeInTheDocument();
  });

  it('shows main\'s reason when a file is refused', async () => {
    window.clubhouse.chat.stageAttachment = vi.fn(async () => {
      throw new Error("Error invoking remote method 'chat:stage-attachment': Error: Can't attach huge.bin: files must be 20 MB or smaller");
    });
    renderFixture('claude', 'conversation');
    fireEvent.change(screen.getByTestId('chat-attach-input'), { target: { files: [new File(['x'], 'huge.bin')] } });
    expect(await screen.findByTestId('chat-attach-error')).toHaveTextContent(/^Can't attach huge.bin: files must be 20 MB or smaller$/);
  });

  it('holds the 10-attachment cap across adds that are still staging', async () => {
    stageLike();
    renderFixture('claude', 'conversation');
    const input = screen.getByTestId('chat-attach-input');
    fireEvent.change(input, { target: { files: Array.from({ length: 6 }, (_, i) => new File(['x'], `a${i}.txt`)) } });
    fireEvent.change(input, { target: { files: Array.from({ length: 6 }, (_, i) => new File(['x'], `b${i}.txt`)) } });
    await waitFor(() => expect(screen.getAllByTestId('chat-attachment')).toHaveLength(10));
    expect(screen.getByTestId('chat-attach-error')).toHaveTextContent('Attach at most 10 files at a time');
  });

  it('removes an attachment', async () => {
    stageLike();
    renderFixture('claude', 'conversation');
    paste([png()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove shot.png' }));
    expect(screen.queryByTestId('chat-attachment')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-send')).toBeDisabled();
  });

  it('puts the text and attachments back when the message is not sent', async () => {
    stageLike();
    const actions = makeActions();
    actions.send.mockResolvedValueOnce(null as never);
    renderFixture('claude', 'conversation', actions);
    paste([png()]);
    await screen.findByTestId('chat-attachment');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'look' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    expect(await screen.findByTestId('chat-attachment')).toHaveTextContent('shot.png');
    expect(screen.getByLabelText('Message')).toHaveValue('look');
  });

  it('shows attachments on sent messages', () => {
    const events = extend(chatFixture('claude', 'conversation'), {
      type: 'user_message',
      data: {
        messageId: 'm-att', source: 'user', delivery: 'prompt',
        content: [{ type: 'image', mimeType: 'image/png', path: '/tmp/x/shot.png' }, { type: 'file', path: '/work/repo/notes.md' }],
      },
    });
    renderState(fold(events));
    const chips = screen.getAllByTestId('chat-user-attachments').at(-1)!;
    expect(chips).toHaveTextContent('shot.png');
    expect(chips).toHaveTextContent('notes.md');
  });
});

describe('ChatView subagents', () => {
  it.each(['claude', 'codex'] as const)('renders a subagent card with its work folded in (%s)', (p) => {
    renderFixture(p, 'subagents');
    const card = screen.getByTestId('chat-subagent');
    expect(card).toHaveTextContent(p === 'claude' ? 'Explore' : 'worker-1');
    expect(card).toHaveTextContent('12 tools');
    expect(card).toHaveTextContent('Found 3 consumers');
    fireEvent.click(within(card).getAllByRole('button', { expanded: false })[0]);
    expect(within(card).getAllByTestId('chat-tool-row')).toHaveLength(2);
  });

  it('shows subagent work as ordinary rows when only ids are reported', () => {
    renderFixture('copilot', 'subagents');
    expect(screen.queryByTestId('chat-subagent')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-explore-group')).toBeInTheDocument();
    expect(screen.getAllByTestId('chat-agent-message')).toHaveLength(2);
  });
});

describe('ChatView untested CLI version', () => {
  const versionNotice = { type: 'notice' as const, data: { level: 'info' as const, code: 'untested_cli_version', message: 'Claude Code 2.1.302 is newer than the version chat was tested with (2.1.301).' } };

  it('stays quiet when nothing went wrong', () => {
    renderState(fold(extend(chatFixture('claude', 'conversation'), versionNotice)));
    expect(screen.queryByTestId('chat-protocol-unknown')).not.toBeInTheDocument();
    expect(screen.queryByText(/newer than the version chat was tested with/)).not.toBeInTheDocument();
  });

  it('shows the version next to unrecognized messages', () => {
    renderState(fold(extend(chatFixture('claude', 'protocol_drift'), versionNotice)));
    const note = screen.getByTestId('chat-protocol-unknown');
    expect(note).toHaveTextContent('sent 2 messages Clubhouse doesn\'t recognize');
    expect(note).toHaveTextContent('Claude Code 2.1.302 is newer than the version chat was tested with (2.1.301).');
  });

  it('keeps the drift note to one line and lets it be dismissed until a new kind turns up (#2109)', () => {
    const drift = fold(chatFixture('claude', 'protocol_drift'));
    const { rerender } = renderState(drift);
    const note = screen.getByTestId('chat-protocol-unknown');
    expect(note.querySelector('.truncate')).not.toBeNull();
    expect(note).not.toHaveTextContent('some activity may be missing');
    fireEvent.click(screen.getByTestId('chat-protocol-unknown-dismiss'));
    expect(screen.queryByTestId('chat-protocol-unknown')).not.toBeInTheDocument();

    // More of the same kinds stay dismissed; a new kind brings it back.
    const kinds = Object.keys(drift.protocolUnknown);
    const more = { ...drift, protocolUnknown: { ...drift.protocolUnknown, [kinds[0]]: drift.protocolUnknown[kinds[0]] + 5 } };
    rerender(<ChatViewBody agent={agent} state={more} actions={makeActions()} providerName="Provider" onSwitchToTerminal={vi.fn()} />);
    expect(screen.queryByTestId('chat-protocol-unknown')).not.toBeInTheDocument();
    const newKind = { ...more, protocolUnknown: { ...more.protocolUnknown, 'field:system/next_thing': 1 } };
    rerender(<ChatViewBody agent={agent} state={newKind} actions={makeActions()} providerName="Provider" onSwitchToTerminal={vi.fn()} />);
    expect(screen.getByTestId('chat-protocol-unknown')).toBeInTheDocument();
  });

  it('uses a short drift note on canvas cards (#2109)', () => {
    render(<ChatViewBody agent={agent} state={fold(chatFixture('claude', 'protocol_drift'))} actions={makeActions()} providerName="Provider" context="canvas" />);
    const note = screen.getByTestId('chat-protocol-unknown');
    expect(note).toHaveTextContent('2 unrecognized CLI messages.');
    expect(note).not.toHaveTextContent('recognize yet');
  });

  it('shows the version after a fatal error', () => {
    renderState(fold(extend(chatFixture('claude', 'conversation'), versionNotice, { type: 'error', data: { code: 'process_exited', message: 'The CLI exited unexpectedly', fatal: true } })));
    const note = screen.getByTestId('chat-protocol-unknown');
    expect(note).toHaveTextContent('Claude Code 2.1.302 is newer');
    expect(note).not.toHaveTextContent('recognize');
  });
});

describe('ChatView failures', () => {
  it.each(['claude', 'codex', 'copilot'] as const)('shows a failed turn and keeps the composer (%s)', (p) => {
    renderFixture(p, 'turn_error');
    expect(screen.getByRole('alert')).toHaveTextContent('Usage limit reached');
    const footer = screen.getByTestId('chat-turn-footer');
    expect(footer).toHaveAttribute('data-stop-reason', 'error');
    expect(footer).toHaveTextContent('Turn failed');
    expect(screen.getByLabelText('Message')).not.toBeDisabled();
    expect(screen.queryByLabelText('Streaming')).not.toBeInTheDocument();
  });

  it.each(['claude', 'codex', 'copilot'] as const)('notes unrecognized protocol messages and a fatal exit (%s)', (p) => {
    renderFixture(p, 'protocol_drift');
    expect(screen.getByTestId('chat-protocol-unknown')).toHaveTextContent('sent 2 messages Clubhouse doesn\'t recognize');
    expect(screen.getByRole('alert')).toHaveTextContent('The CLI exited unexpectedly');
    expect(screen.getByLabelText('Message')).toBeDisabled();
    expect(screen.getByTestId('pane-status')).toHaveTextContent('Error');
  });
});

describe('ChatView (store-bound)', () => {
  beforeEach(() => {
    useChatStore.setState({ agents: {}, loading: {}, partial: {}, answering: {} });
  });

  it('reuses loaded state when a view remounts, as a canvas card does when zooming', async () => {
    const read = vi.fn(async () => chatFixture('claude', 'conversation'));
    vi.mocked(window.clubhouse.chat).readTranscript = read;
    const first = render(<ChatView agent={agent} context="canvas" />);
    await screen.findByTestId('chat-turn-footer');
    expect(read).toHaveBeenCalledWith(FIXTURE_AGENT_ID, CANVAS_TRANSCRIPT_TAIL);
    first.unmount();
    render(<ChatView agent={agent} context="canvas" />);
    expect(screen.getByTestId('chat-turn-footer')).toBeInTheDocument();
    expect(screen.queryByText('Loading the conversation…')).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('marks the view context, and keeps canvas cards out of the screen-reader live region', async () => {
    vi.mocked(window.clubhouse.chat).readTranscript = vi.fn(async () => chatFixture('claude', 'conversation'));
    render(<><ChatView agent={agent} /><ChatView agent={agent} context="canvas" /></>);
    const views = await screen.findAllByTestId('chat-view');
    expect(views.map((v) => v.getAttribute('data-view-context'))).toEqual(['main', 'canvas']);
    expect(screen.getAllByTestId('chat-live-region')).toHaveLength(1);
  });

  it('offers Show earlier when a tail cut history off, and loads all of it', async () => {
    const events = chatFixture('claude', 'conversation');
    const read = vi.fn(async (_id: string, tail?: number) => (tail ? events.slice(-tail) : events));
    vi.mocked(window.clubhouse.chat).readTranscript = read as typeof window.clubhouse.chat.readTranscript;
    // A tail as long as what comes back counts as cut off.
    await act(async () => { await useChatStore.getState().loadTranscript(FIXTURE_AGENT_ID, 3); });
    render(<ChatView agent={agent} context="canvas" />);
    fireEvent.click(screen.getByTestId('chat-show-earlier'));
    await waitFor(() => expect(read).toHaveBeenLastCalledWith(FIXTURE_AGENT_ID, undefined));
    await waitFor(() => expect(screen.queryByTestId('chat-show-earlier')).not.toBeInTheDocument());
  });

  it('a main view reloads the whole history over state that came from a tail', async () => {
    const read = vi.fn(async () => chatFixture('claude', 'conversation'));
    vi.mocked(window.clubhouse.chat).readTranscript = read;
    useChatStore.setState({ partial: { [FIXTURE_AGENT_ID]: true } });
    await act(async () => { await useChatStore.getState().loadTranscript(FIXTURE_AGENT_ID, 3); });
    read.mockClear();
    render(<ChatView agent={agent} />);
    await waitFor(() => expect(read).toHaveBeenCalledWith(FIXTURE_AGENT_ID, undefined));
  });

  it('disables an approval in every view while one view\'s answer is in flight, and sends it once', async () => {
    const events = chatFixture('codex', 'approval');
    vi.mocked(window.clubhouse.chat).readTranscript = vi.fn(async () => events);
    let finish!: () => void;
    const respond = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    vi.mocked(window.clubhouse.chat).respondPermission = respond;
    render(<><ChatView agent={agent} /><ChatView agent={agent} context="canvas" /></>);
    const cards = await screen.findAllByTestId('chat-permission');
    expect(cards).toHaveLength(2);
    const [first, second] = cards.map((c) => within(c).getAllByRole('button')[0]);
    fireEvent.click(first);
    await waitFor(() => expect(second).toBeDisabled());
    fireEvent.click(second);
    expect(respond).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
  });

  it('loads the transcript and applies live events on top', async () => {
    const events = chatFixture('codex', 'approval');
    const live = events.pop()!;
    vi.mocked(window.clubhouse.chat).readTranscript = vi.fn(async () => events);
    render(<ChatView agent={agent} />);
    await screen.findByTestId('chat-permission');
    expect(window.clubhouse.chat.readTranscript).toHaveBeenCalledWith(FIXTURE_AGENT_ID, undefined);
    act(() => { useChatStore.getState().applyEvent(live); });
    expect(screen.getByTestId('pane-status')).toHaveTextContent('Needs you');
  });

  it('sends through the chat API', async () => {
    vi.mocked(window.clubhouse.chat).readTranscript = vi.fn(async () => chatFixture('claude', 'conversation'));
    const sendMessage = vi.fn(async () => ({ delivery: 'prompt' as const }));
    vi.mocked(window.clubhouse.chat).sendMessage = sendMessage;
    render(<ChatView agent={agent} />);
    await screen.findByTestId('chat-turn-footer');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hi' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(FIXTURE_AGENT_ID, 'hi', 'auto'));
  });
});

describe('ChatView review fixes', () => {
  it('keeps the draft while an approval replaces the composer', () => {
    const actions = makeActions();
    const before = chatFixture('claude', 'approval').filter((e) => e.type !== 'permission_request' && !(e.type === 'session_state' && e.data.state === 'waiting_permission'));
    const { rerender } = render(<ChatViewBody agent={agent} state={fold(before)} actions={actions} providerName="P" />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'half-written thought' } });
    const pending = chatFixture('claude', 'approval');
    rerender(<ChatViewBody agent={agent} state={fold(pending)} actions={actions} providerName="P" />);
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    rerender(<ChatViewBody agent={agent} state={fold(extend(pending, { type: 'permission_resolved', data: { requestId: 'perm-1', decision: 'allow', by: 'user' } }))} actions={actions} providerName="P" />);
    expect(screen.getByLabelText('Message')).toHaveValue('half-written thought');
  });

  it('puts the text back when a message fails to send', async () => {
    const actions = makeActions();
    actions.send.mockResolvedValueOnce(null);
    renderState(fold(chatFixture('claude', 'conversation')), actions);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'try this' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue('try this'));
  });

  it('opens a second pending question unlocked', () => {
    const actions = makeActions();
    const q = (id: string) => ({ type: 'question' as const, data: { requestId: id, questions: [{ id: 'x', prompt: `Question ${id}`, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowFreeText: false }] } });
    const base = chatFixture('codex', 'conversation');
    const two = extend(base, q('q-a'), q('q-b'));
    const { rerender } = render(<ChatViewBody agent={agent} state={fold(two)} actions={actions} providerName="P" />);
    fireEvent.click(screen.getByText('A'));
    expect(actions.answerQuestion).toHaveBeenCalledWith('q-a', { x: 'a' });
    rerender(<ChatViewBody agent={agent} state={fold(extend(two, { type: 'question_resolved', data: { requestId: 'q-a', answers: { x: 'a' } } }))} actions={actions} providerName="P" />);
    expect(screen.getByTestId('chat-question')).toHaveTextContent('Question q-b');
    expect(screen.getByText('B').closest('button')).not.toBeDisabled();
    fireEvent.click(screen.getByText('B'));
    expect(actions.answerQuestion).toHaveBeenLastCalledWith('q-b', { x: 'b' });
  });

  it('unlocks the approval card when the answer fails', async () => {
    const actions = makeActions();
    actions.respondPermission.mockResolvedValueOnce(false);
    renderState(fold(chatFixture('codex', 'approval')), actions);
    const card = screen.getByTestId('chat-permission');
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(within(card).getAllByRole('button')[0]).toBeDisabled();
    await waitFor(() => expect(within(card).getAllByRole('button')[0]).not.toBeDisabled());
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(actions.respondPermission).toHaveBeenCalledTimes(2);
  });

  it('takes number keys and Esc while an option button has focus', () => {
    const { actions } = renderFixture('codex', 'approval');
    const button = within(screen.getByTestId('chat-permission')).getAllByRole('button')[0];
    button.focus();
    fireEvent.keyDown(button, { key: '2' });
    expect(actions.respondPermission).toHaveBeenCalledWith('perm-1', 'acceptForSession');
  });

  it('answers questions from the keyboard', () => {
    const { actions } = renderFixture('codex', 'plan');
    const card = screen.getByTestId('chat-question');
    fireEvent.keyDown(card, { key: '2' });
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(actions.answerQuestion).toHaveBeenCalledWith('q-1', { tooltips: 'both' });
  });

  it('announces a finished reply in a polite live region', () => {
    renderFixture('claude', 'conversation');
    const region = screen.getByTestId('chat-live-region');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Want me to move the orchestrator chip');
  });

  it('keeps the live region quiet while a reply streams', () => {
    const events = chatFixture('claude', 'conversation');
    const firstChunk = events.findIndex((e) => e.type === 'agent_message_chunk');
    renderState(fold(events.slice(0, firstChunk + 1)));
    expect(screen.getByTestId('chat-live-region')).toBeEmptyDOMElement();
  });
});

describe('ChatView agent details', () => {
  beforeEach(() => { useAgentDetailsStore.setState({ open: false, focus: null }); });

  it('hides the details column below 640px of pane, and brings it back when there is room', () => {
    const observers: Array<{ cb: ResizeObserverCallback; el?: Element }> = [];
    const Orig = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      private o: { cb: ResizeObserverCallback; el?: Element };
      constructor(cb: ResizeObserverCallback) { this.o = { cb }; observers.push(this.o); }
      observe(el: Element) { this.o.el = el; }
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    const resizePane = (width: number) => act(() => {
      for (const o of observers) {
        if (o.el?.getAttribute('data-testid') === 'chat-view') o.cb([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
      }
    });
    try {
      useAgentDetailsStore.setState({ open: true });
      renderFixture('claude', 'conversation');
      expect(screen.getByTestId('agent-details')).toBeInTheDocument();
      resizePane(560);
      expect(screen.queryByTestId('agent-details')).not.toBeInTheDocument();
      // Still "open": it comes back when the pane is wide again.
      expect(useAgentDetailsStore.getState().open).toBe(true);
      resizePane(1100);
      expect(screen.getByTestId('agent-details')).toBeInTheDocument();
    } finally {
      globalThis.ResizeObserver = Orig;
    }
  });

  it('shows and hides the details column from the toolbar, with every card collapsed', () => {
    renderFixture('claude', 'conversation');
    expect(screen.queryByTestId('agent-details')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agent-details-toggle'));
    const column = screen.getByTestId('agent-details');
    for (const id of ['changes', 'subagents', 'canvases', 'context', 'mcp', 'session']) {
      expect(within(column).getByTestId(`details-card-${id}`)).not.toHaveAttribute('data-open');
    }
    // The column sits beside the conversation, not over it.
    expect(column.parentElement).toBe(screen.getByTestId('chat-stream').closest('[data-testid="chat-view"] > div:last-child'));
    fireEvent.click(screen.getByTestId('agent-details-toggle'));
    expect(screen.queryByTestId('agent-details')).not.toBeInTheDocument();
  });

  it('opens the last turn\'s changes in the Changes card', async () => {
    window.clubhouse.chat.listCheckpoints = vi.fn(async () => [{ sessionId: 's', turnId: 't1', startedAt: 1, start: 'a', end: 'b' }]);
    window.clubhouse.chat.getChanges = vi.fn(async () => ({ available: true, files: [{ path: 'src/a.ts', status: 'modified' as const, additions: 1, deletions: 0, binary: false }] }));
    renderFixture('claude', 'conversation');
    fireEvent.click(screen.getByTestId('agent-details-toggle'));
    fireEvent.click(screen.getByTestId('details-card-changes-toggle'));
    fireEvent.click(screen.getByRole('button', { name: 'Last turn' }));
    expect(await screen.findByText('a.ts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revert last turn…' })).toBeInTheDocument();
  });

  it('shows the session model and plan limits in the Session card', () => {
    renderFixture('claude', 'conversation');
    fireEvent.click(screen.getByTestId('agent-details-toggle'));
    fireEvent.click(screen.getByTestId('details-card-session-toggle'));
    const card = screen.getByTestId('details-card-session');
    expect(card).toHaveTextContent('Runs on');
    expect(card).toHaveTextContent('Plan limits');
  });

  it('opens the Changes review from Review all and goes back to Chat', async () => {
    useProjectStore.setState({ projects: [{ id: 'proj-1', name: 'p', path: '/proj' } as never] });
    window.clubhouse.git.branchChanges = vi.fn(async () => ({
      available: true, branch: 'gallant-swift/rows', base: 'main', ahead: 1, uncommitted: 0,
      files: [{ path: 'src/a.ts', status: 'modified' as const, additions: 3, deletions: 1, binary: false }],
    }));
    window.clubhouse.git.info = vi.fn(async () => ({ status: [] }));
    window.clubhouse.git.branchLog = vi.fn(async () => []);
    window.clubhouse.git.pullRequestInfo = vi.fn(async () => ({ available: true, hasRemote: false }));
    window.clubhouse.git.branchFilePatch = vi.fn(async () => ({ patch: '' }));
    try {
      renderFixture('claude', 'conversation');
      fireEvent.click(screen.getByTestId('agent-details-toggle'));
      fireEvent.click(screen.getByTestId('details-card-changes-toggle'));
      fireEvent.click(await screen.findByTestId('details-review-all'));
      expect(await screen.findByTestId('changes-review')).toBeInTheDocument();
      expect(screen.getByTestId('view-changes')).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(screen.getByRole('radio', { name: 'Chat' }));
      expect(screen.queryByTestId('changes-review')).not.toBeInTheDocument();
    } finally {
      useProjectStore.setState({ projects: [] });
      useAgentDetailsStore.setState({ review: {} });
    }
  });

  it('says the agent needs you while the review is showing, with the way back', async () => {
    useProjectStore.setState({ projects: [{ id: 'proj-1', name: 'p', path: '/proj' } as never] });
    window.clubhouse.git.branchChanges = vi.fn(async () => ({ available: true, base: 'main', files: [] }));
    window.clubhouse.git.info = vi.fn(async () => ({ status: [] }));
    window.clubhouse.git.branchLog = vi.fn(async () => []);
    window.clubhouse.git.pullRequestInfo = vi.fn(async () => ({ available: true, hasRemote: false }));
    useAgentDetailsStore.setState({ review: { [agent.id]: true } });
    try {
      renderFixture('claude', 'approval');
      expect(await screen.findByTestId('changes-review')).toBeInTheDocument();
      expect(screen.getByTestId('review-needs-you')).toHaveTextContent('Needs you');
      fireEvent.click(screen.getByTestId('review-back-to-chat'));
      expect(screen.queryByTestId('changes-review')).not.toBeInTheDocument();
      expect(screen.getByTestId('chat-permission-feedback')).toBeInTheDocument();
    } finally {
      useProjectStore.setState({ projects: [] });
      useAgentDetailsStore.setState({ review: {} });
    }
  });

  it('is not offered in popouts or canvas cards', () => {
    const state = fold(chatFixture('claude', 'conversation'));
    const { rerender } = render(<ChatViewBody agent={agent} state={state} actions={makeActions()} context="popout" />);
    expect(screen.queryByTestId('agent-details-toggle')).not.toBeInTheDocument();
    rerender(<ChatViewBody agent={agent} state={state} actions={makeActions()} context="canvas" />);
    expect(screen.queryByTestId('agent-details-toggle')).not.toBeInTheDocument();
  });
});

describe('ChatView permission extras', () => {
  it('sends a denial message when the driver carries one', () => {
    const { actions } = renderFixture('claude', 'approval');
    const input = screen.getByTestId('chat-permission-feedback');
    expect(input).toHaveAttribute('placeholder', 'Deny, and tell gallant-swift what to do instead…');
    fireEvent.change(input, { target: { value: 'Use the existing validator instead' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(actions.respondPermission).toHaveBeenCalledWith('perm-1', 'deny', { message: 'Use the existing validator instead' });
  });

  it('attaches the message when the reject option is clicked, and not to an approval', () => {
    const a1 = makeActions();
    const r1 = renderFixture('claude', 'approval', a1);
    fireEvent.change(screen.getByTestId('chat-permission-feedback'), { target: { value: 'No network' } });
    fireEvent.click(screen.getByText('Deny'));
    expect(a1.respondPermission).toHaveBeenCalledWith('perm-1', 'deny', { message: 'No network' });
    r1.unmount();

    const a2 = makeActions();
    renderFixture('claude', 'approval', a2);
    fireEvent.change(screen.getByTestId('chat-permission-feedback'), { target: { value: 'ignored' } });
    fireEvent.click(screen.getByText('Allow'));
    expect(a2.respondPermission).toHaveBeenCalledWith('perm-1', 'allow');
  });

  it.each(['codex', 'copilot'] as const)('offers no message field when the driver does not report it (%s)', (p) => {
    renderFixture(p, 'approval');
    expect(screen.queryByTestId('chat-permission-feedback')).not.toBeInTheDocument();
  });

  it('approves an edited plan with updatedInput', () => {
    const { actions } = renderFixture('claude', 'plan');
    fireEvent.click(screen.getByText('Edit plan'));
    const editor = screen.getByLabelText('Edit the plan');
    fireEvent.change(editor, { target: { value: '1. Only the row layout.' } });
    expect(screen.getByText('Approving sends your edited plan.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Allow'));
    expect(actions.respondPermission).toHaveBeenCalledWith('perm-plan', 'allow', { updatedInput: { plan: '1. Only the row layout.' } });
  });

  it('approves an unedited plan without extras', () => {
    const { actions } = renderFixture('claude', 'plan');
    fireEvent.click(screen.getByText('Edit plan'));
    fireEvent.click(screen.getByText('Allow'));
    expect(actions.respondPermission).toHaveBeenCalledWith('perm-plan', 'allow');
  });

  it('sends plan feedback with the reject option', () => {
    const { actions } = renderFixture('claude', 'plan');
    const input = screen.getByTestId('chat-permission-feedback');
    expect(input).toHaveAttribute('placeholder', 'Deny, and tell gallant-swift what to change…');
    fireEvent.change(input, { target: { value: 'Also cover the canvas view' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(actions.respondPermission).toHaveBeenCalledWith('perm-plan', 'deny', { message: 'Also cover the canvas view' });
  });

  it('hides plan editing when the driver carries no updatedInput', () => {
    const state = fold(chatFixture('claude', 'plan'));
    renderState({ ...state, capabilities: { ...state.capabilities!, permissionExtras: { denyMessage: true, updatedInput: false } } });
    expect(screen.queryByText('Edit plan')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-permission-feedback')).toBeInTheDocument();
  });

  it('leaves typed digits in the message field', () => {
    const { actions } = renderFixture('claude', 'approval');
    const input = screen.getByTestId('chat-permission-feedback');
    fireEvent.change(input, { target: { value: '3 reasons' } });
    fireEvent.keyDown(input, { key: '3' });
    expect(actions.respondPermission).not.toHaveBeenCalled();
  });

  it.each(['1', 'Enter', 'Escape'])('pauses the %s shortcut while a message is typed, so it is not thrown away', (key) => {
    const { actions } = renderFixture('claude', 'approval');
    const card = screen.getByTestId('chat-permission');
    fireEvent.change(screen.getByTestId('chat-permission-feedback'), { target: { value: 'Use pnpm' } });
    expect(screen.getByTestId('chat-permission-shortcuts-paused')).toBeInTheDocument();
    fireEvent.keyDown(card, { key });
    expect(actions.respondPermission).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('chat-permission-feedback'), { target: { value: '' } });
    fireEvent.keyDown(card, { key: '1' });
    expect(actions.respondPermission).toHaveBeenCalledWith('perm-1', 'allow');
  });

  it('pauses shortcuts while the plan has unsent edits', () => {
    const { actions } = renderFixture('claude', 'plan');
    fireEvent.click(screen.getByText('Edit plan'));
    fireEvent.change(screen.getByLabelText('Edit the plan'), { target: { value: '1. Smaller plan.' } });
    fireEvent.keyDown(screen.getByTestId('chat-permission'), { key: 'Escape' });
    expect(actions.respondPermission).not.toHaveBeenCalled();
  });

  it('focuses the editor and reports it expanded when Edit plan opens it', () => {
    renderFixture('claude', 'plan');
    const toggle = screen.getByText('Edit plan');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByText('Hide plan editor')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Edit the plan')).toHaveFocus();
  });

  it('will not approve a cleared plan, and can restore it', () => {
    const { actions } = renderFixture('claude', 'plan');
    fireEvent.click(screen.getByText('Edit plan'));
    fireEvent.change(screen.getByLabelText('Edit the plan'), { target: { value: '   ' } });
    expect(screen.getByText("The plan is empty, so it can't be approved.")).toBeInTheDocument();
    const allow = screen.getByText('Allow').closest('button')!;
    expect(allow).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId('chat-permission'), { key: 'Enter' });
    expect(actions.respondPermission).not.toHaveBeenCalled();
    // Rejecting still works with an empty editor.
    expect(screen.getByText('Deny').closest('button')).not.toBeDisabled();

    fireEvent.click(screen.getByText('Restore original'));
    expect(allow).not.toBeDisabled();
    fireEvent.click(allow);
    expect(actions.respondPermission).toHaveBeenCalledWith('perm-plan', 'allow');
  });
});

describe('ChatView login banner', () => {
  it('offers the terminal when the CLI reports it needs a login', () => {
    const events = extend(chatFixture('codex', 'conversation'), { type: 'error', data: { code: 'auth_required', message: 'Not logged in', fatal: true } });
    const onSwitchToTerminal = vi.fn();
    render(<ChatViewBody agent={agent} state={fold(events)} actions={makeActions()} providerName="Codex" onSwitchToTerminal={onSwitchToTerminal} />);
    expect(screen.getByTestId('chat-login-banner')).toHaveTextContent('This CLI needs you to log in.');
    fireEvent.click(screen.getByRole('button', { name: 'Log in in the terminal' }));
    expect(onSwitchToTerminal).toHaveBeenCalled();
  });
});

describe('compound actions stop when their first step fails (#2057)', () => {
  it('sends after a successful interrupt (Stop & send)', async () => {
    const { actions } = renderFixture('copilot', 'steer');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Skip the tests' } });
    fireEvent.click(screen.getByTestId('chat-send-primary'));
    await waitFor(() => expect(actions.send).toHaveBeenCalledWith('Skip the tests', 'auto'));
    expect(actions.interrupt).toHaveBeenCalledTimes(1);
  });

  it('does not send when the interrupt fails, and puts the draft back', async () => {
    const actions = makeActions();
    actions.interrupt.mockResolvedValueOnce(false);
    renderFixture('copilot', 'steer', actions);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Skip the tests' } });
    fireEvent.click(screen.getByTestId('chat-send-primary'));
    await waitFor(() => expect(actions.interrupt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue('Skip the tests'));
    expect(actions.send).not.toHaveBeenCalled();
  });

  it('implements the plan after a successful level change', async () => {
    const { actions } = renderFixture('copilot', 'plan');
    fireEvent.click(screen.getByText('Switch to Ask first and implement'));
    await waitFor(() => expect(actions.send).toHaveBeenCalledWith('Implement the plan.', 'auto'));
    expect(actions.setLevel).toHaveBeenCalledWith('ask');
  });

  it('does not implement the plan when the level change fails', async () => {
    const actions = makeActions();
    actions.setLevel.mockResolvedValueOnce(false);
    renderFixture('copilot', 'plan', actions);
    fireEvent.click(screen.getByText('Switch to Ask first and implement'));
    await waitFor(() => expect(actions.setLevel).toHaveBeenCalledWith('ask'));
    // Let the failed level change settle and the handler finish before checking it didn't send.
    await act(async () => {
      await actions.setLevel.mock.results[0].value;
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(actions.send).not.toHaveBeenCalled();
  });
});
