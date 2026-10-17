import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeadlessRunFinished } from './HeadlessRunFinished';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';
import type { CompletedQuickAgent } from '../../../../shared/types';

vi.mock('../TranscriptViewer', () => ({ TranscriptViewer: () => <div data-testid="transcript-viewer" /> }));

const T0 = 1_700_000_000_000;

const done: CompletedQuickAgent = {
  id: 'q1',
  projectId: 'proj-1',
  name: 'faithful-urchin',
  mission: 'Replace the hex colors with theme tokens',
  summary: 'Moved 175 hex literals onto theme tokens.',
  filesModified: ['/wt/src/a.ts', '/wt/src/b.ts'],
  exitCode: 0,
  completedAt: T0 + 401_000,
  startedAt: T0,
  headless: true,
  orchestrator: 'claude-code',
  model: 'sonnet',
  costUsd: 0.42,
  cwd: '/wt',
  baseSha: 'abc123',
  parentAgentId: 'durable-1',
};

const spawnQuickAgent = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  spawnQuickAgent.mockResolvedValue('q2');
  useAgentStore.setState({
    agents: { 'durable-1': { id: 'durable-1', projectId: 'proj-1', name: 'gallant-swift', kind: 'durable', status: 'running', color: 'blue' } },
    spawnQuickAgent,
  });
  useProjectStore.setState({ projects: [{ id: 'proj-1', name: 'p', path: '/projects/p' }] });
  window.clubhouse.agent.readTranscriptPage = vi.fn().mockImplementation(async (_id: string, offset: number) => offset > 0
    ? { events: [], totalEvents: 2 }
    : {
      events: [
        { type: 'assistant', _ts: T0 + 5_000, message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/wt/src/a.ts' } }] } },
        { type: 'user', _ts: T0 + 6_000, message: { content: [{ type: 'tool_result', tool_use_id: 'e1' }] } },
      ],
      totalEvents: 2,
    });
  window.clubhouse.git.diffNumstat = vi.fn().mockResolvedValue([
    { path: 'src/a.ts', added: 94, removed: 89, binary: false },
    { path: 'src/b.ts', added: 6, removed: 1, binary: false },
  ]);
  window.clubhouse.git.diff = vi.fn().mockResolvedValue({ original: 'a\n', modified: 'b\n' });
});

describe('HeadlessRunFinished', () => {
  it('shows a finished run in place: Done, summary, files with diff sizes, no chips', async () => {
    render(<HeadlessRunFinished completed={done} onDismiss={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByTestId('state-word')).toHaveTextContent('Done');
    expect(screen.getByTestId('run-toolbar')).toHaveTextContent('finished in 6m 41s');
    expect(screen.getByTestId('run-summary-text')).toHaveTextContent('Moved 175 hex literals');
    expect(screen.getByTestId('treehouse')).toHaveAttribute('data-phase', 'done');
    expect(screen.getByText(/quick agent from gallant-swift · Claude Code · sonnet/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('run-files')).toHaveTextContent('+94'));
    expect(window.clubhouse.git.diffNumstat).toHaveBeenCalledWith('/wt', 'abc123');
    expect(screen.getByTestId('run-files')).toHaveTextContent('2 · +100 −90');
    expect(screen.getByTestId('run-summary')).toHaveTextContent('$0.42');
    expect(await screen.findByTestId('timeline-end')).toHaveTextContent('Finishedexit 0');
    expect(screen.queryByText('Headless')).toBeNull();
  });

  it('Review changes opens the first file diff', async () => {
    render(<HeadlessRunFinished completed={done} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByTestId('run-review-button'));
    expect(await screen.findByTestId('run-file-diff')).toBeInTheDocument();
    expect(window.clubhouse.git.diff).toHaveBeenCalledWith('/wt', 'src/a.ts', false);
  });

  it('Delete asks first', () => {
    const onDelete = vi.fn();
    render(<HeadlessRunFinished completed={done} onDismiss={vi.fn()} onDelete={onDelete} />);
    fireEvent.click(screen.getByTestId('run-delete-button'));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('confirm-destructive-confirm'));
    expect(onDelete).toHaveBeenCalled();
  });

  it('Dismiss closes the view', () => {
    const onDismiss = vi.fn();
    render(<HeadlessRunFinished completed={done} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('run-dismiss-button'));
    expect(onDismiss).toHaveBeenCalled();
  });

  describe('failed', () => {
    const failed: CompletedQuickAgent = {
      ...done,
      summary: null,
      exitCode: 1,
      completedAt: T0 + 138_000,
      stderrTail: 'API Error: 529 overloaded',
      freeAgentMode: true,
      pluginMetadata: { card: '7' },
    };

    it('shows the error kept after exit and where it stopped', async () => {
      window.clubhouse.agent.readTranscriptPage = vi.fn().mockImplementation(async (_id: string, offset: number) => offset > 0
        ? { events: [], totalEvents: 1 }
        : { events: [{ type: 'assistant', _ts: T0 + 1000, message: { content: [{ type: 'tool_use', id: 'x', name: 'Edit', input: { file_path: '/wt/src/a.ts' } }] } }], totalEvents: 1 });
      render(<HeadlessRunFinished completed={failed} onDismiss={vi.fn()} />);
      expect(screen.getByTestId('state-word')).toHaveTextContent('Error');
      expect(screen.getByTestId('run-toolbar')).toHaveTextContent('exited with code 1 after 2m 18s');
      expect(screen.getByTestId('run-error')).toHaveTextContent('API Error: 529 overloaded');
      expect(await screen.findByText('stopped here')).toBeInTheDocument();
      expect(screen.getByTestId('run-files')).toHaveTextContent('Retry continues from them.');
      expect(screen.queryByTestId('run-delete-button')).toBeNull();
    });

    it('Retry starts the same mission in the same worktree', async () => {
      const onRetried = vi.fn();
      render(<HeadlessRunFinished completed={failed} onDismiss={vi.fn()} onRetried={onRetried} />);
      fireEvent.click(screen.getByTestId('run-retry-button'));
      await waitFor(() => expect(onRetried).toHaveBeenCalled());
      expect(spawnQuickAgent).toHaveBeenCalledWith(
        'proj-1', '/projects/p', failed.mission, 'sonnet', 'durable-1', 'claude-code', true, { card: '7' }, '/wt',
      );
    });

    it('says stopped for a cancelled run', () => {
      render(<HeadlessRunFinished completed={{ ...failed, cancelled: true, exitCode: 143 }} onDismiss={vi.fn()} />);
      expect(screen.getByTestId('run-toolbar')).toHaveTextContent('stopped after 2m 18s');
    });
  });
});
