import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
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
});
