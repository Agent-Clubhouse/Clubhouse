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
});
