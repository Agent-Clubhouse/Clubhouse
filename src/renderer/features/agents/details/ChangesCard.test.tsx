import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChangesResult, CheckpointTurn } from '../../../../shared/chat-checkpoints';
import { CheckpointChanges, ChangesCard } from './ChangesCard';

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
  chat.revertTurn = vi.fn(async () => ({ reverted: ['src/new.ts'], conflicts: ['src/app.ts'], skipped: [], undoable: true }));
  chat.undoRevert = vi.fn(async () => ({ reverted: ['src/new.ts'], conflicts: [], skipped: [] }));
});

function renderPanel(scope: 'turn' | 'session' = 'turn') {
  return render(<CheckpointChanges agentId="agent-1" sessionId="s1" refreshKey="k" scope={scope} />);
}

describe('CheckpointChanges', () => {
  it('lists the last turn\'s files and opens a file to its diff', async () => {
    renderPanel();
    await screen.findByText('app.ts');
    expect(screen.getByText('new.ts')).toBeInTheDocument();
    expect(chat.getChanges).toHaveBeenCalledWith('agent-1', { turnId: 't1' });
    expect(screen.queryByTestId('chat-diff-card')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('src/app.ts'));
    await waitFor(() => expect(screen.getByTestId('chat-diff-card')).toBeInTheDocument());
    expect(chat.getChanges).toHaveBeenCalledWith('agent-1', { turnId: 't1' }, 'src/app.ts');
  });

  it('shows the session without Revert last turn', async () => {
    renderPanel('session');
    await waitFor(() => expect(chat.getChanges).toHaveBeenCalledWith('agent-1', { sessionId: 's1' }));
    await screen.findByText('app.ts');
    expect(screen.queryByRole('button', { name: 'Revert last turn…' })).not.toBeInTheDocument();
  });

  it('confirms before reverting, reports conflicts and asks again before overwriting them', async () => {
    renderPanel();
    await screen.findByText('app.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Revert last turn…' }));
    expect(screen.getByTestId('chat-changes-confirm')).toHaveTextContent('Restore 2 files to before the last turn?');
    expect(screen.queryByTestId('chat-changes-shared-warning')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(chat.revertTurn).toHaveBeenCalledWith('agent-1', 't1', false));
    const result = await screen.findByTestId('chat-changes-revert-result');
    expect(result).toHaveTextContent('Reverted 1 file.');
    expect(result).toHaveTextContent('src/app.ts');

    fireEvent.click(screen.getByRole('button', { name: 'Overwrite those too…' }));
    expect(chat.revertTurn).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('chat-changes-force-confirm')).toHaveTextContent('Overwrite 1 file changed after the turn');
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));
    await waitFor(() => expect(chat.revertTurn).toHaveBeenCalledWith('agent-1', 't1', true));
  });

  it('can cancel the overwrite confirmation', async () => {
    renderPanel();
    await screen.findByText('app.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Revert last turn…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Overwrite those too…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('chat-changes-force-confirm')).toBeNull();
    expect(chat.revertTurn).toHaveBeenCalledTimes(1);
  });

  it('warns before reverting a turn another agent shared', async () => {
    chat.listCheckpoints = vi.fn(async () => [{ ...turns[0], shared: true }]);
    renderPanel();
    await screen.findByText('app.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Revert last turn…' }));
    expect(screen.getByTestId('chat-changes-shared-warning')).toHaveTextContent('Another agent was working in this folder');
  });

  it('reports files left alone and large untracked files', async () => {
    chat.getChanges = vi.fn(async () => ({ ...turnChanges, skippedLarge: ['video.mov'], skippedRepos: ['scratch'] }));
    chat.revertTurn = vi.fn(async () => ({ reverted: ['src/app.ts'], conflicts: [], skipped: ['dist/out.js'] }));
    renderPanel();
    await screen.findByText('app.ts');
    expect(screen.getByTestId('chat-changes-skipped-large')).toHaveTextContent('video.mov');
    expect(screen.getByTestId('chat-changes-skipped-repos')).toHaveTextContent('scratch');
    fireEvent.click(screen.getByRole('button', { name: 'Revert last turn…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(await screen.findByTestId('chat-changes-revert-skipped')).toHaveTextContent('dist/out.js');
  });

  it('offers to undo a revert', async () => {
    chat.listCheckpoints = vi.fn(async () => [{ ...turns[0], undoable: true }]);
    renderPanel();
    await screen.findByText('app.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Undo revert' }));
    await waitFor(() => expect(chat.undoRevert).toHaveBeenCalledWith('agent-1', 't1'));
    expect(await screen.findByTestId('chat-changes-revert-result')).toHaveTextContent('Undid the revert: restored 1 file.');
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
    await screen.findByText('app.ts');
    expect(screen.getByText('This turn is still running; showing changes so far.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revert last turn…' })).toBeDisabled();
  });
});

describe('ChangesCard', () => {
  const branch = {
    available: true, branch: 'agent/work', base: 'main', ahead: 2, uncommitted: 1,
    files: [
      { path: 'src/app.ts', status: 'modified' as const, additions: 10, deletions: 3, binary: false },
      { path: 'src/notes.md', status: 'added' as const, additions: 4, deletions: 0, binary: false },
    ],
  };

  it('answers on one line when collapsed', () => {
    render(<ChangesCard open={false} onToggle={() => {}} cwd="/w" branch={branch} agentId="agent-1" scope="branch" onScope={() => {}} />);
    expect(screen.getByTestId('details-card-changes-summary')).toHaveTextContent('2 files +14 −3');
    expect(screen.queryByTestId('chat-changes-files')).not.toBeInTheDocument();
  });

  it('shows the branch against main and opens a file to its patch', async () => {
    window.clubhouse.git.branchFilePatch = vi.fn(async () => ({ patch: PATCH }));
    render(<ChangesCard open onToggle={() => {}} cwd="/w" branch={branch} agentId="agent-1" scope="branch" onScope={() => {}} />);
    expect(screen.getByText('vs main')).toBeInTheDocument();
    // A terminal agent has no turns: only the Branch scope.
    expect(screen.queryByRole('button', { name: 'Session' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('src/app.ts'));
    await waitFor(() => expect(screen.getByTestId('chat-diff-card')).toBeInTheDocument());
    expect(window.clubhouse.git.branchFilePatch).toHaveBeenCalledWith('/w', 'src/app.ts', undefined);
  });

  it('offers Session and Last turn for a chat agent', () => {
    const onScope = vi.fn();
    render(<ChangesCard open onToggle={() => {}} cwd="/w" branch={branch} chat={{ sessionId: 's1', refreshKey: 'k' }} agentId="agent-1" scope="branch" onScope={onScope} />);
    fireEvent.click(screen.getByRole('button', { name: 'Last turn' }));
    expect(onScope).toHaveBeenCalledWith('turn');
  });

  it('says plainly when the folder is not a repository or there is no main', () => {
    const { rerender } = render(<ChangesCard open onToggle={() => {}} cwd="/w" branch={{ available: false, files: [], ahead: 0, uncommitted: 0 }} agentId="a" scope="branch" onScope={() => {}} />);
    expect(screen.getByTestId('details-card-changes-summary')).toHaveTextContent('not a git repository');
    rerender(<ChangesCard open onToggle={() => {}} cwd="/w" branch={{ available: true, noBase: true, files: [], ahead: 0, uncommitted: 0 }} agentId="a" scope="branch" onScope={() => {}} />);
    expect(screen.getByText('No main or master branch to compare with.')).toBeInTheDocument();
  });
});
