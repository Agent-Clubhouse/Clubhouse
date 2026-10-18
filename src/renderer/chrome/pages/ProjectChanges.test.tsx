import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useAgentStore } from '../../stores/agentStore';
import { AgentBranches, overlaps, runLimited } from './ProjectChanges';

const branch = (paths: string[]) => ({ available: true, files: paths.map((path) => ({ path, status: 'modified' as const, additions: 1, deletions: 0, binary: false })), ahead: 1, uncommitted: 0 });

describe('overlaps', () => {
  it('flags files two agent branches both change', () => {
    const out = overlaps(
      { a: branch(['src/AgentRow.tsx', 'src/a.ts']), b: branch(['src/AgentRow.tsx']), c: branch(['src/c.ts']) },
      { a: 'gallant-swift', b: 'bold-falcon', c: 'radiant-bobcat' },
    );
    expect(out.a).toEqual([{ path: 'src/AgentRow.tsx', others: ['bold-falcon'] }]);
    expect(out.b).toEqual([{ path: 'src/AgentRow.tsx', others: ['gallant-swift'] }]);
    expect(out.c).toBeUndefined();
  });

  it('ignores branches not read yet', () => {
    expect(overlaps({ a: null, b: branch(['x']) }, {})).toEqual({});
  });
});

describe('runLimited', () => {
  it('keeps at most the limit in flight', async () => {
    let running = 0;
    let peak = 0;
    const jobs = Array.from({ length: 8 }, () => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    });
    await runLimited(jobs, 3);
    expect(peak).toBe(3);
  });
});

describe('AgentBranches', () => {
  const agent = (id: string, name: string) => ({ id, name, projectId: 'p1', kind: 'durable', status: 'running', color: 'teal', worktreePath: `/w/${id}` });
  const project = { id: 'p1', name: 'proj', path: '/w' } as never;

  beforeEach(() => {
    window.clubhouse.git.branchChanges = vi.fn(async () => branch(['src/AgentRow.tsx']));
    useAgentStore.setState({ agents: { a: agent('a', 'gallant-swift'), b: agent('b', 'bold-falcon') } as never, agentDetailedStatus: {} });
  });

  it('flags a file two agents touch, and stops once one of them is gone', async () => {
    render(<AgentBranches project={project} refreshKey={0} />);
    const noteFor = (id: string) => screen.getAllByTestId('project-agent-branch').find((r) => r.getAttribute('data-agent-id') === id)!;
    await waitFor(() => expect(noteFor('a')).toHaveTextContent('AgentRow.tsx also changed by bold-falcon'));
    expect(noteFor('b')).toHaveTextContent('AgentRow.tsx also changed by gallant-swift');
    act(() => { useAgentStore.setState({ agents: { a: agent('a', 'gallant-swift') } as never }); });
    await waitFor(() => expect(screen.getAllByTestId('project-agent-branch')).toHaveLength(1));
    expect(screen.getByTestId('project-agent-branch-note')).not.toHaveTextContent('also changed by');
  });

  it('re-reads the branches when an agent finishes a turn', async () => {
    render(<AgentBranches project={project} refreshKey={0} />);
    await waitFor(() => expect(window.clubhouse.git.branchChanges).toHaveBeenCalledTimes(2));
    act(() => { useAgentStore.setState({ agentDetailedStatus: { a: { state: 'idle', message: 'Idle', timestamp: 5 } } }); });
    await waitFor(() => expect(window.clubhouse.git.branchChanges).toHaveBeenCalledTimes(4));
    // Between tool calls (idle + Thinking) isn't a finished turn.
    act(() => { useAgentStore.setState({ agentDetailedStatus: { a: { state: 'idle', message: 'Thinking', timestamp: 6 } } }); });
    await new Promise((r) => setTimeout(r, 20));
    expect(window.clubhouse.git.branchChanges).toHaveBeenCalledTimes(4);
  });
});
