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

  it('renders toggle pill with inactive styling when not bidirectional', () => {
    useMcpBindingStore.setState({ bindings: [agentBinding] });
    const { getByTestId } = render(
      <WireConfigPopover binding={agentBinding} x={100} y={200} onClose={vi.fn()} />,
    );
    const pill = getByTestId('wire-bidirectional-pill');
    expect(pill).toBeTruthy();
    expect(pill.className).toContain('bg-ctp-surface2');
    expect(pill.className).not.toContain('bg-ctp-blue');
  });

  it('renders toggle pill with active styling when bidirectional', () => {
    const reverseBinding: McpBindingEntry = {
      agentId: 'agent-2',
      targetId: 'agent-1',
      targetKind: 'agent',
      label: 'Agent 1',
    };
    useMcpBindingStore.setState({ bindings: [agentBinding, reverseBinding] });
    const { getByTestId } = render(
      <WireConfigPopover binding={agentBinding} x={100} y={200} onClose={vi.fn()} />,
    );
    const pill = getByTestId('wire-bidirectional-pill');
    expect(pill).toBeTruthy();
    expect(pill.className).toContain('bg-ctp-blue');
  });

  it('shows ring highlight on toggle button when bidirectional', () => {
    const reverseBinding: McpBindingEntry = {
      agentId: 'agent-2',
      targetId: 'agent-1',
      targetKind: 'agent',
      label: 'Agent 1',
    };
    useMcpBindingStore.setState({ bindings: [agentBinding, reverseBinding] });
    const { getByTestId } = render(
      <WireConfigPopover binding={agentBinding} x={100} y={200} onClose={vi.fn()} />,
    );
    const toggle = getByTestId('wire-bidirectional-toggle');
    expect(toggle.className).toContain('ring-1');
    expect(toggle.className).toContain('ring-ctp-blue/40');
  });
});
