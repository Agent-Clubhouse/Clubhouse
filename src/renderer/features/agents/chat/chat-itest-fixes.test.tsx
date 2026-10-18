/**
 * Fixes from the live chat test of 2026-10-18 (#2166, #2167, #2168, #2171),
 * driven by fixture event streams shaped like the Claude driver's output.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import type { ChatEvent, ToolCallContent } from '../../../../shared/chat';
import { foldChatEvents, type ChatViewState, type PlanDocumentItem, type QuestionItem } from '../../../stores/chatStore';
import { ChatViewBody } from './ChatView';
import { useChatDraftStore, type ChatActions } from './useChatSession';
import { ChatFixture, FIXTURE_AGENT_ID, PROFILES } from './fixtures';
import { buildStreamBlocks } from './view-model';

const agent: Agent = { id: FIXTURE_AGENT_ID, projectId: 'p', name: 'gallant-swift', kind: 'durable', status: 'running', color: 'emerald' };

function makeActions(): ChatActions {
  return {
    send: vi.fn(async () => ({ delivery: 'prompt' as const })),
    interrupt: vi.fn(async () => true),
    respondPermission: vi.fn(async () => true),
    answerQuestion: vi.fn(async () => true),
    setLevel: vi.fn(async () => true),
  };
}

const fold = (events: ChatEvent[]): ChatViewState => foldChatEvents(undefined, FIXTURE_AGENT_ID, events);
const renderState = (state: ChatViewState) => render(<ChatViewBody agent={agent} state={state} actions={makeActions()} providerName="Claude Code" />);

function claude(): ChatFixture {
  const prof = PROFILES.claude;
  const f = new ChatFixture();
  f.start(prof.driver, prof.provider, prof.capabilities);
  f.prompt('t1', 'go');
  return f;
}

/** Claude's AskUserQuestion: a pending tool call, then a question for the same tool call id. */
function askUserQuestion(f: ChatFixture): ChatFixture {
  f.emit('tool_call', {
    toolCallId: 'toolu_ask', kind: 'other', title: 'AskUserQuestion', status: 'pending', toolName: 'AskUserQuestion',
    rawInput: { questions: [{ question: 'Which date?', options: [{ label: '2026-10-18' }, { label: '2026-10-19' }] }] },
  }, { turnId: 't1' });
  f.emit('question', {
    requestId: 'q1', toolCallId: 'toolu_ask',
    questions: [{ id: 'Which date?', prompt: 'Which date?', options: [{ id: '2026-10-18', label: '2026-10-18' }, { id: '2026-10-19', label: '2026-10-19' }], allowFreeText: true }],
  }, { turnId: 't1' });
  return f;
}

/** Claude's ExitPlanMode: the tool call, its plan document and the approval request. */
function exitPlanMode(f: ChatFixture): ChatFixture {
  f.emit('tool_call', { toolCallId: 'toolu_plan', kind: 'switch_mode', title: 'Plan ready for review', status: 'pending', toolName: 'ExitPlanMode', rawInput: { plan: 'Ship on 2026-10-18' } }, { turnId: 't1' });
  f.emit('plan_document', { planId: 'toolu_plan', markdown: 'Ship on 2026-10-18', status: 'ready', toolCallId: 'toolu_plan' }, { turnId: 't1' });
  f.emit('permission_request', {
    requestId: 'p1', title: 'Plan ready for review', toolCallId: 'toolu_plan', toolName: 'ExitPlanMode', rawInput: { plan: 'Ship on 2026-10-18' },
    options: [
      { optionId: 'allow', kind: 'allow_once', label: 'Allow' },
      { optionId: 'allow_always', kind: 'allow_always', label: "Allow and don't ask again", scope: 'Auto-accept edits' },
      { optionId: 'deny', kind: 'reject_once', label: 'Deny' },
    ],
  }, { turnId: 't1' });
  return f;
}

/** A pending Edit with its permission request; `content` overrides the input diff the driver attaches. */
function editRequest(content?: ToolCallContent[]): ChatFixture {
  const f = claude();
  f.emit('tool_call', {
    toolCallId: 'toolu_edit', kind: 'edit', title: 'Edit PRINCIPLES.md', status: 'pending', toolName: 'Edit',
    locations: [{ path: '/work/PRINCIPLES.md' }],
    content: content ?? [{ type: 'diff', path: '/work/PRINCIPLES.md', oldText: 'Date: 2026-10-18', newText: 'Date: 2026-10-19' }],
  }, { turnId: 't1' });
  f.emit('permission_request', {
    requestId: 'p2', title: 'Edit PRINCIPLES.md', toolCallId: 'toolu_edit', toolName: 'Edit',
    options: [{ optionId: 'allow', kind: 'allow_once', label: 'Allow' }, { optionId: 'deny', kind: 'reject_once', label: 'Deny' }],
  }, { turnId: 't1' });
  return f;
}

beforeEach(() => {
  useChatDraftStore.setState({ drafts: {} });
});

describe('AskUserQuestion shows once (#2166)', () => {
  it('hides the raw tool card and shows an "Asked" row while the question waits', () => {
    const state = fold(askUserQuestion(claude()).events);
    expect(buildStreamBlocks(state).some((b) => b.type === 'item' && b.item.kind === 'tool_call')).toBe(false);
    renderState(state);
    expect(screen.queryByTestId('chat-tool-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-tool-args')).not.toBeInTheDocument();
    const row = screen.getByTestId('chat-question-row');
    expect(row).toHaveAttribute('data-state', 'asked');
    expect(row).toHaveTextContent('Asked');
    expect(row).toHaveTextContent('Which date?');
    expect(row).toHaveTextContent('waiting for your answer');
    // The dock still takes the answer.
    expect(screen.getByTestId('chat-question')).toBeInTheDocument();
  });

  it('keeps the question with its answer once answered', () => {
    const f = askUserQuestion(claude());
    f.emit('question_resolved', { requestId: 'q1', answers: { 'Which date?': '2026-10-19' } }, { turnId: 't1' });
    f.emit('tool_call_update', { toolCallId: 'toolu_ask', status: 'completed' }, { turnId: 't1' });
    const state = fold(f.events);
    const q = state.items.find((i): i is QuestionItem => i.kind === 'question');
    expect(q?.answers).toEqual({ 'Which date?': '2026-10-19' });
    renderState(state);
    const row = screen.getByTestId('chat-question-row');
    expect(row).toHaveAttribute('data-state', 'answered');
    expect(row).toHaveTextContent('Answered2026-10-19');
    expect(row).not.toHaveTextContent('waiting');
    expect(screen.queryByTestId('chat-tool-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-question')).not.toBeInTheDocument();
  });

  it('shows a free-text answer, and a cancelled question', () => {
    const f = askUserQuestion(claude());
    f.emit('question_resolved', { requestId: 'q1', answers: { 'Which date?': 'next week' } }, { turnId: 't1' });
    const { unmount } = renderState(fold(f.events));
    expect(screen.getByTestId('chat-question-row')).toHaveTextContent('next week');
    unmount();

    const g = askUserQuestion(claude());
    g.emit('question_resolved', { requestId: 'q1', answers: {}, cancelled: true }, { turnId: 't1' });
    renderState(fold(g.events));
    const row = screen.getByTestId('chat-question-row');
    expect(row).toHaveAttribute('data-state', 'cancelled');
    expect(row).toHaveTextContent('Not answered');
  });

  it('still sends the answer from the dock', () => {
    const actions = makeActions();
    render(<ChatViewBody agent={agent} state={fold(askUserQuestion(claude()).events)} actions={actions} providerName="P" />);
    const card = screen.getByTestId('chat-question');
    fireEvent.click(within(card).getByText('2026-10-19'));
    fireEvent.click(within(card).getByText('Send answer'));
    expect(actions.answerQuestion).toHaveBeenCalledWith('q1', { 'Which date?': '2026-10-19' });
  });
});

describe('plan card follows the approval (#2167)', () => {
  it('shows the edited plan and Approved after an edited approval', () => {
    const f = exitPlanMode(claude());
    // The driver re-emits the plan with the edited text, then resolves the request.
    f.emit('plan_document', { planId: 'toolu_plan', markdown: 'Ship on 2026-10-19', status: 'ready', toolCallId: 'toolu_plan' }, { turnId: 't1' });
    f.emit('permission_resolved', { requestId: 'p1', optionId: 'allow', decision: 'allow', by: 'user' });
    const state = fold(f.events);
    const plan = state.items.find((i): i is PlanDocumentItem => i.kind === 'plan_document');
    expect(plan).toMatchObject({ markdown: 'Ship on 2026-10-19', decision: 'approved' });
    renderState(state);
    const card = screen.getByTestId('chat-plan-document');
    expect(card).toHaveAttribute('data-decision', 'approved');
    expect(card).toHaveTextContent('Approved');
    expect(card).toHaveTextContent('Ship on 2026-10-19');
    expect(card).not.toHaveTextContent('Ready for review');
    // The ExitPlanMode call itself isn't shown again next to its plan.
    expect(screen.queryByTestId('chat-tool-card')).not.toBeInTheDocument();
  });

  it('marks a denied plan as not approved', () => {
    const f = exitPlanMode(claude());
    f.emit('permission_resolved', { requestId: 'p1', optionId: 'deny', decision: 'deny', by: 'user' });
    renderState(fold(f.events));
    const card = screen.getByTestId('chat-plan-document');
    expect(card).toHaveAttribute('data-decision', 'rejected');
    expect(card).toHaveTextContent('Not approved');
  });

  it('leaves the plan pending when the request is withdrawn', () => {
    const f = exitPlanMode(claude());
    f.emit('permission_resolved', { requestId: 'p1', decision: 'cancelled', by: 'agent' });
    renderState(fold(f.events));
    expect(screen.getByTestId('chat-plan-document')).toHaveTextContent('Ready for review');
  });

  it('names the always-allow mode by its level (#2169)', () => {
    renderState(fold(exitPlanMode(claude()).events));
    expect(screen.getByTestId('chat-permission')).toHaveTextContent('Auto-accept edits');
    expect(screen.getByTestId('chat-permission')).not.toHaveTextContent('acceptEdits');
  });
});

describe('edit approvals preview the change (#2168)', () => {
  it('shows a compact diff of the proposed edit in the approval card', () => {
    renderState(fold(editRequest().events));
    const card = screen.getByTestId('chat-permission');
    const preview = within(card).getByTestId('chat-permission-diff');
    expect(preview).toHaveTextContent('/work/PRINCIPLES.md');
    expect(preview).toHaveTextContent('Date: 2026-10-19');
    expect(preview).toHaveTextContent('+1');
    expect(preview).toHaveTextContent('−1');
  });

  it('shows no preview when the tool call has no diff', () => {
    renderState(fold(editRequest([]).events));
    expect(within(screen.getByTestId('chat-permission')).queryByTestId('chat-permission-diff')).not.toBeInTheDocument();
  });
});

describe('"waiting for approval" needs an open request (#2171)', () => {
  it('marks only the call with the open request', () => {
    const f = editRequest();
    // Another pending call, auto-approved: no permission request.
    f.emit('tool_call', { toolCallId: 'toolu_auto', kind: 'execute', title: 'ls', status: 'pending', toolName: 'Bash', rawInput: { command: 'ls' } }, { turnId: 't1' });
    renderState(fold(f.events));
    const stream = screen.getByTestId('chat-stream');
    expect(within(stream).getByTestId('chat-diff-card')).toHaveTextContent('waiting for approval');
    const cmd = within(stream).getByTestId('chat-command-card');
    expect(cmd).not.toHaveTextContent('waiting for approval');
    // Claude reports nothing between the call and its result: it's running (#2183 review).
    expect(cmd).toHaveTextContent('running');
    expect(cmd).not.toHaveTextContent('starting');
  });

  it('drops the label once the request is answered', () => {
    const f = editRequest();
    f.emit('permission_resolved', { requestId: 'p2', optionId: 'allow', decision: 'allow', by: 'user' });
    renderState(fold(f.events));
    expect(within(screen.getByTestId('chat-stream')).getByTestId('chat-diff-card')).not.toHaveTextContent('waiting for approval');
  });
});

describe('restart and failure states (#2183 review)', () => {
  it('a call left unfinished when its turn ended says stopped, not running', () => {
    const f = claude();
    f.emit('tool_call', { toolCallId: 'toolu_bash', kind: 'execute', title: 'sleep 99', status: 'in_progress', toolName: 'Bash', rawInput: { command: 'sleep 99' } }, { turnId: 't1' });
    f.end('t1', { stopReason: 'cancelled' });
    renderState(fold(f.events));
    const cmd = screen.getByTestId('chat-command-card');
    expect(cmd).toHaveTextContent('stopped');
    expect(cmd).not.toHaveTextContent('running');
  });

  it('a question whose turn ended unanswered says Not answered, not waiting', () => {
    const f = askUserQuestion(claude());
    f.end('t1', { stopReason: 'cancelled' });
    renderState(fold(f.events));
    const row = screen.getByTestId('chat-question-row');
    expect(row).toHaveAttribute('data-state', 'expired');
    expect(row).toHaveTextContent('Not answered');
    expect(row).not.toHaveTextContent('waiting');
    expect(screen.queryByTestId('chat-question')).not.toBeInTheDocument();
  });

  it('a restored question from a run that died with the app expires when the agent starts again', () => {
    const f = askUserQuestion(claude());
    // No turn_ended or session_ended: the app quit. The next run is a new session.
    f.sessionId = 'chat-session-2';
    f.start(PROFILES.claude.driver, PROFILES.claude.provider, PROFILES.claude.capabilities);
    renderState(fold(f.events));
    expect(screen.getByTestId('chat-question-row')).toHaveAttribute('data-state', 'expired');
    expect(screen.queryByTestId('chat-question')).not.toBeInTheDocument();
  });

  it('keeps the feedback sent with a denied plan visible on the plan card', () => {
    const f = exitPlanMode(claude());
    f.emit('permission_resolved', { requestId: 'p1', optionId: 'deny', decision: 'deny', by: 'user' });
    f.emit('tool_call_update', { toolCallId: 'toolu_plan', status: 'failed', error: 'Do it on Monday instead' }, { turnId: 't1' });
    renderState(fold(f.events));
    const card = screen.getByTestId('chat-plan-document');
    expect(within(card).getByTestId('chat-tool-error')).toHaveTextContent('Do it on Monday instead');
    expect(screen.queryByTestId('chat-tool-card')).not.toBeInTheDocument();
  });

  it('keeps a hidden question call\'s error visible on the question row', () => {
    const f = askUserQuestion(claude());
    f.emit('question_resolved', { requestId: 'q1', answers: {}, cancelled: true }, { turnId: 't1' });
    f.emit('tool_call_update', { toolCallId: 'toolu_ask', status: 'failed', error: '<tool_use_error>The user dismissed the question</tool_use_error>' }, { turnId: 't1' });
    renderState(fold(f.events));
    const row = screen.getByTestId('chat-question-row');
    expect(within(row).getByTestId('chat-tool-error').textContent).toBe('The user dismissed the question');
  });
});

describe('command approvals show the command (#2183 review)', () => {
  it('shows a Bash request\'s command once, with its repeated title said once', () => {
    const said = 'Show worktree status and how far main moved';
    const f = claude();
    f.emit('tool_call', { toolCallId: 'toolu_sh', kind: 'execute', title: said, status: 'pending', toolName: 'Bash', rawInput: { command: 'git status --short' } }, { turnId: 't1' });
    f.emit('permission_request', {
      requestId: 'p3', title: said, description: said, toolCallId: 'toolu_sh', toolName: 'Bash', rawInput: { command: 'git status --short' },
      options: [{ optionId: 'allow', kind: 'allow_once', label: 'Allow' }, { optionId: 'deny', kind: 'reject_once', label: 'Deny' }],
    }, { turnId: 't1' });
    renderState(fold(f.events));
    const card = screen.getByTestId('chat-permission');
    expect(within(card).getAllByText(said)).toHaveLength(1);
    expect(within(card).getByTestId('chat-permission-text')).toHaveTextContent('git status --short');
  });
});
