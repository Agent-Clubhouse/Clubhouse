import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { WireOverlay } from './WireOverlay';
import type { CanvasView, AgentCanvasView, PluginCanvasView } from './canvas-types';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';

function makeAgentView(id: string, agentId: string, x = 0, y = 0): AgentCanvasView {
  return {
    id,
    type: 'agent',
    agentId,
    position: { x, y },
    size: { width: 200, height: 200 },
    title: `Agent ${id}`,
    displayName: `Agent ${id}`,
    zIndex: 1,
    metadata: {},
  };
}

function makePluginView(id: string, x = 300, y = 0): PluginCanvasView {
  return {
    id,
    type: 'plugin',
    pluginWidgetType: 'plugin:browser:webview',
    pluginId: 'browser',
    position: { x, y },
    size: { width: 200, height: 200 },
    title: `Browser ${id}`,
    displayName: `Browser ${id}`,
    zIndex: 1,
    metadata: {},
  };
}

describe('WireOverlay', () => {
  it('renders nothing when bindings array is empty', () => {
    const { container } = render(
      <WireOverlay views={[makeAgentView('a1', 'agent-1')]} bindings={[]} />,
    );
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders a wire path for a valid binding', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makePluginView('b1', 400, 0),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'b1', targetKind: 'browser', label: 'Browser' },
    ];

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} />,
    );

    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    const pathEl = container.querySelector('[data-testid="wire-path-agent-1--b1"]');
    expect(pathEl).toBeTruthy();
    expect(pathEl?.getAttribute('d')).toContain('M');
    expect(pathEl?.getAttribute('d')).toContain('C');
  });

  it('skips bindings with missing source view', () => {
    const views: CanvasView[] = [makePluginView('b1')];
    const bindings: McpBindingEntry[] = [
      { agentId: 'nonexistent', targetId: 'b1', targetKind: 'browser', label: 'Browser' },
    ];

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} />,
    );

    // No wires rendered → no SVG
    expect(container.querySelector('svg')).toBeNull();
  });

  it('skips bindings with missing target view', () => {
    const views: CanvasView[] = [makeAgentView('a1', 'agent-1')];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'nonexistent', targetKind: 'browser', label: 'Browser' },
    ];

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} />,
    );

    expect(container.querySelector('svg')).toBeNull();
  });

  it('calls onWireClick when hitbox is clicked', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makePluginView('b1', 400, 0),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'b1', targetKind: 'browser', label: 'Browser' },
    ];
    const onClick = vi.fn();

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} onWireClick={onClick} />,
    );

    const hitbox = container.querySelector('[data-testid="wire-hitbox-agent-1--b1"]');
    expect(hitbox).toBeTruthy();
    hitbox?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClick).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', targetId: 'b1' }),
      expect.anything(),
    );
  });
});
