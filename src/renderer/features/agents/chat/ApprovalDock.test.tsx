import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PermissionCard, QuestionCard } from './ApprovalDock';
import type { PendingPermission, PendingQuestion } from '../../../stores/chatStore';
import type { ChatQuestion } from '../../../../shared/chat';

const request = (over: Partial<PendingPermission> = {}): PendingPermission => ({
  requestId: 'r1',
  title: 'Create file',
  options: [
    { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once' },
    { optionId: 'reject_once', kind: 'reject_once', label: 'Deny' },
  ],
  ts: 0,
  ...over,
});

describe('PermissionCard', () => {
  it('the pinned card scrolls its request above its options, which sit in a footer of their own (#3606)', () => {
    render(
      <PermissionCard
        compact
        request={request({ description: 'Because it needs to.', content: [{ type: 'text', text: 'npm test' }] })}
        queueSize={1}
        agentName="a"
        extras={{ denyMessage: true }}
        onRespond={vi.fn(async () => true)}
      />,
    );
    const card = screen.getByTestId('chat-permission');
    const body = screen.getByTestId('chat-permission-body');
    const actions = screen.getByTestId('chat-permission-actions');
    // The request is in the scrolling body; every option, and the message field, in the footer after it.
    expect(body).toHaveClass('overflow-y-auto');
    expect(body).toHaveTextContent('Create file');
    expect(within(body).getByTestId('chat-permission-description')).toBeInTheDocument();
    expect(within(body).getByTestId('chat-permission-text')).toHaveTextContent('npm test');
    expect(within(body).queryAllByRole('button')).toHaveLength(0);
    expect(within(actions).getAllByRole('button').map((b) => b.getAttribute('data-option-kind'))).toEqual(['allow_once', 'reject_once']);
    expect(within(actions).getByTestId('chat-permission-feedback')).toBeInTheDocument();
    expect(card.lastElementChild).toBe(actions);
    expect(actions).not.toHaveClass('overflow-y-auto');
  });

  it('the inline card keeps its single column, with no footer', () => {
    render(<PermissionCard request={request()} queueSize={1} agentName="a" onRespond={vi.fn(async () => true)} />);
    expect(screen.queryByTestId('chat-permission-body')).toBeNull();
    expect(screen.queryByTestId('chat-permission-actions')).toBeNull();
    expect(within(screen.getByTestId('chat-permission')).getAllByRole('button')).toHaveLength(2);
  });

  it('shows the path and a preview of the change when the request carries them (#2159)', () => {
    render(
      <PermissionCard
        request={request({
          description: '/workspace/project/hello.txt',
          content: [{ type: 'diff', path: '/workspace/project/hello.txt', newText: 'hi\nthere' }],
        })}
        queueSize={1}
        agentName="lucky-mantis"
        onRespond={vi.fn(async () => true)}
      />,
    );
    expect(screen.getByTestId('chat-permission-description').textContent).toBe('/workspace/project/hello.txt');
    const preview = screen.getByTestId('chat-permission-preview');
    expect(within(preview).getByTestId('chat-diff-card')).toBeTruthy();
    expect(preview.textContent).toContain('there');
  });

  it('shows text content as a block, and nothing extra without content', () => {
    const { rerender } = render(
      <PermissionCard request={request({ content: [{ type: 'text', text: 'rm -rf build' }] })} queueSize={1} agentName="a" onRespond={vi.fn(async () => true)} />,
    );
    expect(screen.getByTestId('chat-permission-preview').textContent).toBe('rm -rf build');
    rerender(<PermissionCard request={request()} queueSize={1} agentName="a" onRespond={vi.fn(async () => true)} />);
    expect(screen.queryByTestId('chat-permission-preview')).toBeNull();
    expect(screen.queryByTestId('chat-permission-description')).toBeNull();
  });

  it('previews the request content when there is some, else the tool call diff: never both (#2174, #2168)', () => {
    const toolDiff = { type: 'diff' as const, path: '/w/a.md', oldText: 'tool old', newText: 'tool new' };
    const { rerender } = render(
      <PermissionCard
        request={request({ description: '/w/a.md', content: [{ type: 'diff', path: '/w/a.md', oldText: 'req old', newText: 'req new' }] })}
        diffs={[toolDiff]}
        queueSize={1}
        agentName="a"
        onRespond={vi.fn(async () => true)}
      />,
    );
    let preview = screen.getByTestId('chat-permission-preview');
    expect(within(preview).getAllByTestId('chat-diff-card')).toHaveLength(1);
    expect(preview).toHaveTextContent('req new');
    expect(preview).not.toHaveTextContent('tool new');
    expect(screen.getAllByTestId('chat-permission-diff')).toHaveLength(1);
    // Paths in the description read as code only next to a preview the request carries.
    expect(screen.getByTestId('chat-permission-description').className).toContain('font-mono');

    rerender(<PermissionCard request={request({ description: 'Claude wants to edit a file' })} diffs={[toolDiff]} queueSize={1} agentName="a" onRespond={vi.fn(async () => true)} />);
    preview = screen.getByTestId('chat-permission-preview');
    expect(within(preview).getAllByTestId('chat-diff-card')).toHaveLength(1);
    expect(preview).toHaveTextContent('tool new');
    expect(screen.getByTestId('chat-permission-description').className).not.toContain('font-mono');
  });

  it('says a title repeated as the description once, and shows the command it would run (#2183 review)', () => {
    const said = 'Show worktree status and how far main moved';
    const cmd = 'cd /w/gallant-swift-2053 && git status --short && git log --oneline HEAD..origin/main';
    render(
      <PermissionCard
        request={request({ title: said, description: said, toolName: 'Bash', rawInput: { command: cmd } })}
        command={cmd}
        queueSize={1}
        agentName="a"
        onRespond={vi.fn(async () => true)}
      />,
    );
    const card = screen.getByTestId('chat-permission');
    expect(within(card).getAllByText(said)).toHaveLength(1);
    expect(screen.queryByTestId('chat-permission-description')).toBeNull();
    const shown = within(screen.getByTestId('chat-permission-preview')).getByTestId('chat-permission-text');
    expect(shown.textContent).toBe(cmd);
    expect(shown.className).toContain('font-mono');
  });

  it('shows a description that adds something, and no command block without a command', () => {
    render(<PermissionCard request={request({ title: 'Run a command', description: 'Lists the build folder' })} queueSize={1} agentName="a" onRespond={vi.fn(async () => true)} />);
    expect(screen.getByTestId('chat-permission-description')).toHaveTextContent('Lists the build folder');
    expect(screen.queryByTestId('chat-permission-preview')).toBeNull();
  });
});

describe('QuestionCard', () => {
  const long = 'A long description that explains the trade-offs of this option in enough detail that it would take several lines to read in full at the dock width.';
  const questions = (n: number): ChatQuestion[] => Array.from({ length: n }, (_, i) => ({
    id: `q${i + 1}`,
    prompt: `Question ${i + 1}`,
    allowFreeText: false,
    options: [
      { id: 'a', label: `Option ${i + 1}a`, description: long },
      { id: 'b', label: `Option ${i + 1}b`, description: 'Short.' },
      { id: 'c', label: `Option ${i + 1}c` },
    ],
  }));
  const pending = (qs: ChatQuestion[]): PendingQuestion => ({ requestId: 'qr', questions: qs, ts: 0 });
  const renderCard = (qs: ChatQuestion[]) => {
    const onAnswer = vi.fn(async () => true);
    render(<QuestionCard request={pending(qs)} onAnswer={onAnswer} />);
    return { onAnswer, card: screen.getByTestId('chat-question') };
  };

  it('opens only the current question and collapses the rest behind a stepper', () => {
    const { card } = renderCard(questions(6));
    expect(screen.getAllByTestId('chat-question-current')).toHaveLength(1);
    expect(screen.getByTestId('chat-question-current')).toHaveTextContent('Question 1');
    expect(screen.getAllByTestId('chat-question-collapsed')).toHaveLength(5);
    expect(screen.getByTestId('chat-question-step')).toHaveTextContent('1 of 6');
    expect(within(card).queryByText('Option 2a')).toBeNull();
    expect(screen.getByText('Previous')).toBeDisabled();

    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByTestId('chat-question-step')).toHaveTextContent('2 of 6');
    expect(screen.getByTestId('chat-question-current')).toHaveTextContent('Question 2');

    // A collapsed row opens its question.
    fireEvent.click(screen.getAllByTestId('chat-question-collapsed')[4]);
    expect(screen.getByTestId('chat-question-step')).toHaveTextContent('6 of 6');
    expect(screen.getByText('Next')).toBeDisabled();
  });

  it('moves on after a single choice and shows answers on the collapsed rows', () => {
    const { card, onAnswer } = renderCard(questions(3));
    const send = screen.getByText('Send answer');
    fireEvent.click(screen.getByText('Option 1b'));
    expect(screen.getByTestId('chat-question-step')).toHaveTextContent('2 of 3');
    expect(screen.getAllByTestId('chat-question-collapsed')[0]).toHaveTextContent('Option 1b');
    expect(screen.getAllByTestId('chat-question-collapsed')[1]).toHaveTextContent('Not answered');
    // Number keys answer the open question.
    fireEvent.keyDown(card, { key: '3' });
    expect(screen.getByTestId('chat-question-step')).toHaveTextContent('3 of 3');
    expect(send).toBeDisabled();
    fireEvent.keyDown(card, { key: '1' });
    expect(send).not.toBeDisabled();
    fireEvent.click(send);
    expect(onAnswer).toHaveBeenCalledWith('qr', { q1: 'b', q2: 'c', q3: 'a' });
  });

  it('a double click on a single-choice question answers at most one request', () => {
    const onAnswer = vi.fn(async () => true);
    const next: PendingQuestion = { requestId: 'qr2', questions: questions(1), ts: 1 };
    const { rerender } = render(<QuestionCard key="qr" request={pending(questions(1))} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText('Option 1b'), { detail: 1 });
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('qr', { q1: 'b' });
    // ChatView keys the card by request: the next request's card takes the first one's place.
    rerender(<QuestionCard key="qr2" request={next} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText('Option 1b'), { detail: 2 });
    expect(onAnswer).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Option 1b'), { detail: 1 });
    expect(onAnswer).toHaveBeenLastCalledWith('qr2', { q1: 'b' });
  });

  it('a double click on a stepped question does not answer the question that opens next', () => {
    const { onAnswer } = renderCard(questions(3));
    fireEvent.click(screen.getByText('Option 1b'), { detail: 1 });
    expect(screen.getByTestId('chat-question-step')).toHaveTextContent('2 of 3');
    // The second press lands on question 2's option in the same place.
    fireEvent.click(screen.getByText('Option 2b').closest('button')!, { detail: 2 });
    expect(screen.getByTestId('chat-question-step')).toHaveTextContent('2 of 3');
    expect(screen.getAllByTestId('chat-question-collapsed')[0]).toHaveTextContent('Option 1b');
    expect(screen.getByText('Option 2b').closest('button')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByText('Option 2b').closest('button')!, { detail: 1 });
    expect(screen.getByTestId('chat-question-step')).toHaveTextContent('3 of 3');
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('the second press of a double click on Send answer sends nothing', () => {
    const { onAnswer } = renderCard(questions(2));
    fireEvent.click(screen.getByText('Option 1a'));
    fireEvent.click(screen.getByText('Option 2c'));
    const send = screen.getByText('Send answer');
    expect(send).not.toBeDisabled();
    fireEvent.click(send, { detail: 2 });
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.click(send, { detail: 1 });
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('qr', { q1: 'a', q2: 'c' });
  });

  it('keeps keyboard focus on the card after the open question changes', () => {
    const { card } = renderCard(questions(3));
    const option = screen.getByText('Option 1a').closest('button')!;
    option.focus();
    fireEvent.click(option);
    expect(document.activeElement).toBe(card);
    fireEvent.keyDown(card, { key: '2' });
    expect(screen.getByTestId('chat-question-step')).toHaveTextContent('3 of 3');
  });

  it('advances to the next unanswered question, and not after a multi-select pick', () => {
    const qs = questions(3);
    qs[1] = { ...qs[1], multiSelect: true };
    renderCard(qs);
    fireEvent.click(screen.getAllByTestId('chat-question-collapsed')[1]);
    fireEvent.click(screen.getByText('Option 3c'));
    // Question 3 answered: back to the first unanswered one after it, else the next.
    expect(screen.getByTestId('chat-question-step')).toHaveTextContent('3 of 3');
    fireEvent.click(screen.getAllByTestId('chat-question-collapsed')[0]);
    fireEvent.click(screen.getByText('Option 1a'));
    expect(screen.getByTestId('chat-question-step')).toHaveTextContent('2 of 3');
    fireEvent.click(screen.getByText('Option 2a'));
    expect(screen.getByTestId('chat-question-step')).toHaveTextContent('2 of 3');
    // Unticking every choice leaves the question unanswered.
    fireEvent.click(screen.getByText('Option 2a'));
    expect(screen.getByText('Send answer')).toBeDisabled();
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getAllByTestId('chat-question-collapsed')[1]).toHaveTextContent('Not answered');
  });

  it('summarises a free-text answer on its collapsed row', () => {
    const qs = questions(2).map((q) => ({ ...q, allowFreeText: true }));
    renderCard(qs);
    fireEvent.change(screen.getByLabelText(/^Answer:/), { target: { value: 'Something else' } });
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getAllByTestId('chat-question-collapsed')[0]).toHaveTextContent('Something else');
  });

  it('keeps the send row outside the scrolling questions', () => {
    const { card } = renderCard(questions(6));
    const body = screen.getByTestId('chat-question-body');
    expect(card).toHaveClass('min-h-0', 'flex', 'flex-col');
    expect(body).toHaveClass('min-h-0', 'overflow-y-auto');
    expect(body).not.toContainElement(screen.getByText('Send answer'));
    expect(body).not.toContainElement(screen.getByTestId('chat-question-step'));
  });

  it('clamps long option descriptions behind a toggle', () => {
    renderCard(questions(1));
    const [longDesc, shortDesc] = screen.getAllByTestId('chat-question-description');
    expect(longDesc).toHaveClass('line-clamp-2');
    expect(shortDesc).not.toHaveClass('line-clamp-2');
    const toggle = screen.getByText('Show more');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(longDesc).not.toHaveClass('line-clamp-2');
    expect(screen.getByText('Show less')).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows no stepper for a single question', () => {
    renderCard([{ ...questions(1)[0], multiSelect: true }]);
    expect(screen.queryByTestId('chat-question-step')).toBeNull();
    expect(screen.queryByTestId('chat-question-collapsed')).toBeNull();
    expect(screen.getByText('Send answer')).toBeInTheDocument();
  });
});
