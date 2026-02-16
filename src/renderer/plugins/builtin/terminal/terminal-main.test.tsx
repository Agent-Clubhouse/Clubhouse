import React from 'react';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { MainPanel, SidebarPanel, activate, deactivate } from './main';
import { terminalState } from './state';
import { createMockAPI, createMockContext } from '../../testing';
import type { AgentInfo } from '../../../../shared/plugin-types';

// ── Helpers ─────────────────────────────────────────────────────────────

function createTerminalAPI(bufferContent = '') {
  const onExitHandlers: ((code: number) => void)[] = [];

  return createMockAPI({
    terminal: {
      spawn: vi.fn(async () => {}),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(async () => {}),
      getBuffer: vi.fn(async () => bufferContent),
      onData: () => ({ dispose: () => {} }),
      onExit: vi.fn((_sessionId: string, cb: (code: number) => void) => {
        onExitHandlers.push(cb);
        return { dispose: () => {} };
      }),
      ShellTerminal: ({ sessionId }: { sessionId: string }) =>
        React.createElement('div', { 'data-testid': 'shell-terminal' }, `Shell: ${sessionId}`),
    },
    context: {
      mode: 'project',
      projectId: 'proj-1',
      projectPath: '/project',
    },
    _onExitHandlers: onExitHandlers,
  } as any);
}

const DURABLE_AGENT: AgentInfo = {
  id: 'agent-1',
  name: 'snazzy-fox',
  kind: 'durable',
  status: 'running',
  color: 'emerald',
  projectId: 'proj-1',
  worktreePath: '.clubhouse/agents/snazzy-fox',
};

const SECOND_DURABLE: AgentInfo = {
  id: 'agent-2',
  name: 'brave-owl',
  kind: 'durable',
  status: 'sleeping',
  color: 'blue',
  projectId: 'proj-1',
  worktreePath: '.clubhouse/agents/brave-owl',
};

const QUICK_AGENT: AgentInfo = {
  id: 'agent-3',
  name: 'quick-scout',
  kind: 'quick',
  status: 'running',
  color: 'gray',
  projectId: 'proj-1',
};

function createSidebarAPI(agents: AgentInfo[] = []) {
  let changeCallback: (() => void) | null = null;

  const api = createMockAPI({
    agents: {
      ...createMockAPI().agents,
      list: vi.fn(() => agents),
      onAnyChange: vi.fn((cb: () => void) => {
        changeCallback = cb;
        return { dispose: () => { changeCallback = null; } };
      }),
    },
    terminal: {
      spawn: vi.fn(async () => {}),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(async () => {}),
      getBuffer: vi.fn(async () => ''),
      onData: () => ({ dispose: () => {} }),
      onExit: vi.fn(() => ({ dispose: () => {} })),
      ShellTerminal: ({ sessionId }: { sessionId: string }) =>
        React.createElement('div', { 'data-testid': 'shell-terminal' }, `Shell: ${sessionId}`),
    },
    context: {
      mode: 'project',
      projectId: 'proj-1',
      projectPath: '/project',
    },
  });

  return {
    api,
    triggerAgentChange: () => { changeCallback?.(); },
  };
}

// ── MainPanel component tests ───────────────────────────────────────────

describe('Terminal MainPanel', () => {
  beforeEach(() => {
    terminalState.reset();
  });

  it('shows "Starting..." before spawn completes', () => {
    const api = createTerminalAPI();
    render(<MainPanel api={api} />);
    expect(screen.getByText('Starting terminal...')).toBeInTheDocument();
    expect(screen.getByText('Starting...')).toBeInTheDocument();
  });

  it('shows "Running" + ShellTerminal after spawn', async () => {
    const api = createTerminalAPI();
    render(<MainPanel api={api} />);

    await waitFor(() => {
      expect(screen.getByTestId('shell-terminal')).toBeInTheDocument();
      expect(screen.getByText('Running')).toBeInTheDocument();
    });
  });

  it('shows "Exited (code)" on exit', async () => {
    const api = createTerminalAPI();
    render(<MainPanel api={api} />);

    await waitFor(() => {
      expect(screen.getByTestId('shell-terminal')).toBeInTheDocument();
    });

    const onExitHandlers = (api as any)._onExitHandlers;
    act(() => {
      for (const handler of onExitHandlers) {
        handler(137);
      }
    });

    await waitFor(() => {
      expect(screen.getByText('Exited (137)')).toBeInTheDocument();
    });
  });

  it('restart calls kill then re-spawn', async () => {
    const api = createTerminalAPI();
    render(<MainPanel api={api} />);

    await waitFor(() => {
      expect(screen.getByTestId('shell-terminal')).toBeInTheDocument();
    });

    const restartBtn = screen.getByText('Restart');
    fireEvent.click(restartBtn);

    await waitFor(() => {
      expect(api.terminal.kill).toHaveBeenCalledWith('terminal:proj-1:project');
      expect(api.terminal.spawn).toHaveBeenCalledTimes(2); // initial + restart
    });
  });

  it('uses makeSessionId format for session ID (not raw projectId)', async () => {
    const api = createTerminalAPI();
    render(<MainPanel api={api} />);

    await waitFor(() => {
      expect(screen.getByTestId('shell-terminal')).toBeInTheDocument();
    });

    // ShellTerminal renders the sessionId — verify it uses the new format
    expect(screen.getByText('Shell: terminal:proj-1:project')).toBeInTheDocument();
  });

  it('spawns with projectPath as cwd', async () => {
    const api = createTerminalAPI();
    render(<MainPanel api={api} />);

    await waitFor(() => {
      expect(api.terminal.spawn).toHaveBeenCalledWith('terminal:proj-1:project', '/project');
    });
  });

  it('shows "Terminal — Project" header when no target or project target selected', async () => {
    const api = createTerminalAPI();
    render(<MainPanel api={api} />);

    await waitFor(() => {
      expect(screen.getByText('Terminal \u2014 Project')).toBeInTheDocument();
    });
  });

  it('shows "Terminal — {name}" header when agent target selected', async () => {
    // Pre-set an agent target before rendering
    act(() => {
      terminalState.setActiveTarget({
        sessionId: 'terminal:proj-1:agent:snazzy-fox',
        label: 'snazzy-fox',
        cwd: '/project/.clubhouse/agents/snazzy-fox',
        kind: 'agent',
      });
    });

    const api = createTerminalAPI();
    render(<MainPanel api={api} />);

    await waitFor(() => {
      expect(screen.getByText('Terminal \u2014 snazzy-fox')).toBeInTheDocument();
    });
  });

  it('reconnects existing session via getBuffer instead of re-spawning', async () => {
    const api = createTerminalAPI('$ previous output\n');
    render(<MainPanel api={api} />);

    await waitFor(() => {
      expect(screen.getByText('Running')).toBeInTheDocument();
    });

    // getBuffer returned content, so spawn should NOT be called
    expect(api.terminal.spawn).not.toHaveBeenCalled();
    expect(api.terminal.getBuffer).toHaveBeenCalledWith('terminal:proj-1:project');
  });

  it('reacts to terminalState target changes', async () => {
    const api = createTerminalAPI();
    render(<MainPanel api={api} />);

    await waitFor(() => {
      expect(screen.getByText('Terminal \u2014 Project')).toBeInTheDocument();
    });

    // Switch to agent target
    act(() => {
      terminalState.setActiveTarget({
        sessionId: 'terminal:proj-1:agent:snazzy-fox',
        label: 'snazzy-fox',
        cwd: '/project/.clubhouse/agents/snazzy-fox',
        kind: 'agent',
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Terminal \u2014 snazzy-fox')).toBeInTheDocument();
      expect(screen.getByText('Shell: terminal:proj-1:agent:snazzy-fox')).toBeInTheDocument();
    });
  });
});

// ── SidebarPanel component tests ────────────────────────────────────────

describe('Terminal SidebarPanel', () => {
  beforeEach(() => {
    terminalState.reset();
  });

  it('renders "Targets" header', () => {
    const { api } = createSidebarAPI();
    render(<SidebarPanel api={api} />);
    expect(screen.getByText('Targets')).toBeInTheDocument();
  });

  it('always shows "Project" row', () => {
    const { api } = createSidebarAPI([]);
    render(<SidebarPanel api={api} />);
    expect(screen.getByText('Project')).toBeInTheDocument();
  });

  it('shows durable agent rows with worktreePath', () => {
    const { api } = createSidebarAPI([DURABLE_AGENT, SECOND_DURABLE]);
    render(<SidebarPanel api={api} />);

    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.getByText('snazzy-fox')).toBeInTheDocument();
    expect(screen.getByText('brave-owl')).toBeInTheDocument();
  });

  it('filters out quick agents (no worktreePath)', () => {
    const { api } = createSidebarAPI([DURABLE_AGENT, QUICK_AGENT]);
    render(<SidebarPanel api={api} />);

    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.getByText('snazzy-fox')).toBeInTheDocument();
    expect(screen.queryByText('quick-scout')).not.toBeInTheDocument();
  });

  it('filters out durable agents without worktreePath', () => {
    const noWorktree: AgentInfo = { ...DURABLE_AGENT, worktreePath: undefined };
    const { api } = createSidebarAPI([noWorktree]);
    render(<SidebarPanel api={api} />);

    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.queryByText('snazzy-fox')).not.toBeInTheDocument();
  });

  it('auto-selects Project target on mount', () => {
    const { api } = createSidebarAPI();
    render(<SidebarPanel api={api} />);

    expect(terminalState.activeTarget).not.toBeNull();
    expect(terminalState.activeTarget!.kind).toBe('project');
    expect(terminalState.activeTarget!.sessionId).toBe('terminal:proj-1:project');
  });

  it('clicking an agent row sets it as active target', async () => {
    const { api } = createSidebarAPI([DURABLE_AGENT]);
    render(<SidebarPanel api={api} />);

    const agentRow = screen.getByText('snazzy-fox');
    fireEvent.click(agentRow);

    expect(terminalState.activeTarget).not.toBeNull();
    expect(terminalState.activeTarget!.kind).toBe('agent');
    expect(terminalState.activeTarget!.label).toBe('snazzy-fox');
    expect(terminalState.activeTarget!.cwd).toBe('/project/.clubhouse/agents/snazzy-fox');
  });

  it('clicking Project row sets project as active target', () => {
    // Start with agent selected
    const { api } = createSidebarAPI([DURABLE_AGENT]);
    render(<SidebarPanel api={api} />);

    fireEvent.click(screen.getByText('snazzy-fox'));
    expect(terminalState.activeTarget!.kind).toBe('agent');

    fireEvent.click(screen.getByText('Project'));
    expect(terminalState.activeTarget!.kind).toBe('project');
    expect(terminalState.activeTarget!.cwd).toBe('/project');
  });

  it('subscribes to agents.onAnyChange for live updates', () => {
    const { api } = createSidebarAPI([DURABLE_AGENT]);
    render(<SidebarPanel api={api} />);

    expect(api.agents.onAnyChange).toHaveBeenCalledWith(expect.any(Function));
  });

  it('refreshes target list when agents change', () => {
    const agents = [DURABLE_AGENT];
    const { api, triggerAgentChange } = createSidebarAPI(agents);
    render(<SidebarPanel api={api} />);

    expect(screen.getByText('snazzy-fox')).toBeInTheDocument();

    // Simulate a new agent arriving
    (api.agents.list as ReturnType<typeof vi.fn>).mockReturnValue([DURABLE_AGENT, SECOND_DURABLE]);
    act(() => { triggerAgentChange(); });

    expect(screen.getByText('brave-owl')).toBeInTheDocument();
  });

  it('populates targets in terminalState on mount', () => {
    const { api } = createSidebarAPI([DURABLE_AGENT]);
    render(<SidebarPanel api={api} />);

    expect(terminalState.targets).toHaveLength(2); // Project + snazzy-fox
    expect(terminalState.targets[0].kind).toBe('project');
    expect(terminalState.targets[1].kind).toBe('agent');
  });

  it('highlights active target row', () => {
    const { api } = createSidebarAPI([DURABLE_AGENT]);
    const { container } = render(<SidebarPanel api={api} />);

    // Project is auto-selected — its button should have the active class with font-medium
    const buttons = container.querySelectorAll('button');
    const projectBtn = Array.from(buttons).find((b) => b.textContent?.includes('Project'))!;
    expect(projectBtn.className).toContain('font-medium');

    // Agent row should NOT have active class
    const agentBtn = Array.from(buttons).find((b) => b.textContent?.includes('snazzy-fox'))!;
    expect(agentBtn.className).not.toContain('font-medium');
  });

  it('disposes onAnyChange subscription on unmount', () => {
    const disposeSpy = vi.fn();
    const api = createMockAPI({
      agents: {
        ...createMockAPI().agents,
        list: vi.fn(() => []),
        onAnyChange: vi.fn(() => ({ dispose: disposeSpy })),
      },
      context: { mode: 'project', projectId: 'proj-1', projectPath: '/project' },
    });

    const { unmount } = render(<SidebarPanel api={api} />);
    unmount();

    expect(disposeSpy).toHaveBeenCalled();
  });
});

// ── Cross-panel integration ─────────────────────────────────────────────

describe('Terminal cross-panel integration', () => {
  beforeEach(() => {
    terminalState.reset();
  });

  it('SidebarPanel click propagates to MainPanel via terminalState', async () => {
    const { api } = createSidebarAPI([DURABLE_AGENT]);

    // Render both panels (as the plugin host would)
    const { container: sidebarContainer } = render(<SidebarPanel api={api} />);
    render(<MainPanel api={api} />);

    // Wait for MainPanel to spawn project terminal
    await waitFor(() => {
      expect(screen.getByText('Terminal \u2014 Project')).toBeInTheDocument();
    });

    // Click agent in sidebar
    const agentRow = screen.getByText('snazzy-fox');
    fireEvent.click(agentRow);

    // MainPanel should react
    await waitFor(() => {
      expect(screen.getByText('Terminal \u2014 snazzy-fox')).toBeInTheDocument();
    });
  });

  it('deactivate resets terminalState used by both panels', () => {
    const { api } = createSidebarAPI([DURABLE_AGENT]);
    render(<SidebarPanel api={api} />);

    expect(terminalState.activeTarget).not.toBeNull();
    expect(terminalState.targets.length).toBeGreaterThan(0);

    deactivate();

    expect(terminalState.activeTarget).toBeNull();
    expect(terminalState.targets).toEqual([]);
  });
});

// ── activate/deactivate ─────────────────────────────────────────────────

describe('Terminal activate/deactivate', () => {
  beforeEach(() => {
    terminalState.reset();
  });

  it('activate registers the restart command', () => {
    const ctx = createMockContext();
    const api = createMockAPI();
    const registerSpy = vi.spyOn(api.commands, 'register');

    activate(ctx, api);

    expect(registerSpy).toHaveBeenCalledWith('restart', expect.any(Function));
    expect(ctx.subscriptions).toHaveLength(1);
  });

  it('deactivate does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });

  it('deactivate resets terminalState', () => {
    terminalState.setActiveTarget({
      sessionId: 'terminal:proj-1:project',
      label: 'Project',
      cwd: '/project',
      kind: 'project',
    });

    deactivate();

    expect(terminalState.activeTarget).toBeNull();
    expect(terminalState.targets).toEqual([]);
  });
});
