import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { LinkDropdown } from './LinkDropdown';
import type { CanvasView, AgentCanvasView, PluginCanvasView } from './canvas-types';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';

function makeAgentView(id: string, agentId: string | null): AgentCanvasView {
  return {
    id,
    type: 'agent',
    agentId,
    position: { x: 0, y: 0 },
    size: { width: 200, height: 200 },
    title: `Agent ${id}`,
    displayName: `Agent ${id}`,
    zIndex: 1,
    metadata: {},
  };
}

function makeBrowserView(id: string): PluginCanvasView {
  return {
    id,
    type: 'plugin',
    pluginWidgetType: 'plugin:browser:webview',
    pluginId: 'browser',
    position: { x: 300, y: 0 },
    size: { width: 200, height: 200 },
    title: `Browser ${id}`,
    displayName: `Browser ${id}`,
    zIndex: 1,
    metadata: {},
  };
}

describe('LinkDropdown', () => {
  beforeEach(() => {
    useMcpBindingStore.setState({ bindings: [] });
    vi.clearAllMocks();
  });

  it('lists valid targets (agents and browser widgets)', () => {
    const agentView = makeAgentView('a1', 'agent-1');
    const views: CanvasView[] = [
      agentView,
      makeAgentView('a2', 'agent-2'),
      makeBrowserView('b1'),
    ];

    const { getByTestId } = render(
      <LinkDropdown agentView={agentView} views={views} onClose={vi.fn()} />,
    );

    expect(getByTestId('link-target-a2')).toBeTruthy();
    expect(getByTestId('link-target-b1')).toBeTruthy();
  });

  it('excludes self from target list', () => {
    const agentView = makeAgentView('a1', 'agent-1');

    const { queryByTestId } = render(
      <LinkDropdown agentView={agentView} views={[agentView]} onClose={vi.fn()} />,
    );

    expect(queryByTestId('link-target-a1')).toBeNull();
  });

  it('excludes agents without agentId', () => {
    const agentView = makeAgentView('a1', 'agent-1');
    const emptyAgent = makeAgentView('a3', null);

    const { queryByTestId } = render(
      <LinkDropdown agentView={agentView} views={[agentView, emptyAgent]} onClose={vi.fn()} />,
    );

    expect(queryByTestId('link-target-a3')).toBeNull();
  });

  it('shows "No connectable widgets" when no targets', () => {
    const agentView = makeAgentView('a1', 'agent-1');

    const { container } = render(
      <LinkDropdown agentView={agentView} views={[agentView]} onClose={vi.fn()} />,
    );

    expect(container.textContent).toContain('No connectable widgets');
  });

  it('shows connected state for bound targets', () => {
    const agentView = makeAgentView('a1', 'agent-1');
    const browserView = makeBrowserView('b1');
    useMcpBindingStore.setState({
      bindings: [{ agentId: 'agent-1', targetId: 'b1', targetKind: 'browser', label: 'Browser' }],
    });

    const { getByTestId } = render(
      <LinkDropdown agentView={agentView} views={[agentView, browserView]} onClose={vi.fn()} />,
    );

    const target = getByTestId('link-target-b1');
    expect(target.className).toContain('text-ctp-blue');
  });

  it('calls bind when clicking unbound target', async () => {
    const agentView = makeAgentView('a1', 'agent-1');
    const browserView = makeBrowserView('b1');

    const bindMock = vi.fn().mockResolvedValue(undefined);
    useMcpBindingStore.setState({ bindings: [], bind: bindMock } as any);

    const { getByTestId } = render(
      <LinkDropdown agentView={agentView} views={[agentView, browserView]} onClose={vi.fn()} />,
    );

    fireEvent.click(getByTestId('link-target-b1'));
    expect(bindMock).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      targetId: 'b1',
      targetKind: 'browser',
    }));
  });
});
