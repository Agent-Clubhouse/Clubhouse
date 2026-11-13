import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ActionView } from '../../../../shared/actions';
import type { Agent } from '../../../../shared/types';
import { DISPATCHER_PROJECT_ID } from '../../../../shared/dispatcher-types';
import { useProjectStore } from '../../../stores/projectStore';
import { createChatViewState } from '../../../stores/chatStore';
import { AgentDetails, BRANCH_REFRESH_MS, relativeFolder, useBranchChanges } from './AgentDetails';
import { DetailsToggle } from './DetailsToggle';
import { useAgentDetailsStore } from './detailsStore';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import { getProjectCanvasStore, useAppCanvasStore } from '../../../plugins/builtin/canvas/main';

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
  useAgentDetailsStore.setState({ open: true, settingsOpen: false, focus: null });
  useMcpBindingStore.setState({ bindings: [] });
  getProjectCanvasStore('p1').setState({ canvases: [], loaded: false });
  useAppCanvasStore.setState({ canvases: [], loaded: true });
  window.clubhouse.canvas.getAgentCanvases = vi.fn(async () => []);
  window.clubhouse.git.branchChanges = vi.fn(async () => branch);
});

afterEach(() => {
  useProjectStore.setState({ projects: [] });
  useMcpBindingStore.setState({ bindings: [] });
});

describe('AgentDetails in the terminal', () => {
  it('keeps passive skill reports and MCP evidence inside one combined card', async () => {
    const chat = {
      ...createChatViewState(agent.id), sessionId: 'shared-session', nativeSessionId: 'native-session',
      provider: 'claude-code', driver: 'claude_agent_sdk' as const,
      providerSkills: {
        provider: 'claude-code' as const, driver: 'claude_agent_sdk' as const, source: 'system/init' as const,
        nativeSessionId: 'native-session', sessionId: 'shared-session', reportedAt: 1000, names: ['review'],
      },
    };
    render(<AgentDetails agent={agent} chat={chat} />);
    fireEvent.click(screen.getByTestId('details-card-skills-mcp-toggle'));
    expect(screen.getByTestId('details-card-provider-skills-summary')).toHaveTextContent('1 reported');
    expect(screen.getByText('review')).toBeInTheDocument();
    expect(screen.getByTestId('details-card-skills-mcp')).toContainElement(screen.getByTestId('details-card-mcp'));
    expect(screen.getByTestId('details-card-skills-mcp')).toContainElement(screen.getByTestId('details-card-provider-skills'));
    expect(screen.queryByTestId('details-card-provider-skills-toggle')).not.toBeInTheDocument();
    expect(await screen.findByText('1 file')).toBeInTheDocument();
  });

  it('fills the cards it can and leaves out the ones the terminal can\'t fill', async () => {
    render(<AgentDetails agent={agent} />);
    expect(await screen.findByText('1 file')).toBeInTheDocument();
    // #2094: no Subagents or Context window card the terminal can only call "not reported".
    expect(screen.queryByTestId('details-card-subagents')).not.toBeInTheDocument();
    expect(screen.queryByTestId('details-card-context')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('details-card-skills-mcp-toggle'));
    expect(screen.getByTestId('details-card-mcp-summary')).toHaveTextContent('2 configured');
    fireEvent.click(screen.getByTestId('details-card-session-toggle'));
    const session = screen.getByTestId('details-card-session');
    expect(session).toHaveTextContent('Claude Code · CLI');
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
    expect(screen.getByTestId('details-card-skills-mcp')).not.toHaveAttribute('data-open');
    act(() => { useAgentDetailsStore.getState().reveal({ agentId: 'a1', card: 'mcp' }); });
    expect(screen.getByTestId('details-card-skills-mcp')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('details-card-mcp')).toBeInTheDocument();
  });

  it('lets Action dialogs handle Escape without hiding details or discarding edits', async () => {
    const reminder: ActionView = {
      id: 'reminder', name: 'Progress reminder', owner: { kind: 'agent', agentId: agent.id },
      trigger: { kind: 'schedule', preset: 'cron', cron: '*/30 * * * *', missed: 'skip' },
      steps: [{ kind: 'notify', text: 'Report progress' }], overlap: 'skip',
      enabled: true, running: false, createdAt: 1, updatedAt: 1,
    };
    window.clubhouse.actions.list = vi.fn(async () => [reminder]);
    window.clubhouse.actions.history = vi.fn(async () => []);
    render(<AgentDetails agent={agent} />);
    fireEvent.click(screen.getByTestId('details-card-actions-toggle'));
    fireEvent.click(await screen.findByTestId('agent-action-row'));
    const card = await screen.findByTestId('action-card');
    fireEvent.keyDown(card, { key: 'Escape' });
    expect(screen.queryByTestId('action-card')).not.toBeInTheDocument();
    expect(useAgentDetailsStore.getState().open).toBe(true);

    fireEvent.click(screen.getByTestId('agent-action-row'));
    fireEvent.click(within(await screen.findByTestId('action-card')).getByRole('button', { name: 'Edit' }));
    const name = within(await screen.findByTestId('action-form')).getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Keep my changes' } });
    fireEvent.keyDown(name, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toBeInTheDocument();
    expect(name).toHaveValue('Keep my changes');
    expect(useAgentDetailsStore.getState().open).toBe(true);
  });

  it('starts cards collapsed, keeps Settings saved, and resets other cards on a new agent visit', async () => {
    const { rerender } = render(<AgentDetails agent={agent} />);
    expect(screen.getAllByTestId(/^details-card-.*-toggle$/).every((c) => c.getAttribute('aria-expanded') === 'false')).toBe(true);
    fireEvent.click(screen.getByTestId('details-card-settings-toggle'));
    fireEvent.click(screen.getByTestId('details-card-session-toggle'));
    rerender(<AgentDetails agent={{ ...agent, id: 'a2' }} />);
    expect(screen.getByTestId('details-card-settings')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('details-card-session')).not.toHaveAttribute('data-open');
    expect(localStorage.getItem('clubhouse.agentDetails.settingsOpen')).toBe('1');
    await act(async () => {});
  });

  it.each(['helpers', 'subagents', 'dispatcher', 'connections'] as const)('falls back from unavailable %s for a remote agent', async (card) => {
    const remote = { ...agent, projectId: 'remote||sat||p1' };
    render(<AgentDetails agent={remote} />);
    await act(async () => useAgentDetailsStore.getState().reveal({ agentId: agent.id, card }));
    expect(screen.getByTestId('details-card-session')).toHaveAttribute('data-open', 'true');
  });

  it('opens an empty Connections card from permissions settings (#3275)', async () => {
    render(<AgentDetails agent={agent} />);
    act(() => { useAgentDetailsStore.getState().reveal({ agentId: agent.id, card: 'connections' }); });
    expect(await screen.findByTestId('details-card-connections')).toHaveAttribute('data-open', 'true');
    expect(screen.getByText(/No Clubhouse MCP wires/)).toBeInTheDocument();
  });

  it('lets a quick agent edit its existing disabled tools through the canvas Connections route (#3213)', async () => {
    const quick = { ...agent, kind: 'quick' as const };
    const binding = { agentId: quick.id, targetId: 'other', targetKind: 'agent' as const, label: 'Other', disabledTools: ['read_output'] };
    useMcpBindingStore.setState({ bindings: [binding] });
    window.clubhouse.mcpBinding.getConnectionGrants = vi.fn(async () => []);
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: [{ agentId: quick.id, targetId: 'other', bound: true, sources: [{ kind: 'canvas', sourceId: 'canvas-wires' }] }],
      unreadable: [],
    }));
    window.clubhouse.mcpBinding.setDisabledTools = vi.fn(async () => {});
    render(<AgentDetails agent={quick} />);
    act(() => { useAgentDetailsStore.getState().reveal({ agentId: quick.id, card: 'connections' }); });
    expect(await screen.findByTestId('details-card-connections')).toHaveAttribute('data-open', 'true');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const read = screen.getByRole('switch', { name: `Read output (${quick.name} to Other)` });
    expect(read).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(read);
    await waitFor(() => expect(window.clubhouse.mcpBinding.setDisabledTools).toHaveBeenCalledWith(quick.id, 'other', []));
  });
});

describe('AgentDetails Canvases', () => {
  it('hides empty Canvases and sends its focus requests to Session', async () => {
    render(<AgentDetails agent={agent} />);
    await act(async () => useAgentDetailsStore.getState().reveal({ agentId: agent.id, card: 'canvases' }));
    expect(screen.queryByTestId('details-card-canvases')).not.toBeInTheDocument();
    expect(screen.getByTestId('details-card-session')).toHaveAttribute('data-open', 'true');
  });

  it('opens indexed memberships at the end and falls back when the last one is removed', async () => {
    window.clubhouse.canvas.getAgentCanvases = vi.fn(async () => [
      { scope: 'project', projectId: 'p1', canvasId: 'c1', name: 'Work board', viewId: 'v1' },
    ]);
    render(<AgentDetails agent={agent} />);
    const card = await screen.findByTestId('details-card-canvases');
    await act(async () => useAgentDetailsStore.getState().reveal({ agentId: agent.id, card: 'canvases' }));
    expect(card).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('details-canvas-row')).toHaveTextContent('Work board');
    expect(card.nextElementSibling).toBeNull();
    await act(async () => getProjectCanvasStore('p1').setState({ canvases: [], loaded: true }));
    expect(screen.queryByTestId('details-card-canvases')).not.toBeInTheDocument();
    expect(screen.getByTestId('details-card-session')).toHaveAttribute('data-open', 'true');
  });
});

describe('AgentDetails for the Dispatcher', () => {
  const dispatcher: Agent = { id: 'disp', projectId: DISPATCHER_PROJECT_ID, name: 'Navi', kind: 'durable', status: 'running', color: 'indigo', orchestrator: 'claude-code' };

  it('shows Settings and Actions but none of an agent\'s internals (#3184)', () => {
    const chat = {
      ...createChatViewState(dispatcher.id), sessionId: 's1', provider: 'claude-code', driver: 'claude_agent_sdk' as const,
      capabilities: { usage: 'session', subagents: 'native', limits: false } as never,
      usage: { ...createChatViewState(dispatcher.id).usage, context: { used: 10, size: 100, window: 'total' } } as never,
      providerSkills: {
        provider: 'claude-code' as const, driver: 'claude_agent_sdk' as const, source: 'system/init' as const,
        nativeSessionId: 'n', sessionId: 's1', reportedAt: 1000, names: ['review'],
      },
    };
    render(<AgentDetails agent={dispatcher} chat={chat} />);
    expect(screen.getByTestId('details-card-actions')).toBeInTheDocument();
    for (const card of ['changes', 'subagents', 'canvases', 'context', 'mcp', 'provider-skills', 'session']) {
      expect(screen.queryByTestId(`details-card-${card}`)).not.toBeInTheDocument();
    }
    // No Changes card, so its folder isn't read for one.
    expect(window.clubhouse.git.branchChanges).not.toHaveBeenCalled();
  });

  it('leaves out Last session while it sleeps', () => {
    render(<AgentDetails agent={{ ...dispatcher, status: 'sleeping' }} lastSession={null} />);
    expect(screen.queryByTestId('details-card-session')).not.toBeInTheDocument();
    expect(screen.queryByTestId('details-card-canvases')).not.toBeInTheDocument();
  });

  it('falls back from a missing Canvases target to its own Actions card', async () => {
    render(<AgentDetails agent={dispatcher} />);
    await act(async () => useAgentDetailsStore.getState().reveal({ agentId: dispatcher.id, card: 'canvases' }));
    expect(screen.getByTestId('details-card-actions')).toHaveAttribute('data-open', 'true');
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
