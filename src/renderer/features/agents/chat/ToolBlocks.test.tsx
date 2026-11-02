import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ChatItem, ToolCallItem } from '../../../stores/chatStore';
import { ApprovalDiffPreview, AwaitingApprovalContext, ChatterGroup, CommandCard, DiffCard, LiveTurnContext, ToolCallView } from './ToolBlocks';

function tool(over: Partial<ToolCallItem>): ToolCallItem {
  return {
    kind: 'tool_call',
    id: 't-1',
    sessionId: 's-1',
    seq: 1,
    ts: 0,
    toolCallId: 't-1',
    toolKind: 'other',
    title: 'Tool',
    status: 'completed',
    content: [],
    ...over,
  };
}

const command = (over: Partial<ToolCallItem> = {}) => tool({
  toolKind: 'execute',
  title: 'Typecheck',
  rawInput: { command: 'npm run typecheck' },
  content: [{ type: 'terminal', terminalId: 'term-1', command: 'npm run typecheck', output: 'Found 0 errors\n', exitCode: 0 }],
  durationMs: 4200,
  ...over,
});

const edit = (over: Partial<ToolCallItem> = {}) => tool({
  toolKind: 'edit',
  title: 'Edit src/a.ts',
  locations: [{ path: 'src/a.ts' }],
  content: [{ type: 'diff', path: 'src/a.ts', oldText: 'const a = 1;\n', newText: 'const a = 2;\n' }],
  ...over,
});

const mcp = (over: Partial<ToolCallItem> = {}) => tool({
  title: 'mcp__clubhouse__post_bulletin',
  toolName: 'mcp__clubhouse__post_bulletin',
  rawInput: { topic: 'theme-fixes', body: 'PR up' },
  content: [{ type: 'text', text: '{"posted":true}' }],
  durationMs: 300,
  ...over,
});

function expandButton(card: HTMLElement) {
  return within(card).getByRole('button', { expanded: false });
}

describe('tool calls in the transcript (#2110)', () => {
  it('renders a command as one collapsed row and expands to its output', () => {
    render(<ToolCallView tool={command()} />);
    const card = screen.getByTestId('chat-command-card');
    expect(card).toHaveAttribute('data-open', 'false');
    expect(card).toHaveTextContent('$ npm run typecheck');
    expect(card).toHaveTextContent('exit 0');
    expect(card).toHaveTextContent('4s');
    expect(card).not.toHaveTextContent('Found 0 errors');

    fireEvent.click(expandButton(card));
    expect(card).toHaveAttribute('data-open', 'true');
    expect(card).toHaveTextContent('Found 0 errors');

    fireEvent.click(within(card).getByRole('button', { expanded: true }));
    expect(card).not.toHaveTextContent('Found 0 errors');
  });

  it('renders an edit as its header row and expands to the diff', () => {
    render(<ToolCallView tool={edit()} />);
    const card = screen.getByTestId('chat-diff-card');
    expect(card).toHaveTextContent('src/a.ts');
    expect(card).toHaveTextContent('+1');
    expect(card).toHaveTextContent('−1');
    expect(card.querySelector('[data-diff]')).toBeNull();

    fireEvent.click(expandButton(card));
    expect(card.querySelector('[data-diff="add"]')).toHaveTextContent('const a = 2;');
  });

  it('renders an MCP call as a server and tool row and expands to arguments and result', () => {
    render(<ToolCallView tool={mcp()} />);
    const card = screen.getByTestId('chat-tool-card');
    expect(card).toHaveAttribute('data-mcp', 'true');
    expect(card).toHaveTextContent('clubhouse · post_bulletin');
    expect(card).toHaveTextContent('theme-fixes');
    expect(screen.queryByTestId('chat-tool-args')).toBeNull();
    expect(screen.queryByTestId('chat-tool-result')).toBeNull();

    fireEvent.click(expandButton(card));
    expect(screen.getByTestId('chat-tool-args')).toHaveTextContent('"body": "PR up"');
    expect(screen.getByTestId('chat-tool-result')).toHaveTextContent('{"posted":true}');
  });

  it("labels an MCP call by the session's known server when the server name has `__`", () => {
    render(<ToolCallView tool={mcp({ toolName: 'mcp__my__server__do_thing' })} mcpServers={[{ name: 'my__server', status: 'connected' }]} />);
    expect(screen.getByTestId('chat-tool-card')).toHaveTextContent('my__server · do_thing');
  });

  it('falls back to the raw output for an MCP result with no text (Codex)', () => {
    render(<ToolCallView tool={mcp({ content: [], rawOutput: { content: [{ type: 'text', text: 'ok' }] } })} />);
    fireEvent.click(expandButton(screen.getByTestId('chat-tool-card')));
    expect(screen.getByTestId('chat-tool-result')).toHaveTextContent('"text": "ok"');
  });

  it('collapses other tools too, with no toggle when there is nothing to show', () => {
    const { rerender } = render(<ToolCallView tool={tool({ title: 'TodoWrite', rawInput: { todos: [] }, content: [{ type: 'text', text: 'Todos updated' }] })} />);
    const card = screen.getByTestId('chat-tool-card');
    expect(card).not.toHaveTextContent('Todos updated');
    fireEvent.click(expandButton(card));
    expect(card).toHaveTextContent('Todos updated');

    rerender(<ToolCallView tool={tool({ id: 't-2', title: 'Ping' })} />);
    expect(within(screen.getByTestId('chat-tool-card')).queryByRole('button')).toBeNull();
  });

  describe('the open rule', () => {
    it('keeps a running command collapsed', () => {
      render(<ToolCallView tool={command({ status: 'in_progress', durationMs: undefined, content: [{ type: 'terminal', terminalId: 'term-1', command: 'npm test', output: 'line 1\n' }] })} />);
      const card = screen.getByTestId('chat-command-card');
      expect(card).toHaveAttribute('data-open', 'false');
      expect(card).toHaveTextContent('running');
    });

    it('opens failed calls so the error is in view', () => {
      render(
        <>
          <ToolCallView tool={command({ status: 'failed', error: 'Command timed out', content: [{ type: 'terminal', terminalId: 'term-1', command: 'npm test', output: 'FAIL a.test.ts\n', exitCode: 1 }] })} />
          <ToolCallView tool={mcp({ id: 't-2', status: 'failed', error: 'Not connected' })} />
          <ToolCallView tool={edit({ id: 't-3', status: 'failed' })} />
        </>,
      );
      expect(screen.getByTestId('chat-command-card')).toHaveAttribute('data-open', 'true');
      expect(screen.getByTestId('chat-command-card')).toHaveTextContent('FAIL a.test.ts');
      expect(screen.getByTestId('chat-command-card')).toHaveTextContent('Command timed out');
      expect(screen.getByTestId('chat-tool-card')).toHaveTextContent('Not connected');
      expect(screen.getByTestId('chat-diff-card')).toHaveAttribute('data-open', 'true');
    });

    it('opens calls waiting for approval', () => {
      render(
        <AwaitingApprovalContext.Provider value={new Set(['t-1'])}>
          <ToolCallView tool={edit({ status: 'pending' })} />
        </AwaitingApprovalContext.Provider>,
      );
      const card = screen.getByTestId('chat-diff-card');
      expect(card).toHaveAttribute('data-open', 'true');
      expect(card).toHaveTextContent('waiting for approval');
    });

    it('says "waiting for approval" only when a permission request is open (#2171)', () => {
      const { unmount } = render(<ToolCallView tool={edit({ status: 'pending' })} />);
      expect(screen.getByTestId('chat-diff-card')).not.toHaveTextContent('waiting for approval');
      unmount();
      const cmd = command({ status: 'pending' });
      const r2 = render(<ToolCallView tool={cmd} />);
      expect(screen.getByTestId('chat-command-card')).not.toHaveTextContent('waiting for approval');
      r2.unmount();
      render(
        <AwaitingApprovalContext.Provider value={new Set([cmd.toolCallId])}>
          <ToolCallView tool={cmd} />
        </AwaitingApprovalContext.Provider>,
      );
      expect(screen.getByTestId('chat-command-card')).toHaveTextContent('waiting for approval');
    });

    it('shows an unfinished call as running while its turn runs, and stopped after (#2183 review)', () => {
      const pending = command({ status: 'pending', turnId: 'turn-1', durationMs: undefined, content: [{ type: 'terminal', terminalId: 'term-1', command: 'npm test', output: '' }] });
      const { unmount } = render(<LiveTurnContext.Provider value="turn-1"><ToolCallView tool={pending} /></LiveTurnContext.Provider>);
      expect(screen.getByTestId('chat-command-card')).toHaveTextContent('running');
      expect(screen.getByLabelText('Running')).toBeInTheDocument();
      unmount();
      const r2 = render(<LiveTurnContext.Provider value={null}><ToolCallView tool={pending} /></LiveTurnContext.Provider>);
      expect(screen.getByTestId('chat-command-card')).toHaveTextContent('stopped');
      expect(screen.queryByLabelText('Running')).toBeNull();
      r2.unmount();
      render(<LiveTurnContext.Provider value="turn-2"><ToolCallView tool={tool({ status: 'in_progress', turnId: 'turn-1' })} /></LiveTurnContext.Provider>);
      expect(screen.getByTestId('chat-tool-card')).toHaveTextContent('stopped');
    });

    it('keeps a failed call\'s error visible after the card is collapsed (#2183 review)', () => {
      render(
        <>
          <ToolCallView tool={command({ status: 'failed', error: 'Permission denied: rm', content: [{ type: 'terminal', terminalId: 'term-1', command: 'rm x', output: 'partial' }] })} />
          <ToolCallView tool={mcp({ id: 't-2', status: 'failed', rawInput: { q: 'x' }, error: 'User denied the call: not now' })} />
        </>,
      );
      fireEvent.click(screen.getByRole('button', { name: /Collapse command/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Collapse / }));
      expect(screen.getByTestId('chat-command-card')).toHaveAttribute('data-open', 'false');
      expect(screen.getByTestId('chat-tool-card')).toHaveAttribute('data-open', 'false');
      const errors = screen.getAllByTestId('chat-tool-error').map((e) => e.textContent);
      expect(errors).toEqual(['Permission denied: rm', 'User denied the call: not now']);
    });

    it('opens a running call when it fails', () => {
      const running = command({ status: 'in_progress', content: [{ type: 'terminal', terminalId: 'term-1', command: 'npm test', output: '' }] });
      const { rerender } = render(<ToolCallView tool={running} />);
      expect(screen.getByTestId('chat-command-card')).toHaveAttribute('data-open', 'false');
      rerender(<ToolCallView tool={{ ...running, status: 'failed', content: [{ type: 'terminal', terminalId: 'term-1', command: 'npm test', output: 'boom\n', exitCode: 1 }] }} />);
      expect(screen.getByTestId('chat-command-card')).toHaveAttribute('data-open', 'true');
      expect(screen.getByTestId('chat-command-card')).toHaveTextContent('boom');
    });

    it("keeps the user's choice when the status changes", () => {
      const running = command({ status: 'in_progress', content: [{ type: 'terminal', terminalId: 'term-1', command: 'npm test', output: '' }] });
      const { rerender } = render(<ToolCallView tool={running} />);
      const card = screen.getByTestId('chat-command-card');
      fireEvent.click(expandButton(card));
      fireEvent.click(within(card).getByRole('button', { expanded: true }));
      rerender(<ToolCallView tool={{ ...running, status: 'failed' }} />);
      expect(screen.getByTestId('chat-command-card')).toHaveAttribute('data-open', 'false');
    });
  });

  it('names a long command by its first line, capped, and shows it in full when open (live test)', () => {
    const heredoc = `cat <<'EOF' > notes.md\n${'This change allows the agent to retry. '.repeat(120)}\nEOF`;
    render(<ToolCallView tool={command({ status: 'completed', content: [{ type: 'terminal', terminalId: 'term-1', command: heredoc, output: 'ok\n' }] })} />);
    const toggle = within(screen.getByTestId('chat-command-card')).getByRole('button', { expanded: false });
    expect(toggle.getAttribute('aria-label')).toBe("Expand command cat <<'EOF' > notes.md…");
    expect(screen.queryByTestId('chat-command-full')).toBeNull();
    fireEvent.click(toggle);
    const name = toggle.getAttribute('aria-label')!;
    expect(name).toBe("Collapse command cat <<'EOF' > notes.md…");
    expect(name.length).toBeLessThan(100);
    // Text in the command no longer leaks into button lookups.
    expect(screen.queryByRole('button', { name: /allows/ })).toBeNull();
    expect(screen.getByTestId('chat-command-full')).toHaveTextContent('This change allows the agent to retry.');
  });

  it('shows no separate full command when the header already holds all of it', () => {
    render(<ToolCallView tool={command({ status: 'completed', content: [{ type: 'terminal', terminalId: 'term-1', command: 'npm test', output: 'ok\n' }] })} />);
    expect(screen.queryByTestId('chat-command-full')).toBeNull();
  });

  it('caps an edit card\'s name built from a very long path', () => {
    const path = `src/${'deeply/nested/'.repeat(20)}file.ts`;
    render(<ToolCallView tool={tool({ toolKind: 'edit', status: 'completed', content: [{ type: 'diff', path, oldText: 'a\n', newText: 'b\n' }] })} />);
    const toggle = screen.getAllByRole('button').find((b) => b.getAttribute('aria-label')?.includes(' edit of '))!;
    const name = toggle.getAttribute('aria-label')!;
    expect(name.endsWith('…')).toBe(true);
    expect(name.length).toBeLessThanOrEqual('Collapse edit of '.length + 80);
  });

  it('labels the toggle for keyboard and screen-reader use', () => {
    render(<ToolCallView tool={command()} />);
    expect(screen.getByRole('button', { name: 'Expand command npm run typecheck' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('DiffCard outside the transcript', () => {
  it('stays open with no toggle (Changes, review, run insets)', () => {
    render(<DiffCard diff={{ type: 'diff', path: 'src/a.ts', oldText: 'a\n', newText: 'b\n' }} />);
    const card = screen.getByTestId('chat-diff-card');
    expect(card).toHaveAttribute('data-open', 'true');
    expect(card.querySelector('[data-diff="add"]')).toHaveTextContent('b');
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it("shows a Codex-added one-line file as Created, +1 −0 (#2160)", () => {
    // What the Codex mapper now sends for an `add` change: the content as newText.
    render(<DiffCard diff={{ type: 'diff', path: 'itest-codex.txt', newText: 'hello\n' }} status="pending" awaitingApproval />);
    const card = screen.getByTestId('chat-diff-card');
    expect(card).toHaveTextContent('Created');
    expect(card).toHaveTextContent('+1');
    expect(card).toHaveTextContent('−0');
    expect(card).toHaveTextContent('waiting for approval');
  });
});

describe('tool errors (#2182, #2184)', () => {
  const DENY = "The user doesn't want to proceed with this tool use. The tool use was rejected.";

  // Failed cards open themselves (toolOpenByDefault).
  it('shows a denied edit\'s message once, not again in red', () => {
    render(<ToolCallView tool={edit({ status: 'failed', content: [{ type: 'text', text: DENY }], error: DENY })} />);
    expect(screen.getByTestId('chat-tool-result')).toHaveTextContent(DENY);
    expect(screen.queryByTestId('chat-tool-error')).toBeNull();
    expect(screen.getAllByText(DENY, { exact: false })).toHaveLength(1);
  });

  it('strips Claude\'s <tool_use_error> wrapper and shows the message once', () => {
    const wrapped = '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>';
    render(<ToolCallView tool={edit({ status: 'failed', content: [{ type: 'text', text: wrapped }], error: wrapped })} />);
    expect(screen.getByTestId('chat-tool-result').textContent).toBe('File has not been read yet. Read it first before writing to it.');
    expect(screen.queryByTestId('chat-tool-error')).toBeNull();
    expect(document.body.textContent).not.toContain('tool_use_error');
  });

  it('keeps an error that says something the result doesn\'t', () => {
    render(<ToolCallView tool={tool({ status: 'failed', content: [{ type: 'text', text: 'partial output' }], error: '<tool_use_error>Timed out</tool_use_error>' })} />);
    expect(screen.getByTestId('chat-tool-error').textContent).toBe('Timed out');
  });

  it('shows a command\'s error once when its output already says it', () => {
    const out = 'Exit code 1\nnpm ERR! missing script: typo\n';
    render(<ToolCallView tool={command({ status: 'failed', error: 'Exit code 1\nnpm ERR! missing script: typo', content: [{ type: 'terminal', terminalId: 'term-1', command: 'npm run typo', output: out, exitCode: 1 }] })} />);
    expect(screen.getByTestId('chat-command-card')).toHaveTextContent('npm ERR! missing script: typo');
    expect(screen.queryByTestId('chat-tool-error')).toBeNull();
  });
});

describe('ApprovalDiffPreview (#2168)', () => {
  it('previews each file compactly, from generic diff content', () => {
    const many = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    render(<ApprovalDiffPreview diffs={[
      { type: 'diff', path: 'a.md', oldText: 'old', newText: 'new' },
      { type: 'diff', path: 'b.md', newText: many, unifiedDiff: `@@ -0,0 +1,30 @@\n${many.split('\n').map((l) => `+${l}`).join('\n')}` },
    ]} />);
    const cards = screen.getAllByTestId('chat-diff-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent('a.md');
    expect(cards[1]).not.toHaveTextContent('Created');
    expect(within(cards[1]).getByText('Show all 31 lines')).toBeInTheDocument();
  });

  it('renders nothing without diffs', () => {
    const { container } = render(<ApprovalDiffPreview diffs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('failed output and groups (#2664)', () => {
  const failed = (output: string) => ({
    id: 'x', sessionId: 's', seq: 1, ts: 1, kind: 'tool_call', toolCallId: 'x', toolKind: 'execute', title: 'x', status: 'failed',
    content: [{ type: 'terminal', command: 'x', output, exitCode: 1 }],
  }) as ToolCallItem;
  const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');

  it('opens a failure with short output', () => {
    render(<CommandCard tool={failed('one line')} />);
    expect(screen.getByTestId('chat-command-card')).toHaveAttribute('data-open', 'true');
    expect(screen.queryByTestId('chat-tool-failure-line')).not.toBeInTheDocument();
  });

  it('starts a failure with long output closed, on its last line, and opens to all of it', () => {
    render(<CommandCard tool={failed(long)} />);
    const card = screen.getByTestId('chat-command-card');
    expect(card).toHaveAttribute('data-open', 'false');
    expect(card).toHaveTextContent('exit 1');
    expect(screen.getByTestId('chat-tool-failure-line')).toHaveTextContent('line 19');
    expect(card).not.toHaveTextContent('line 3');
    fireEvent.click(within(card).getByRole('button', { expanded: false }));
    expect(card).toHaveTextContent('line 3');
  });

  it('keeps an error on the closed card even when it repeats the output', () => {
    render(<CommandCard tool={{ ...failed(long), error: long }} />);
    expect(screen.getByTestId('chat-tool-error')).toBeInTheDocument();
  });

  it('builds a group\'s rows only when it opens', () => {
    const renderItem = vi.fn((item: ChatItem) => <span>{item.id}</span>);
    const tool = (id: string) => ({ ...failed('ok'), id, toolCallId: id, status: 'completed' }) as ToolCallItem;
    const items = [tool('a'), tool('b')];
    render(<ChatterGroup block={{ type: 'group', key: 'k', tools: items, messages: [], items }} renderItem={renderItem} />);
    expect(screen.getByTestId('chat-group-toggle')).toHaveTextContent('Made 2 tool calls');
    expect(renderItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('chat-group-toggle'));
    expect(renderItem).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('chat-copy')).toBeInTheDocument();
  });
});
