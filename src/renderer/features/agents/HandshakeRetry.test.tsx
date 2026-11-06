import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatHandshakeRetryResult } from '../../../shared/chat';
import { HandshakeRetry } from './HandshakeRetry';
const props = { projectPath: '/project', agentId: 'a', provider: 'codex-cli', runtime: 'chat' };
function deferred() {
  let finish!: (result: ChatHandshakeRetryResult) => void;
  const promise = new Promise<ChatHandshakeRetryResult>((r) => { finish = r; });
  return { promise, finish };
}
beforeEach(() => { window.clubhouse.chat.retryHandshake = vi.fn().mockResolvedValue({ status: 'passed', message: 'Handshake passed for this check only.' }); });
describe('local explicit handshake recovery', () => {
  it('does nothing on render, requires click, deduplicates and shows a point-in-time result', async () => {
    const check = deferred(); window.clubhouse.chat.retryHandshake = vi.fn().mockReturnValue(check.promise);
    render(<HandshakeRetry {...props} />);
    expect(window.clubhouse.chat.retryHandshake).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Retry handshake')); fireEvent.click(screen.getByText('Checking handshake…'));
    expect(window.clubhouse.chat.retryHandshake).toHaveBeenCalledTimes(1);
    expect(window.clubhouse.chat.retryHandshake).toHaveBeenCalledWith('/project', 'a');
    await act(async () => { check.finish({ status: 'passed', message: 'Handshake passed for this check only.' }); });
    expect(screen.getByRole('status')).toHaveTextContent('this check only');
    expect(screen.getByText('Retry handshake')).not.toBeDisabled();
  });
  it.each(['b', 'provider'])('discards a deferred result after changing %s', async (change) => {
    const check = deferred(); window.clubhouse.chat.retryHandshake = vi.fn().mockReturnValue(check.promise);
    const view = render(<HandshakeRetry {...props} />); fireEvent.click(screen.getByText('Retry handshake'));
    view.rerender(<HandshakeRetry {...props} {...(change === 'b' ? { agentId: 'b' } : { provider: 'claude-code' })} />);
    await act(async () => { check.finish({ status: 'passed', message: 'Obsolete passed' }); });
    expect(screen.queryByText('Obsolete passed')).not.toBeInTheDocument();
    expect(screen.getByText('Retry handshake')).not.toBeDisabled();
  });
  it('reports cannot-probe failure and allows another explicit action', async () => {
    window.clubhouse.chat.retryHandshake = vi.fn().mockRejectedValue(new Error('Target unavailable'));
    render(<HandshakeRetry {...props} />); fireEvent.click(screen.getByText('Retry handshake'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Target unavailable'));
    expect(screen.getByText('Retry handshake')).not.toBeDisabled();
  });
});
