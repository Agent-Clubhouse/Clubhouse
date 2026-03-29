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

function makeGroupProjectView(id: string, groupProjectId: string, x = 300, y = 0): PluginCanvasView {
  return {
    id,
    type: 'plugin',
    pluginWidgetType: 'plugin:group-project:group-project',
    pluginId: 'group-project',
    position: { x, y },
    size: { width: 200, height: 200 },
    title: `Group Project ${id}`,
    displayName: `Group Project ${id}`,
    zIndex: 1,
    metadata: { groupProjectId },
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

  it('renders arrowhead markers in defs', () => {
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

    expect(container.querySelector('#wire-arrow-fwd')).toBeTruthy();
    expect(container.querySelector('#wire-arrow-fwd-bidir')).toBeTruthy();
    expect(container.querySelector('#wire-arrow-rev-bidir')).toBeTruthy();
  });

  it('applies forward arrowhead to unidirectional wire', () => {
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

    const pathEl = container.querySelector('[data-testid="wire-path-agent-1--b1"]');
    expect(pathEl?.getAttribute('marker-end')).toBe('url(#wire-arrow-fwd)');
    expect(pathEl?.getAttribute('marker-start')).toBeNull();
  });

  it('applies both arrowheads for bidirectional agent-to-agent wire', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makeAgentView('a2', 'agent-2', 400, 0),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' },
      { agentId: 'agent-2', targetId: 'agent-1', targetKind: 'agent', label: 'Agent 1' },
    ];

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} />,
    );

    // Bidirectional pair should only render one wire path
    const paths = container.querySelectorAll('[data-testid^="wire-path-"]');
    expect(paths.length).toBe(1);

    const pathEl = paths[0];
    expect(pathEl?.getAttribute('marker-end')).toBe('url(#wire-arrow-fwd-bidir)');
    expect(pathEl?.getAttribute('marker-start')).toBe('url(#wire-arrow-rev-bidir)');
  });

  it('uses viewPositions overrides for wire path computation', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makePluginView('b1', 400, 0),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'b1', targetKind: 'browser', label: 'Browser' },
    ];

    // Render without overrides
    const { container: c1 } = render(
      <WireOverlay views={views} bindings={bindings} />,
    );
    const path1 = c1.querySelector('[data-testid="wire-path-agent-1--b1"]')?.getAttribute('d');

    // Render with a moved agent view
    const viewPositions = new Map([['a1', { x: 100, y: 100 }]]);
    const { container: c2 } = render(
      <WireOverlay views={views} bindings={bindings} viewPositions={viewPositions} />,
    );
    const path2 = c2.querySelector('[data-testid="wire-path-agent-1--b1"]')?.getAttribute('d');

    // Paths should differ because agent view has a different position
    expect(path1).not.toBe(path2);
  });

  it('renders flow dots for each wire', () => {
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

    // Should have forward flow dots (ambient mode = 2 dots)
    const fwdDots = container.querySelectorAll('[data-testid^="wire-dot-fwd-"]');
    expect(fwdDots.length).toBe(2);
  });

  it('renders wire path def in SVG defs', () => {
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

    expect(container.querySelector('#wire-path-agent-1--b1')).toBeTruthy();
  });

  it('renders a wire to a group-project plugin view', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makeGroupProjectView('gp-view-1', 'gp_abc123', 400, 0),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'gp_abc123', targetKind: 'group-project', label: 'My Project' },
    ];

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} />,
    );

    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    const pathEl = container.querySelector('[data-testid="wire-path-agent-1--gp_abc123"]');
    expect(pathEl).toBeTruthy();
    expect(pathEl?.getAttribute('d')).toContain('M');
    expect(pathEl?.getAttribute('d')).toContain('C');
  });

  it('renders flow dots for group-project wire', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makeGroupProjectView('gp-view-1', 'gp_abc123', 400, 0),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'gp_abc123', targetKind: 'group-project', label: 'My Project' },
    ];

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} />,
    );

    const fwdDots = container.querySelectorAll('[data-testid^="wire-dot-fwd-"]');
    expect(fwdDots.length).toBe(2);
  });

  it('skips group-project binding when no matching view exists', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makeGroupProjectView('gp-view-1', 'gp_other', 400, 0),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'gp_nonexistent', targetKind: 'group-project', label: 'Missing' },
    ];

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} />,
    );

    expect(container.querySelector('svg')).toBeNull();
  });

  it('sets data-bidir attribute on bidirectional wire group', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makeAgentView('a2', 'agent-2', 400, 0),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' },
      { agentId: 'agent-2', targetId: 'agent-1', targetKind: 'agent', label: 'Agent 1' },
    ];

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} />,
    );

    const group = container.querySelector('[data-testid^="wire-group-"]');
    expect(group?.getAttribute('data-bidir')).toBe('true');
  });

  it('dims wire when source agent is sleeping', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makePluginView('b1', 400, 0),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'b1', targetKind: 'browser', label: 'Browser' },
    ];

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} sleepingAgentIds={new Set(['agent-1'])} />,
    );

    const group = container.querySelector('[data-testid^="wire-group-"]');
    expect(group?.getAttribute('data-dimmed')).toBe('true');
    const pathEl = container.querySelector('[data-testid="wire-path-agent-1--b1"]') as HTMLElement;
    expect(pathEl?.style.opacity).toBe('0.35');
  });

  it('dims wire when target agent is sleeping', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makeAgentView('a2', 'agent-2', 400, 0),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' },
    ];

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} sleepingAgentIds={new Set(['agent-2'])} />,
    );

    const group = container.querySelector('[data-testid^="wire-group-"]');
    expect(group?.getAttribute('data-dimmed')).toBe('true');
  });

  it('does not dim wire when neither endpoint is sleeping', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makePluginView('b1', 400, 0),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'b1', targetKind: 'browser', label: 'Browser' },
    ];

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} sleepingAgentIds={new Set(['agent-other'])} />,
    );

    const group = container.querySelector('[data-testid^="wire-group-"]');
    expect(group?.getAttribute('data-dimmed')).toBeNull();
    const pathEl = container.querySelector('[data-testid="wire-path-agent-1--b1"]') as HTMLElement;
    expect(pathEl?.style.opacity).toBe('1');
  });

  it('renders wire (dimmed) when source agent is sleeping — wire definitions survive sleep', () => {
    // This test verifies the core fix: wires remain visible when rendered
    // from wireDefinitions even though MCP bindings may have been removed.
    const views: CanvasView[] = [
      makeAgentView('a1', 'sleeping-agent', 0, 0),
      makeAgentView('a2', 'awake-agent', 400, 0),
    ];
    // These bindings represent wireDefinitions — they persist even when
    // the MCP binding system has removed the live binding for sleeping-agent.
    const bindings: McpBindingEntry[] = [
      { agentId: 'sleeping-agent', targetId: 'awake-agent', targetKind: 'agent', label: 'Awake Agent' },
    ];

    const { container } = render(
      <WireOverlay
        views={views}
        bindings={bindings}
        sleepingAgentIds={new Set(['sleeping-agent'])}
      />,
    );

    // Wire MUST be rendered (dimmed) — not absent
    const pathEl = container.querySelector('[data-testid="wire-path-sleeping-agent--awake-agent"]');
    expect(pathEl).toBeTruthy();
    const group = container.querySelector('[data-testid^="wire-group-"]');
    expect(group?.getAttribute('data-dimmed')).toBe('true');
  });

  it('renders wire to sleeping target — supports connecting to sleeping agents', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'awake-agent', 0, 0),
      makeAgentView('a2', 'sleeping-target', 400, 0),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'awake-agent', targetId: 'sleeping-target', targetKind: 'agent', label: 'Sleeping Target' },
    ];

    const { container } = render(
      <WireOverlay
        views={views}
        bindings={bindings}
        sleepingAgentIds={new Set(['sleeping-target'])}
      />,
    );

    // Wire should be rendered and dimmed
    const pathEl = container.querySelector('[data-testid="wire-path-awake-agent--sleeping-target"]');
    expect(pathEl).toBeTruthy();
    expect((pathEl as HTMLElement)?.style.opacity).toBe('0.35');
  });

  it('does not set explicit zIndex on SVG container so DOM order determines stacking', () => {
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
    // Should NOT have zIndex: 0 (or any explicit zIndex) — natural DOM stacking
    expect(svg?.style.zIndex).toBe('');
  });

  it('forceBidirectional renders unidirectional agent wire as bidirectional', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makeAgentView('a2', 'agent-2', 400, 0),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' },
    ];

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} forceBidirectional />,
    );

    const pathEl = container.querySelector('[data-testid="wire-path-agent-1--agent-2"]');
    expect(pathEl).toBeTruthy();
    expect(pathEl?.getAttribute('marker-end')).toBe('url(#wire-arrow-fwd-bidir)');
    expect(pathEl?.getAttribute('marker-start')).toBe('url(#wire-arrow-rev-bidir)');

    const group = container.querySelector('[data-testid^="wire-group-"]');
    expect(group?.getAttribute('data-bidir')).toBe('true');
  });

  it('forceBidirectional does not affect non-agent wires', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makePluginView('b1', 400, 0),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'b1', targetKind: 'browser', label: 'Browser' },
    ];

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} forceBidirectional />,
    );

    const pathEl = container.querySelector('[data-testid="wire-path-agent-1--b1"]');
    expect(pathEl?.getAttribute('marker-start')).toBeNull();
  });

  it('forceBidirectional deduplicates already-bidirectional agent wires', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makeAgentView('a2', 'agent-2', 400, 0),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' },
      { agentId: 'agent-2', targetId: 'agent-1', targetKind: 'agent', label: 'Agent 1' },
    ];

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} forceBidirectional />,
    );

    // Should still only render one wire path even with both directions and forceBidirectional
    const paths = container.querySelectorAll('[data-testid^="wire-path-"]');
    expect(paths.length).toBe(1);
  });

  it('turning forceBidirectional off reverts wires to unidirectional', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makeAgentView('a2', 'agent-2', 400, 0),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' },
    ];

    // First render with forceBidirectional on
    const { container, rerender } = render(
      <WireOverlay views={views} bindings={bindings} forceBidirectional />,
    );
    let pathEl = container.querySelector('[data-testid="wire-path-agent-1--agent-2"]');
    expect(pathEl?.getAttribute('marker-start')).toBe('url(#wire-arrow-rev-bidir)');

    // Re-render with forceBidirectional off
    rerender(<WireOverlay views={views} bindings={bindings} forceBidirectional={false} />);
    pathEl = container.querySelector('[data-testid="wire-path-agent-1--agent-2"]');
    expect(pathEl?.getAttribute('marker-start')).toBeNull();
    // Should revert to unidirectional accent-colored marker
    expect(pathEl?.getAttribute('marker-end')).toBe('url(#wire-arrow-fwd)');
  });

  it('forceBidirectional works alongside existing bidir wires on the same canvas', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makeAgentView('a2', 'agent-2', 400, 0),
      makeAgentView('a3', 'agent-3', 0, 400),
      makePluginView('b1', 400, 400),
    ];
    const bindings: McpBindingEntry[] = [
      // Unidirectional agent wire — should become bidir visually
      { agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' },
      // Already bidirectional agent wire pair
      { agentId: 'agent-1', targetId: 'agent-3', targetKind: 'agent', label: 'Agent 3' },
      { agentId: 'agent-3', targetId: 'agent-1', targetKind: 'agent', label: 'Agent 1' },
      // Non-agent wire — should remain unidirectional
      { agentId: 'agent-3', targetId: 'b1', targetKind: 'browser', label: 'Browser' },
    ];

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} forceBidirectional />,
    );

    // All three wires should render
    const paths = container.querySelectorAll('[data-testid^="wire-path-"]');
    expect(paths.length).toBe(3);

    // Agent-1→Agent-2 forced bidir (green markers)
    const wire12 = container.querySelector('[data-testid="wire-path-agent-1--agent-2"]');
    expect(wire12?.getAttribute('marker-start')).toBe('url(#wire-arrow-rev-bidir)');
    expect(wire12?.getAttribute('marker-end')).toBe('url(#wire-arrow-fwd-bidir)');

    // Agent-1↔Agent-3 already bidir (deduped to one wire, green markers)
    const wire13 = container.querySelector('[data-testid="wire-path-agent-1--agent-3"]')
      || container.querySelector('[data-testid="wire-path-agent-3--agent-1"]');
    expect(wire13?.getAttribute('marker-start')).toBe('url(#wire-arrow-rev-bidir)');

    // Agent-3→Browser stays unidirectional
    const wireBrowser = container.querySelector('[data-testid="wire-path-agent-3--b1"]');
    expect(wireBrowser?.getAttribute('marker-start')).toBeNull();
  });

  it('uses dashed stroke for unidirectional wires and solid for bidirectional', () => {
    const views: CanvasView[] = [
      makeAgentView('a1', 'agent-1', 0, 0),
      makeAgentView('a2', 'agent-2', 400, 0),
      makePluginView('b1', 400, 400),
    ];
    const bindings: McpBindingEntry[] = [
      { agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' },
      { agentId: 'agent-2', targetId: 'agent-1', targetKind: 'agent', label: 'Agent 1' },
      { agentId: 'agent-1', targetId: 'b1', targetKind: 'browser', label: 'Browser' },
    ];

    const { container } = render(
      <WireOverlay views={views} bindings={bindings} />,
    );

    // Bidirectional wire should be solid (no dasharray)
    const bidirPath = container.querySelector('[data-testid^="wire-path-agent-1--agent-2"], [data-testid^="wire-path-agent-2--agent-1"]');
    expect(bidirPath?.getAttribute('stroke-dasharray')).toBeNull();

    // Unidirectional wire should be dashed
    const uniPath = container.querySelector('[data-testid="wire-path-agent-1--b1"]');
    expect(uniPath?.getAttribute('stroke-dasharray')).toBe('8 4');
  });

  it('does not dim wire when sleepingAgentIds is not provided', () => {
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

    const group = container.querySelector('[data-testid^="wire-group-"]');
    expect(group?.getAttribute('data-dimmed')).toBeNull();
  });
});
