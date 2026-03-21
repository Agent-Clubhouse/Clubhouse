import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { WireConfigPopover } from './WireConfigPopover';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';

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
    vi.clearAllMocks();
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

  it('shows Set Instructions button', () => {
    const { getByTestId } = render(
      <WireConfigPopover binding={browserBinding} x={100} y={200} onClose={vi.fn()} />,
    );
    expect(getByTestId('wire-instructions-button')).toBeTruthy();
    expect(getByTestId('wire-instructions-button').textContent).toContain('Set Instructions');
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
    expect(getByTestId('wire-instructions-button').textContent).toContain('Edit Instructions');
  });

  it('opens instructions dialog when Set Instructions is clicked', () => {
    const { getByTestId, queryByTestId } = render(
      <WireConfigPopover binding={browserBinding} x={100} y={200} onClose={vi.fn()} />,
    );
    expect(queryByTestId('wire-instructions-dialog')).toBeNull();
    fireEvent.click(getByTestId('wire-instructions-button'));
    expect(getByTestId('wire-instructions-dialog')).toBeTruthy();
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
