import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PermissionCard } from './ApprovalDock';
import type { PendingPermission } from '../../../stores/chatStore';

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
