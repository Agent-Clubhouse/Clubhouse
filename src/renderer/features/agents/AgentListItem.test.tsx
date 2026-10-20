import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentListItem } from './AgentListItem';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import type { Agent } from '../../../shared/types';
import { useHelperStartRequestStore } from '../../stores/helperStartRequestStore';
import { useHelperDisposeRequestStore } from '../../stores/helperDisposeRequestStore';
import { useAgentDetailsStore } from './details/detailsStore';

const baseAgent: Agent = {
  id: 'agent-1',
  projectId: 'proj-1',
  name: 'bold-falcon',
  kind: 'durable',
  status: 'sleeping',
  color: 'indigo',
};

function resetStores(agentOverrides: Partial<Agent> = {}) {
  const agent = { ...baseAgent, ...agentOverrides };
  useAgentStore.setState({
    agents: { [agent.id]: agent },
    activeAgentId: agent.id,
    agentIcons: {},
    agentDetailedStatus: {},
    killAgent: vi.fn(),
    removeAgent: vi.fn(),
    spawnDurableAgent: vi.fn(),
    openAgentSettings: vi.fn(),
    openDeleteDialog: vi.fn(),
  });
  useProjectStore.setState({
    projects: [{ id: 'proj-1', name: 'test-project', path: '/project' }],
    activeProjectId: 'proj-1',
  });
  useOrchestratorStore.setState({
    enabled: ['claude-code'],
    allOrchestrators: [{
      id: 'claude-code',
      displayName: 'Claude Code',
      shortName: 'CC',
      capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true },
    }],
  });
}

function renderItem(agentOverrides: Partial<Agent> = {}, props: Partial<{ onSpawnQuickChild: () => void }> = {}) {
  const agent = { ...baseAgent, ...agentOverrides };
  resetStores(agentOverrides);
  return render(
    <AgentListItem agent={agent} isActive={false} isThinking={false} onSelect={vi.fn()} {...props} />,
  );
}

describe('AgentListItem activity animation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not apply animation classes when agent is sleeping', () => {
    const { container } = renderItem({ status: 'sleeping' });
    const avatarWrapper = container.querySelector('[class*="flex-shrink-0"]');
    expect(avatarWrapper?.className).not.toContain('animate-pulse-ring');
    expect(avatarWrapper?.className).not.toContain('animate-headless-orbit');
  });

  it('applies animate-pulse-ring when agent is working', () => {
    resetStores({ status: 'running' });
    useAgentStore.setState({
      agentDetailedStatus: { 'agent-1': { state: 'working', message: 'Thinking...' } },
    });
    const agent = { ...baseAgent, status: 'running' as const };
    const { container } = render(
      <AgentListItem agent={agent} isActive={false} isThinking={true} onSelect={vi.fn()} />,
    );
    const avatarWrapper = container.querySelector('[class*="flex-shrink-0"]');
    expect(avatarWrapper?.className).toContain('animate-pulse-ring');
  });

  it('does not use headless-orbit for headless running agents', () => {
    resetStores({ status: 'running', headless: true });
    useAgentStore.setState({
      agentDetailedStatus: { 'agent-1': { state: 'working', message: 'Processing...' } },
    });
    const agent = { ...baseAgent, status: 'running' as const, headless: true };
    const { container } = render(
      <AgentListItem agent={agent} isActive={false} isThinking={true} onSelect={vi.fn()} />,
    );
    const avatarWrapper = container.querySelector('[class*="flex-shrink-0"]');
    // Should use pulse-ring, not headless-orbit
    expect(avatarWrapper?.className).toContain('animate-pulse-ring');
    expect(avatarWrapper?.className).not.toContain('animate-headless-orbit');
  });

  it('applies pulse-ring consistently for both durable and quick working agents', () => {
    resetStores({ status: 'running', kind: 'quick' });
    const agent = { ...baseAgent, status: 'running' as const, kind: 'quick' as const };
    const { container } = render(
      <AgentListItem agent={agent} isActive={false} isThinking={true} onSelect={vi.fn()} />,
    );
    const avatarWrapper = container.querySelector('[class*="flex-shrink-0"]');
    expect(avatarWrapper?.className).toContain('animate-pulse-ring');
  });
});

describe('AgentListItem actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.window.createPopout = vi.fn().mockResolvedValue(1);
  });

  it('renders pop-out action button for sleeping durable agent', () => {
    renderItem({ status: 'sleeping' });
    expect(screen.getByTestId('action-popout')).toBeInTheDocument();
  });

  it('renders pop-out action button for running agent', () => {
    renderItem({ status: 'running' });
    expect(screen.getByTestId('action-popout')).toBeInTheDocument();
  });

  it('renders pop-out action button for quick agent', () => {
    renderItem({ status: 'running', kind: 'quick' });
    expect(screen.getByTestId('action-popout')).toBeInTheDocument();
  });

  it('calls createPopout when pop-out button is clicked', () => {
    renderItem({ status: 'sleeping' });
    fireEvent.click(screen.getByTestId('action-popout'));
    expect(window.clubhouse.window.createPopout).toHaveBeenCalledWith({
      type: 'agent',
      agentId: 'agent-1',
      projectId: 'proj-1',
      title: 'Agent — bold-falcon',
    });
  });

  it('renders wake button for sleeping durable agent', () => {
    renderItem({ status: 'sleeping' });
    expect(screen.getByTestId('action-wake')).toBeInTheDocument();
  });

  it('renders start-new-session button for sleeping durable agent', () => {
    renderItem({ status: 'sleeping' });
    expect(screen.getByTestId('action-wake-new')).toBeInTheDocument();
  });

  it('renders stop button for running agent', () => {
    renderItem({ status: 'running' });
    expect(screen.getByTestId('action-stop')).toBeInTheDocument();
  });

  it('renders delete button for sleeping durable agent', () => {
    renderItem({ status: 'sleeping' });
    expect(screen.getByTestId('action-delete')).toBeInTheDocument();
  });

  it('renders settings button for durable agent', () => {
    renderItem({ status: 'sleeping' });
    expect(screen.getByTestId('action-settings')).toBeInTheDocument();
  });

  it('renders spawn button when onSpawnQuickChild is provided', () => {
    renderItem({ status: 'sleeping' }, { onSpawnQuickChild: vi.fn() });
    expect(screen.getByTestId('action-spawn')).toBeInTheDocument();
  });

  it('does not render spawn button when onSpawnQuickChild is not provided', () => {
    renderItem({ status: 'sleeping' });
    expect(screen.queryByTestId('action-spawn')).toBeNull();
  });
});

describe('AgentListItem context menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.window.createPopout = vi.fn().mockResolvedValue(1);
  });

  it('opens context menu on right-click', () => {
    renderItem({ status: 'sleeping' });
    const row = screen.getByTestId('agent-item-agent-1');
    fireEvent.contextMenu(row);
    expect(screen.getByTestId('agent-context-menu')).toBeInTheDocument();
  });

  it('context menu shows all available actions including Start New Session', () => {
    renderItem({ status: 'sleeping' }, { onSpawnQuickChild: vi.fn() });
    const row = screen.getByTestId('agent-item-agent-1');
    fireEvent.contextMenu(row);

    expect(screen.getByTestId('ctx-wake')).toBeInTheDocument();
    expect(screen.getByTestId('ctx-wake-new')).toBeInTheDocument();
    expect(screen.getByTestId('ctx-popout')).toBeInTheDocument();
    expect(screen.getByTestId('ctx-spawn')).toBeInTheDocument();
    expect(screen.getByTestId('ctx-settings')).toBeInTheDocument();
    expect(screen.getByTestId('ctx-delete')).toBeInTheDocument();
  });

  it('context menu calls createPopout when Pop Out is clicked', () => {
    renderItem({ status: 'sleeping' });
    const row = screen.getByTestId('agent-item-agent-1');
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByTestId('ctx-popout'));
    expect(window.clubhouse.window.createPopout).toHaveBeenCalledWith({
      type: 'agent',
      agentId: 'agent-1',
      projectId: 'proj-1',
      title: 'Agent — bold-falcon',
    });
  });

  it('context menu closes after clicking an action', () => {
    renderItem({ status: 'sleeping' });
    const row = screen.getByTestId('agent-item-agent-1');
    fireEvent.contextMenu(row);
    expect(screen.getByTestId('agent-context-menu')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ctx-popout'));
    expect(screen.queryByTestId('agent-context-menu')).toBeNull();
  });

  it('context menu closes on escape', () => {
    renderItem({ status: 'sleeping' });
    const row = screen.getByTestId('agent-item-agent-1');
    fireEvent.contextMenu(row);
    expect(screen.getByTestId('agent-context-menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('agent-context-menu')).toBeNull();
  });

  it('does not show start-new-session in context menu for running agents', () => {
    renderItem({ status: 'running' });
    const row = screen.getByTestId('agent-item-agent-1');
    fireEvent.contextMenu(row);
    expect(screen.queryByTestId('ctx-wake-new')).toBeNull();
  });

  it('context menu portals to document.body so it is not trapped by stacking contexts', () => {
    const { container } = renderItem({ status: 'sleeping' });
    const row = screen.getByTestId('agent-item-agent-1');
    fireEvent.contextMenu(row);

    const menu = screen.getByTestId('agent-context-menu');
    expect(menu).toBeInTheDocument();
    // Must be a direct child of body, not inside the component's render container,
    // so PTY/content-view stacking contexts cannot obscure it.
    expect(document.body.contains(menu)).toBe(true);
    expect(container.contains(menu)).toBe(false);
  });
});

describe('AgentListItem overflow menu', () => {
  // The [...] trigger only appears when the actions row is too narrow to fit
  // every action. jsdom never performs layout, so ResizeObserver has to be
  // stubbed to report a narrow row — otherwise maxVisible stays at
  // actions.length, hasOverflow is false, and the [...] button never renders.
  // ACTION_BUTTON_WIDTH is 26, so a 52px row fits 2 buttons and collapses the rest.
  // Assign/restore directly rather than via vi.stubGlobal: vi.unstubAllGlobals()
  // would also drop the window.clubhouse bridge mock that setup-renderer.ts
  // installs with stubGlobal, breaking every later describe in this file.
  const originalResizeObserver = globalThis.ResizeObserver;

  function stubNarrowActionsRow(width: number) {
    globalThis.ResizeObserver = class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(target: Element) {
        this.cb(
          [{ target, contentRect: { width } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve = vi.fn();
      disconnect = vi.fn();
    } as unknown as typeof ResizeObserver;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.window.createPopout = vi.fn().mockResolvedValue(1);
    stubNarrowActionsRow(52);
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('renders the [...] trigger when actions do not fit the row', () => {
    renderItem({ status: 'sleeping' }, { onSpawnQuickChild: vi.fn() });
    expect(screen.getByTestId('action-overflow')).toBeInTheDocument();
  });

  it('opens the overflow menu when [...] is clicked', () => {
    renderItem({ status: 'sleeping' }, { onSpawnQuickChild: vi.fn() });
    expect(screen.queryByTestId('agent-context-menu')).toBeNull();
    fireEvent.click(screen.getByTestId('action-overflow'));
    expect(screen.getByTestId('agent-context-menu')).toBeInTheDocument();
  });

  // Regression guard for gh-1471: the [...] menu rendered behind the
  // pseudoterminal / content view. The fix portals it to document.body so no
  // ancestor stacking context (e.g. CanvasWorkspace's transform: scale(...))
  // can trap or obscure it. The right-click path has its own guard above;
  // this covers the [...] path the issue was actually filed against.
  it('overflow menu portals to document.body so it is not trapped by stacking contexts', () => {
    const { container } = renderItem({ status: 'sleeping' }, { onSpawnQuickChild: vi.fn() });
    fireEvent.click(screen.getByTestId('action-overflow'));

    const menu = screen.getByTestId('agent-context-menu');
    expect(document.body.contains(menu)).toBe(true);
    expect(container.contains(menu)).toBe(false);
  });

  it('overflow menu closes on escape', () => {
    renderItem({ status: 'sleeping' }, { onSpawnQuickChild: vi.fn() });
    fireEvent.click(screen.getByTestId('action-overflow'));
    expect(screen.getByTestId('agent-context-menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('agent-context-menu')).toBeNull();
  });
});

describe('AgentListItem fine-grained selectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.window.createPopout = vi.fn().mockResolvedValue(1);
  });

  it('does not re-render when unrelated agent store state changes', () => {
    const renderCount = vi.fn();
    const WrappedItem = (props: React.ComponentProps<typeof AgentListItem>) => {
      renderCount();
      return <AgentListItem {...props} />;
    };

    const agent = { ...baseAgent, status: 'sleeping' as const };
    resetStores({ status: 'sleeping' });
    const { rerender } = render(
      <WrappedItem agent={agent} isActive={false} isThinking={false} onSelect={vi.fn()} />,
    );
    const initialRenderCount = renderCount.mock.calls.length;

    // Mutate unrelated store state (e.g., activeAgentId, a different agent's status)
    useAgentStore.setState({ activeAgentId: 'some-other-agent' });

    // Re-render with same props — the component itself shouldn't have been triggered
    // by the store change since it uses fine-grained selectors
    rerender(
      <WrappedItem agent={agent} isActive={false} isThinking={false} onSelect={vi.fn()} />,
    );

    // The rerender call itself causes 1 render, but the store change should not
    // have caused an additional render
    expect(renderCount.mock.calls.length).toBe(initialRenderCount + 1);
  });

  it('re-renders when its own agent icon changes', () => {
    // agent.icon must be truthy for the img to render
    const agent = { ...baseAgent, status: 'sleeping' as const, icon: 'custom-icon.png' };
    resetStores({ status: 'sleeping', icon: 'custom-icon.png' });
    const { rerender } = render(
      <AgentListItem agent={agent} isActive={false} isThinking={false} onSelect={vi.fn()} />,
    );

    // Changing this agent's icon data URL should be reflected
    act(() => {
      useAgentStore.setState({
        agentIcons: { 'agent-1': 'data:image/png;base64,abc' },
      });
    });

    rerender(
      <AgentListItem agent={agent} isActive={false} isThinking={false} onSelect={vi.fn()} />,
    );

    // The icon should appear (img tag)
    const img = document.querySelector('img[alt="bold-falcon"]');
    expect(img).toBeInTheDocument();
  });

  it('does not re-render when unrelated project store state changes', () => {
    const renderCount = vi.fn();
    const WrappedItem = (props: React.ComponentProps<typeof AgentListItem>) => {
      renderCount();
      return <AgentListItem {...props} />;
    };

    const agent = { ...baseAgent, status: 'sleeping' as const };
    resetStores({ status: 'sleeping' });
    const { rerender } = render(
      <WrappedItem agent={agent} isActive={false} isThinking={false} onSelect={vi.fn()} />,
    );
    const initialRenderCount = renderCount.mock.calls.length;

    // Mutate unrelated project store state (gitStatus)
    useProjectStore.setState({ gitStatus: { 'proj-1': true } });

    rerender(
      <WrappedItem agent={agent} isActive={false} isThinking={false} onSelect={vi.fn()} />,
    );

    expect(renderCount.mock.calls.length).toBe(initialRenderCount + 1);
  });
});

describe('AgentListItem indent', () => {
  it('pads a row by the given indent instead of the nested or top-level padding', () => {
    renderItem();
    const plain = screen.getByTestId('agent-item-agent-1');
    expect(plain.className).toContain('px-3');
    expect(plain.style.paddingLeft).toBe('');
  });

  it('uses the indent for a deeper row', () => {
    const agent = { ...baseAgent };
    resetStores();
    render(<AgentListItem agent={agent} isActive={false} isThinking={false} onSelect={vi.fn()} indent={40} />);
    const row = screen.getByTestId('agent-item-agent-1');
    expect(row.style.paddingLeft).toBe('40px');
    expect(row.className).not.toContain('px-3');
    expect(row.className).not.toContain('pl-7');
  });
});

describe('AgentListItem helper roll-up and requests (legacy layout)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    useHelperStartRequestStore.setState({ requests: {} });
    useHelperDisposeRequestStore.setState({ requests: {}, reviewing: null });
    useAgentDetailsStore.setState({ focus: null });
  });

  it('shows how many helpers a folded parent hides, described for screen readers', () => {
    resetStores();
    render(<AgentListItem agent={baseAgent} isActive={false} isThinking={false} onSelect={vi.fn()} helperRollup={{ count: 2, needs: 0, working: 0 }} />);
    const rollup = screen.getByTestId('helper-rollup');
    expect(rollup).toHaveTextContent('2 helpers');
    // Quiet: no dot while nothing needs you or works.
    expect(screen.queryByTestId('helper-rollup-dot')).toBeNull();
    expect(screen.getByTestId('agent-item-agent-1')).toHaveAttribute('aria-describedby', rollup.id);
  });

  it('adds a dot when a folded helper needs you, and says so to screen readers', () => {
    resetStores();
    render(<AgentListItem agent={baseAgent} isActive={false} isThinking={false} onSelect={vi.fn()} helperRollup={{ count: 1, needs: 1, working: 0 }} />);
    expect(screen.getByTestId('helper-rollup')).toHaveTextContent('1 helper, 1 needs you');
    expect(screen.getByTestId('helper-rollup-dot').className).toContain('bg-ctp-warning');
  });

  it('keeps its chips on one line, shortening them with a tooltip, so an indented helper row stays the same height', () => {
    resetStores();
    render(<AgentListItem agent={baseAgent} isActive={false} isThinking={false} onSelect={vi.fn()} indent={40} />);
    const label = screen.getByText('Claude Code');
    const chips = label.parentElement!;
    expect(chips.className).not.toMatch(/\bflex-wrap\b/);
    expect(chips.className).toMatch(/\bmin-w-0\b/);
    expect(label.className).toMatch(/\btruncate\b/);
    expect(label.className).toMatch(/\bmin-w-0\b/);
    expect(label).toHaveAttribute('title', 'Claude Code');
    expect(screen.getByText('bold-falcon')).toHaveAttribute('title', 'bold-falcon');
  });

  it('shows no roll-up for an unfolded or helperless row', () => {
    renderItem();
    expect(screen.queryByTestId('helper-rollup')).toBeNull();
    expect(screen.getByTestId('agent-item-agent-1')).not.toHaveAttribute('aria-describedby');
  });

  it('shows an orchestrator’s waiting starts and opens its Helpers card', () => {
    const onSelect = vi.fn();
    resetStores();
    useHelperStartRequestStore.setState({
      requests: {
        r1: { requestId: 'r1', orchestratorId: 'agent-1', orchestratorName: 'bold-falcon', projectPath: '/project', args: { name: 'impl-api', task: 't' }, createdAt: '2026-10-18T10:00:00Z', expiresAt: '2026-10-19T10:00:00Z' },
      },
    });
    render(<AgentListItem agent={baseAgent} isActive={false} isThinking={false} onSelect={onSelect} />);
    const line = screen.getByTestId('agent-helper-request');
    expect(line).toHaveTextContent('Wants to start the helper impl-api');
    fireEvent.click(line);
    expect(onSelect).toHaveBeenCalledWith('agent-1');
    expect(useAgentDetailsStore.getState().focus).toMatchObject({ agentId: 'agent-1', card: 'helpers' });
  });

  it('shows a helper’s dispose request and opens the dispose dialog for it', () => {
    const onSelect = vi.fn();
    resetStores();
    useHelperDisposeRequestStore.getState().add({
      helperId: 'agent-1', helperName: 'bold-falcon', orchestratorId: 'orch', projectPath: '/project',
      checks: { dirty: 0, unpushed: 0, unmerged: 0 }, forceRequested: false,
    } as never, 'orch');
    render(<AgentListItem agent={baseAgent} isActive={false} isThinking={false} onSelect={onSelect} />);
    const line = screen.getByTestId('agent-helper-request');
    expect(line).toHaveTextContent('orch asked to dispose this helper');
    fireEvent.click(line);
    expect(onSelect).toHaveBeenCalledWith('agent-1');
    expect(useHelperDisposeRequestStore.getState().reviewing).toBe('agent-1');
  });
});
