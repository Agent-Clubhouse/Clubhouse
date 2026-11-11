import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, act, within } from '@testing-library/react';
import { WireConfigPopover } from './WireConfigPopover';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { useAgentStore } from '../../../stores/agentStore';
import { useAgentDetailsStore } from '../../../features/agents/details/detailsStore';
import { WAKE_TOOL } from '../../../../shared/connection-grants';
import { DISPATCHER_OFF } from '../../../../shared/dispatcher-types';
import { useDispatcherStore } from '../../../features/dispatcher/dispatcherStore';

describe('WireConfigPopover', () => {
  const browserBinding: McpBindingEntry = {
    agentId: 'agent-1',
    targetId: 'browser-1',
    targetKind: 'browser',
    label: 'My Browser',
  };

  const agentBinding: McpBindingEntry = {
    agentId: 'agent-1',
    targetId: 'agent-2',
    targetKind: 'agent',
    label: 'Agent 2',
  };

  beforeEach(() => {
    useMcpBindingStore.setState({ bindings: [browserBinding, agentBinding] });
    useAgentStore.setState({ agents: {} });
    useAgentDetailsStore.setState({ open: false, focus: null });
    useDispatcherStore.setState({ state: null });
    window.clubhouse.mcpBinding.getConnectionGrants = vi.fn(async () => []);
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({ pairs: [], unreadable: [] }));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders binding info', () => {
    const { container } = render(
      <WireConfigPopover binding={browserBinding} x={100} y={200} onClose={vi.fn()} />,
    );
    expect(container.textContent).toContain('My Browser');
    expect(container.textContent).toContain('browser');
  });

  it('calls unbind and onClose when Disconnect is clicked', () => {
    const unbindMock = vi.fn().mockResolvedValue(undefined);
    useMcpBindingStore.setState({ bindings: [browserBinding], unbind: unbindMock } as any);

    const onClose = vi.fn();
    const { getByTestId } = render(
      <WireConfigPopover binding={browserBinding} x={100} y={200} onClose={onClose} />,
    );

    fireEvent.click(getByTestId('wire-disconnect'));
    expect(unbindMock).toHaveBeenCalledWith('agent-1', 'browser-1');
  });

  it('does not show bidirectional toggle for browser bindings', () => {
    const { queryByTestId } = render(
      <WireConfigPopover binding={browserBinding} x={100} y={200} onClose={vi.fn()} />,
    );
    expect(queryByTestId('wire-bidirectional-toggle')).toBeNull();
  });

  it('shows bidirectional toggle for agent-to-agent bindings', () => {
    const { getByTestId } = render(
      <WireConfigPopover binding={agentBinding} x={100} y={200} onClose={vi.fn()} />,
    );
    expect(getByTestId('wire-bidirectional-toggle')).toBeTruthy();
  });

  it('summarizes both saved directions and opens the sender Connections card without rewriting tools (#3213)', async () => {
    const forward = { ...agentBinding, disabledTools: ['read_output', 'future_tool'], enabledTools: [WAKE_TOOL] };
    const reverse = { ...agentBinding, agentId: 'agent-2', targetId: 'agent-1', label: 'Agent 1', disabledTools: ['clear_agent'] };
    const setDisabledTools = vi.fn();
    useMcpBindingStore.setState({ bindings: [forward, reverse], setDisabledTools });
    useAgentStore.setState({ agents: {
      'agent-1': { id: 'agent-1', name: 'A', projectId: 'p1', kind: 'durable', status: 'sleeping', color: 'teal' },
      'agent-2': { id: 'agent-2', name: 'B', projectId: 'p1', kind: 'durable', status: 'running', color: 'teal' },
    } });
    window.clubhouse.mcpBinding.getConnectionGrants = vi.fn(async () => [
      { from: { agentId: 'agent-1' }, to: { agentId: 'agent-2' }, disabledTools: ['send_message', 'future_tool'], enabledTools: [WAKE_TOOL], updatedAt: '' },
      { from: { agentId: 'agent-2' }, to: { agentId: 'agent-1' }, disabledTools: ['clear_agent'], updatedAt: '' },
    ]);
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: [{ agentId: 'agent-1', targetId: 'agent-2', bound: true, sources: [{ kind: 'canvas', sourceId: 'canvas-wires' }, { kind: 'tool_link', sourceId: 'orchestrator-connections' }] }],
      unreadable: [],
    }));
    const onClose = vi.fn();
    const onUpdateWireDefinition = vi.fn();
    const { getByTestId } = render(<WireConfigPopover binding={forward} x={100} y={200} onClose={onClose} onUpdateWireDefinition={onUpdateWireDefinition} />);
    fireEvent.click(getByTestId('wire-permissions-button'));
    const aToB = await waitFor(() => getByTestId('wire-connection-direction-agent-1-agent-2'));
    const bToA = getByTestId('wire-connection-direction-agent-2-agent-1');
    expect(aToB).toHaveTextContent('A \u2192 B');
    expect(bToA).toHaveTextContent('B \u2192 A');
    const switchRow = (section: HTMLElement, label: string) => within(section).getByText(label).closest('li');
    expect(switchRow(aToB, 'Send messages')).toHaveTextContent('Off');
    expect(switchRow(aToB, 'Read output')).toHaveTextContent('On');
    expect(switchRow(aToB, 'Wake it')).toHaveTextContent('On');
    expect(switchRow(bToA, 'Send messages')).toHaveTextContent('On');
    expect(switchRow(bToA, 'Clear its context')).toHaveTextContent('Off');
    expect(switchRow(bToA, 'Wake it')).toHaveTextContent('Off');
    expect(aToB).toHaveTextContent('From: Canvas wire, Made by an orchestrator.');
    const dialog = within(getByTestId('wire-tool-permissions-dialog'));
    expect(dialog.queryByRole('switch')).toBeNull();
    expect(dialog.queryByTestId('wire-permissions-save')).toBeNull();
    expect(dialog.getByText(/sender's Clubhouse permissions can still turn a tool off or require Ask first/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Edit connections' }));
    expect(useAgentDetailsStore.getState().focus).toMatchObject({ agentId: 'agent-1', card: 'connections' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(setDisabledTools).not.toHaveBeenCalled();
    expect(onUpdateWireDefinition).not.toHaveBeenCalled();
    expect(useMcpBindingStore.getState().bindings).toEqual([forward, reverse]);
  });

  it('uses live starting switches, shows a missing reverse direction, and refreshes saved changes (#3213)', async () => {
    const forward = { ...agentBinding, agentName: 'A', targetName: 'B', disabledTools: ['clear_agent', 'compact_agent'], enabledTools: [WAKE_TOOL] };
    useMcpBindingStore.setState({ bindings: [forward] });
    let changed!: () => void;
    const unsubscribe = vi.fn();
    window.clubhouse.mcpBinding.onConnectionGrantsChanged = vi.fn((cb) => { changed = () => cb('agent-1', 'agent-2', []); return unsubscribe; });
    const { getByTestId, unmount } = render(<WireConfigPopover binding={forward} x={100} y={200} onClose={vi.fn()} />);
    fireEvent.click(getByTestId('wire-permissions-button'));
    const aToB = await waitFor(() => getByTestId('wire-connection-direction-agent-1-agent-2'));
    expect(within(aToB).getByText('Wake it').closest('li')).toHaveTextContent('On');
    expect(getByTestId('wire-connection-direction-agent-2-agent-1')).toHaveTextContent('Not connected this way.');
    window.clubhouse.mcpBinding.getConnectionGrants = vi.fn(async () => [
      { from: { agentId: 'agent-1' }, to: { agentId: 'agent-2' }, disabledTools: ['read_output'], updatedAt: '' },
    ]);
    act(() => changed());
    await waitFor(() => expect(within(getByTestId('wire-connection-direction-agent-1-agent-2')).getByText('Wake it').closest('li')).toHaveTextContent('Off'));
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('opens the Connections card in the main window from a canvas popout (#3213)', async () => {
    useAgentStore.setState({ agents: {
      'agent-1': { id: 'agent-1', name: 'A', projectId: 'p1', kind: 'durable', status: 'running', color: 'teal' },
    } });
    window.clubhouse.window.isPopout = vi.fn(() => true);
    window.clubhouse.window.focusMain = vi.fn(async () => {});
    const onClose = vi.fn();
    const { getByTestId, getByRole } = render(<WireConfigPopover binding={agentBinding} x={100} y={200} onClose={onClose} />);
    fireEvent.click(getByTestId('wire-permissions-button'));
    fireEvent.click(getByRole('button', { name: 'Edit connections' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(window.clubhouse.window.focusMain).toHaveBeenCalledWith('agent-1', 'connections');
    expect(useAgentDetailsStore.getState().focus).toBeNull();
  });

  it('reports failed connection reads instead of presenting default switches, and can retry (#3213)', async () => {
    window.clubhouse.mcpBinding.getConnectionGrants = vi.fn().mockRejectedValueOnce(new Error('unreadable')).mockResolvedValueOnce([]);
    const { getByTestId, findByRole, getByRole, queryByTestId } = render(<WireConfigPopover binding={agentBinding} x={100} y={200} onClose={vi.fn()} />);
    fireEvent.click(getByTestId('wire-permissions-button'));
    expect(await findByRole('alert')).toHaveTextContent("Couldn't read the connection permissions.");
    expect(queryByTestId('wire-connection-direction-agent-1-agent-2')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(getByTestId('wire-connection-direction-agent-1-agent-2')).toBeInTheDocument());
  });

  it('keeps the popout dialog open and reports a failed main-window navigation (#3213)', async () => {
    useAgentStore.setState({ agents: {
      'agent-1': { id: 'agent-1', name: 'A', projectId: 'p1', kind: 'durable', status: 'running', color: 'teal' },
    } });
    window.clubhouse.window.isPopout = vi.fn(() => true);
    window.clubhouse.window.focusMain = vi.fn(async () => { throw new Error('The main window is not open.'); });
    const onClose = vi.fn();
    const { getByTestId, getByRole, findByRole } = render(<WireConfigPopover binding={agentBinding} x={100} y={200} onClose={onClose} />);
    fireEvent.click(getByTestId('wire-permissions-button'));
    fireEvent.click(getByRole('button', { name: 'Edit connections' }));
    expect(await findByRole('alert')).toHaveTextContent("Couldn't open this agent's Connections card.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(['helper', 'dispatcher'] as const)('matches the Connections card by omitting Wake it on a %s link (#3213)', async (kind) => {
    if (kind === 'dispatcher') useDispatcherStore.setState({ state: { ...DISPATCHER_OFF, agentId: agentBinding.targetId } });
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: [{ agentId: agentBinding.agentId, targetId: agentBinding.targetId, bound: true, sources: [{ kind: kind === 'helper' ? 'helper' : 'dispatcher_auto', sourceId: kind }] }],
      unreadable: [],
    }));
    const { getByTestId, findByText, queryByText } = render(<WireConfigPopover binding={agentBinding} x={100} y={200} onClose={vi.fn()} />);
    fireEvent.click(getByTestId('wire-permissions-button'));
    await waitFor(() => expect(getByTestId('wire-connection-direction-agent-1-agent-2')).toBeInTheDocument());
    expect(await findByText(/This connection has no Wake it switch/)).toBeInTheDocument();
    expect(queryByText('Wake it')).toBeNull();
  });

  it('keeps group-project permissions wire-scoped and preserves existing disabled tool data (#3213)', async () => {
    const group: McpBindingEntry = { agentId: 'agent-1', targetId: 'group', targetKind: 'group-project', label: 'Group', disabledTools: ['broadcast', 'future_tool'] };
    const setDisabledTools = vi.fn(async () => {});
    useMcpBindingStore.setState({ bindings: [group], setDisabledTools });
    const { getByTestId, getByRole, queryByTestId } = render(<WireConfigPopover binding={group} x={100} y={200} onClose={vi.fn()} />);
    fireEvent.click(getByTestId('wire-permissions-button'));
    expect(queryByTestId('agent-connection-summary')).toBeNull();
    expect(window.clubhouse.mcpBinding.getConnectionGrants).not.toHaveBeenCalled();
    fireEvent.click(getByRole('switch', { name: 'Post Bulletin' }));
    fireEvent.click(getByTestId('wire-permissions-save'));
    await waitFor(() => expect(setDisabledTools).toHaveBeenCalledWith('agent-1', 'group', ['broadcast', 'future_tool', 'post_bulletin']));
  });

  it('turning two-way on gives the new reverse direction the new-wire default (#2969)', async () => {
    const bindMock = vi.fn().mockResolvedValue(undefined);
    const setDisabledTools = vi.fn().mockResolvedValue(undefined);
    const onAddWireDefinition = vi.fn();
    useMcpBindingStore.setState({ bindings: [agentBinding], bind: bindMock, setDisabledTools } as any);
    const { getByRole } = render(
      <WireConfigPopover binding={agentBinding} x={100} y={200} onClose={vi.fn()} onAddWireDefinition={onAddWireDefinition} />,
    );
    fireEvent.click(getByRole('switch', { name: 'Both directions' }));
    await waitFor(() => expect(setDisabledTools).toHaveBeenCalledWith('agent-2', 'agent-1', ['clear_agent', 'compact_agent'], { start: true }));
    expect(onAddWireDefinition).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-2', targetId: 'agent-1', disabledTools: ['clear_agent', 'compact_agent'] }));
  });

  it('shows Set Instructions button', () => {
    const { getByTestId } = render(
      <WireConfigPopover binding={browserBinding} x={100} y={200} onClose={vi.fn()} />,
    );
    expect(getByTestId('wire-instructions-button')).toBeTruthy();
    expect(getByTestId('wire-instructions-button').textContent).toContain('Set instructions');
  });

  it('does not expose a wire-level wake action for sleeping agent targets', () => {
    useAgentStore.setState({
      agents: {
        'agent-2': { id: 'agent-2', name: 'Agent 2', kind: 'durable', status: 'sleeping', projectId: 'project-1' } as any,
      },
    });

    const { queryByTestId, queryByText } = render(
      <WireConfigPopover binding={agentBinding} x={100} y={200} onClose={vi.fn()} />,
    );

    expect(queryByTestId('wire-wake-agent')).toBeNull();
    expect(queryByText('Wake Agent')).toBeNull();
  });

  it('shows Edit Instructions when instructions are set', () => {
    const bindingWithInstructions: McpBindingEntry = {
      ...browserBinding,
      instructions: { '*': 'Do not transmit raw telemetry' },
    };
    useMcpBindingStore.setState({ bindings: [bindingWithInstructions] });
    const { getByTestId } = render(
      <WireConfigPopover binding={bindingWithInstructions} x={100} y={200} onClose={vi.fn()} />,
    );
    expect(getByTestId('wire-instructions-button').textContent).toContain('Edit instructions');
  });

  it('opens instructions dialog when Set Instructions is clicked', () => {
    const { getByTestId, queryByTestId } = render(
      <WireConfigPopover binding={browserBinding} x={100} y={200} onClose={vi.fn()} />,
    );
    expect(queryByTestId('wire-instructions-dialog')).toBeNull();
    fireEvent.click(getByTestId('wire-instructions-button'));
    expect(getByTestId('wire-instructions-dialog')).toBeTruthy();
  });

  it('dismisses immediately on outside click after closing the instructions dialog', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { getByTestId, queryByTestId } = render(
      <WireConfigPopover binding={browserBinding} x={100} y={200} onClose={onClose} />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    fireEvent.click(getByTestId('wire-instructions-button'));
    fireEvent.click(getByTestId('wire-instructions-cancel'));

    expect(queryByTestId('wire-instructions-dialog')).toBeNull();

    fireEvent.mouseDown(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes the popover on Escape when the instructions dialog is not open', () => {
    const onClose = vi.fn();
    render(<WireConfigPopover binding={browserBinding} x={100} y={200} onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes only the instructions dialog on Escape when editing instructions', () => {
    const onClose = vi.fn();
    const { getByTestId, queryByTestId } = render(
      <WireConfigPopover binding={browserBinding} x={100} y={200} onClose={onClose} />,
    );

    fireEvent.click(getByTestId('wire-instructions-button'));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(queryByTestId('wire-instructions-dialog')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('sets instructions on both bindings for bidirectional agent-to-agent wires', async () => {
    const setInstructionsMock = vi.fn().mockResolvedValue(undefined);
    const reverseBinding: McpBindingEntry = {
      agentId: 'agent-2',
      targetId: 'agent-1',
      targetKind: 'agent',
      label: 'Agent 1',
    };
    useMcpBindingStore.setState({
      bindings: [agentBinding, reverseBinding],
      setInstructions: setInstructionsMock,
    } as any);

    const { getByTestId } = render(
      <WireConfigPopover binding={agentBinding} x={100} y={200} onClose={vi.fn()} />,
    );

    // Wait for useEffect to detect reverse binding and set bidirectional=true
    const toggleContainer = getByTestId('wire-bidirectional-toggle');
    await waitFor(() => {
      const toggleButton = toggleContainer.querySelector('button');
      expect(toggleButton?.className).toContain('bg-ctp-accent');
    });

    // Open instructions dialog
    fireEvent.click(getByTestId('wire-instructions-button'));
    const textarea = getByTestId('wire-instructions-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Be concise' } });
    fireEvent.click(getByTestId('wire-instructions-save'));

    // handleSaveInstructions is async — wait for both calls to complete
    await waitFor(() => {
      // Should set on forward binding (agent-1 → agent-2)
      expect(setInstructionsMock).toHaveBeenCalledWith('agent-1', 'agent-2', { '*': 'Be concise' });
      // Should also set on reverse binding (agent-2 → agent-1)
      expect(setInstructionsMock).toHaveBeenCalledWith('agent-2', 'agent-1', { '*': 'Be concise' });
      expect(setInstructionsMock).toHaveBeenCalledTimes(2);
    });
  });

  it('calls onRemoveWireDefinition before unbind resolves in handleDisconnect', async () => {
    let resolveUnbind!: () => void;
    const unbindMock = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveUnbind = resolve; }),
    );
    const onRemoveWireDefinition = vi.fn();
    useMcpBindingStore.setState({ bindings: [browserBinding], unbind: unbindMock } as any);

    const { getByTestId } = render(
      <WireConfigPopover
        binding={browserBinding}
        x={100}
        y={200}
        onClose={vi.fn()}
        onRemoveWireDefinition={onRemoveWireDefinition}
      />,
    );

    fireEvent.click(getByTestId('wire-disconnect'));

    // onRemoveWireDefinition must be called synchronously before unbind resolves
    expect(onRemoveWireDefinition).toHaveBeenCalledTimes(1);
    expect(onRemoveWireDefinition).toHaveBeenCalledWith('agent-1', 'browser-1');
    expect(unbindMock).toHaveBeenCalledWith('agent-1', 'browser-1');

    resolveUnbind();
  });

  it('calls onRemoveWireDefinition before unbind resolves in handleBidirectionalToggle (removing reverse)', async () => {
    let resolveUnbind!: () => void;
    const unbindMock = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveUnbind = resolve; }),
    );
    const onRemoveWireDefinition = vi.fn();
    const reverseBinding: McpBindingEntry = {
      agentId: 'agent-2',
      targetId: 'agent-1',
      targetKind: 'agent',
      label: 'Agent 1',
    };
    useMcpBindingStore.setState({
      bindings: [agentBinding, reverseBinding],
      unbind: unbindMock,
    } as any);

    const { getByTestId } = render(
      <WireConfigPopover
        binding={agentBinding}
        x={100}
        y={200}
        onClose={vi.fn()}
        onRemoveWireDefinition={onRemoveWireDefinition}
      />,
    );

    // Wait for useEffect to detect reverse binding and set bidirectional=true
    const toggleContainer = getByTestId('wire-bidirectional-toggle');
    await waitFor(() => {
      const toggleButton = toggleContainer.querySelector('button');
      expect(toggleButton?.className).toContain('bg-ctp-accent');
    });

    // Toggle off — triggers handleBidirectionalToggle(false)
    fireEvent.click(toggleContainer.querySelector('button')!);

    // onRemoveWireDefinition must be called synchronously before unbind resolves
    expect(onRemoveWireDefinition).toHaveBeenCalledTimes(1);
    expect(onRemoveWireDefinition).toHaveBeenCalledWith('agent-2', 'agent-1');
    expect(unbindMock).toHaveBeenCalledWith('agent-2', 'agent-1');

    resolveUnbind();
  });

  // Wave 10 #6: opening the manage-tools dialog suppresses the popover's
  // outside-click handler.  After Save the dialog unmounts and the popover
  // would re-enable that handler — but the click that triggered Save is
  // already gone, so the popover would linger.  Closing explicitly on Save
  // gives users the same dismiss-on-commit feel as the rest of the canvas.
  it('closes the popover after saving tool permissions', async () => {
    const setDisabledToolsMock = vi.fn().mockResolvedValue(undefined);
    useMcpBindingStore.setState({
      bindings: [browserBinding],
      setDisabledTools: setDisabledToolsMock,
    } as any);
    const onClose = vi.fn();
    const { getByTestId } = render(
      <WireConfigPopover binding={browserBinding} x={100} y={200} onClose={onClose} />,
    );

    fireEvent.click(getByTestId('wire-permissions-button'));
    fireEvent.click(getByTestId('wire-permissions-save'));

    await waitFor(() => {
      expect(setDisabledToolsMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('does not set instructions on reverse binding for unidirectional wires', async () => {
    const setInstructionsMock = vi.fn().mockResolvedValue(undefined);
    // Only forward binding, no reverse
    useMcpBindingStore.setState({
      bindings: [agentBinding],
      setInstructions: setInstructionsMock,
    } as any);

    const { getByTestId } = render(
      <WireConfigPopover binding={agentBinding} x={100} y={200} onClose={vi.fn()} />,
    );

    fireEvent.click(getByTestId('wire-instructions-button'));
    const textarea = getByTestId('wire-instructions-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Be concise' } });
    fireEvent.click(getByTestId('wire-instructions-save'));

    // handleSaveInstructions is async — wait for it to complete
    await waitFor(() => {
      expect(setInstructionsMock).toHaveBeenCalledWith('agent-1', 'agent-2', { '*': 'Be concise' });
      expect(setInstructionsMock).toHaveBeenCalledTimes(1);
    });
  });
});
