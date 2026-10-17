import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChangesResult, CheckpointTurn } from '../../../../shared/chat-checkpoints';
import { ChangesPanel } from './ChangesPanel';

const turns: CheckpointTurn[] = [
  { sessionId: 's1', turnId: 't1', startedAt: 1, endedAt: 2, start: 'aaa', end: 'bbb' },
];
const turnChanges: ChangesResult = {
  available: true,
  live: false,
  files: [
    { path: 'src/app.ts', status: 'modified', additions: 2, deletions: 1, binary: false },
    { path: 'src/new.ts', status: 'added', additions: 4, deletions: 0, binary: false },
  ],
};
const PATCH = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n-export const a = 1;\n+export const a = 2;\n+export const b = 3;\n';

let chat: typeof window.clubhouse.chat;

beforeEach(() => {
  chat = window.clubhouse.chat;
  chat.listCheckpoints = vi.fn(async () => turns);
  chat.getChanges = vi.fn(async (_agentId: string, _scope: unknown, filePath?: string) => (filePath ? { ...turnChanges, patch: PATCH } : turnChanges));
  chat.revertTurn = vi.fn(async () => ({ reverted: ['src/new.ts'], conflicts: ['src/app.ts'] }));
});

function renderPanel() {
  return render(<ChangesPanel agentId="agent-1" sessionId="s1" refreshKey="k" onClose={() => {}} />);
}

describe('ChangesPanel', () => {
  it('lists the last turn\'s files with totals and shows the selected diff', async () => {
    renderPanel();
    await screen.findByText('src/app.ts');
    expect(screen.getByText('src/new.ts')).toBeInTheDocument();
    expect(screen.getByTestId('chat-changes-totals')).toHaveTextContent('+6 −1');
    expect(chat.getChanges).toHaveBeenCalledWith('agent-1', { turnId: 't1' });
    await waitFor(() => expect(screen.getByTestId('chat-diff-card')).toBeInTheDocument());
    expect(chat.getChanges).toHaveBeenCalledWith('agent-1', { turnId: 't1' }, 'src/app.ts');
  });

  it('switches to the session view', async () => {
    renderPanel();
    await screen.findByText('src/app.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Session' }));
    await waitFor(() => expect(chat.getChanges).toHaveBeenCalledWith('agent-1', { sessionId: 's1' }));
    expect(screen.getByRole('button', { name: 'Revert last turn' })).toBeDisabled();
  });

  it('confirms before reverting, reports conflicts and offers to force', async () => {
    renderPanel();
    await screen.findByText('src/app.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Revert last turn' }));
    expect(screen.getByTestId('chat-changes-confirm')).toHaveTextContent('Restore 2 files to before the last turn?');
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(chat.revertTurn).toHaveBeenCalledWith('agent-1', 't1', false));
    const result = await screen.findByTestId('chat-changes-revert-result');
    expect(result).toHaveTextContent('Reverted 1 file.');
    expect(result).toHaveTextContent('src/app.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Revert those too' }));
    await waitFor(() => expect(chat.revertTurn).toHaveBeenCalledWith('agent-1', 't1', true));
  });

  it('explains when the agent is not in a git repository', async () => {
    chat.getChanges = vi.fn(async () => ({ available: false, files: [] }));
    renderPanel();
    expect(await screen.findByText('Changes need the agent to work in a git repository.')).toBeInTheDocument();
  });

  it('disables revert while the turn is still running', async () => {
    chat.listCheckpoints = vi.fn(async () => [{ ...turns[0], end: undefined, endedAt: undefined }]);
    chat.getChanges = vi.fn(async () => ({ ...turnChanges, live: true }));
    renderPanel();
    await screen.findByText('src/app.ts');
    expect(screen.getByText('This turn is still running; showing changes so far.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revert last turn' })).toBeDisabled();
  });
});
