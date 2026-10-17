import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import { useProjectStore } from '../../../stores/projectStore';
import { AgentDetails, BRANCH_REFRESH_MS, relativeFolder, useBranchChanges } from './AgentDetails';
import { DetailsToggle } from './DetailsToggle';
import { useAgentDetailsStore } from './detailsStore';

const agent: Agent = {
  id: 'a1', projectId: 'p1', name: 'faithful-urchin', kind: 'durable', status: 'running', color: 'teal',
  orchestrator: 'claude-code', worktreePath: '/work/proj/.clubhouse/agents/faithful-urchin', mcpIds: ['clubhouse', 'github'],
};
const branch = {
  available: true, branch: 'faithful-urchin/rows', base: 'main',
  files: [{ path: 'src/a.ts', status: 'modified' as const, additions: 5, deletions: 2, binary: false }],
};

beforeEach(() => {
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: '/work/proj' }] as never });
  useAgentDetailsStore.setState({ open: true, focus: null });
  window.clubhouse.git.branchChanges = vi.fn(async () => branch);
});

afterEach(() => {
  useProjectStore.setState({ projects: [] });
});

describe('AgentDetails in the terminal', () => {
  it('fills the cards it can and says plainly what the terminal can\'t report', async () => {
    render(<AgentDetails agent={agent} />);
    expect(await screen.findByText('1 file')).toBeInTheDocument();
    expect(screen.getByTestId('details-card-subagents-summary')).toHaveTextContent('not reported in the terminal');
    expect(screen.getByTestId('details-card-context-summary')).toHaveTextContent('not reported');
    expect(screen.getByTestId('details-card-mcp-summary')).toHaveTextContent('2 configured');
    fireEvent.click(screen.getByTestId('details-card-subagents-toggle'));
    expect(screen.getByText(/The terminal doesn.t report subagents/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('details-card-session-toggle'));
    const session = screen.getByTestId('details-card-session');
    expect(session).toHaveTextContent('Claude Code · terminal');
    expect(session).toHaveTextContent('.clubhouse/agents/faithful-urchin');
    expect(session).toHaveTextContent('faithful-urchin/rows');
    // The terminal has no turns: Changes offers only the branch.
    fireEvent.click(screen.getByTestId('details-card-changes-toggle'));
    expect(screen.queryByRole('button', { name: 'Last turn' })).not.toBeInTheDocument();
    expect(window.clubhouse.git.branchChanges).toHaveBeenCalledWith(agent.worktreePath, undefined);
  });

  it('hides on Escape and gives focus back to this pane\'s toggle, not another pane\'s', async () => {
    render(
      <>
        <div data-agent-pane="other"><DetailsToggle /></div>
        <div data-agent-pane="a1"><DetailsToggle /><AgentDetails agent={agent} /></div>
      </>,
    );
    const toggles = screen.getAllByTestId('agent-details-toggle');
    fireEvent.keyDown(screen.getByTestId('agent-details'), { key: 'Escape' });
    expect(useAgentDetailsStore.getState().open).toBe(false);
    await waitFor(() => expect(toggles[1]).toHaveFocus());
  });

  it('opens a card asked for from elsewhere', () => {
    render(<AgentDetails agent={agent} />);
    expect(screen.getByTestId('details-card-subagents')).not.toHaveAttribute('data-open');
    act(() => { useAgentDetailsStore.getState().reveal({ agentId: 'a1', card: 'subagents' }); });
    expect(screen.getByTestId('details-card-subagents')).toHaveAttribute('data-open', 'true');
  });
});

describe('useBranchChanges', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reads at most once per interval and never overlaps reads', async () => {
    vi.useFakeTimers();
    let resolve!: (v: typeof branch) => void;
    const calls: number[] = [];
    window.clubhouse.git.branchChanges = vi.fn(() => { calls.push(Date.now()); return new Promise((r) => { resolve = r; }); }) as never;
    const { rerender } = renderHook(({ k }) => useBranchChanges('/w', k), { initialProps: { k: 0 } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls).toHaveLength(1);
    // Tool events while the read runs queue exactly one more read.
    rerender({ k: 1 });
    rerender({ k: 2 });
    rerender({ k: 3 });
    await act(async () => { await vi.advanceTimersByTimeAsync(BRANCH_REFRESH_MS * 2); });
    expect(calls).toHaveLength(1);
    await act(async () => { resolve(branch); await vi.advanceTimersByTimeAsync(BRANCH_REFRESH_MS); });
    expect(calls).toHaveLength(2);
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(BRANCH_REFRESH_MS);
  });
});

describe('relativeFolder', () => {
  it('only treats a path as inside the project on a separator boundary', () => {
    expect(relativeFolder('/work/proj/.clubhouse/agents/x', '/work/proj')).toBe('.clubhouse/agents/x');
    expect(relativeFolder('/work/project-two/x', '/work/proj')).toBeNull();
    expect(relativeFolder('C:\\work\\proj\\agents\\x', 'C:\\work\\proj')).toBe('agents\\x');
    expect(relativeFolder(undefined, '/work/proj')).toBeNull();
  });
});

describe('detailsStore', () => {
  it('toggles, remembers the choice and reveals a card', () => {
    useAgentDetailsStore.getState().setOpen(false);
    useAgentDetailsStore.getState().toggle();
    expect(useAgentDetailsStore.getState().open).toBe(true);
    expect(localStorage.getItem('clubhouse.agentDetails.open')).toBe('1');
    useAgentDetailsStore.getState().setOpen(false);
    useAgentDetailsStore.getState().reveal({ agentId: 'a1', card: 'changes' });
    const { open, focus } = useAgentDetailsStore.getState();
    expect(open).toBe(true);
    expect(focus).toMatchObject({ agentId: 'a1', card: 'changes' });
  });

  it('doesn\'t change the main window\'s choice from a popout', () => {
    const isPopout = window.clubhouse.window.isPopout;
    window.clubhouse.window.isPopout = () => true;
    try {
      localStorage.setItem('clubhouse.agentDetails.open', '0');
      useAgentDetailsStore.getState().setOpen(true);
      expect(localStorage.getItem('clubhouse.agentDetails.open')).toBe('0');
    } finally {
      window.clubhouse.window.isPopout = isPopout;
    }
  });
});
