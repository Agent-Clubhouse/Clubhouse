import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { isValidWireTarget, hitTestViews, useWiring } from './useWiring';
import type { AgentCanvasView, PluginCanvasView, AnchorCanvasView, ZoneCanvasView } from './canvas-types';

const mockBind = vi.hoisted(() => vi.fn());

vi.mock('../../../stores/mcpBindingStore', () => ({
  useMcpBindingStore: (selector: (s: any) => any) => selector({ bind: mockBind }),
}));

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

function makeAnchorView(id: string): AnchorCanvasView {
  return {
    id,
    type: 'anchor',
    label: 'Test',
    position: { x: 0, y: 0 },
    size: { width: 200, height: 50 },
    title: `Anchor ${id}`,
    displayName: `Anchor ${id}`,
    zIndex: 1,
    metadata: {},
  };
}

describe('isValidWireTarget', () => {
  const source = makeAgentView('a1', 'agent-1');

  it('rejects self', () => {
    expect(isValidWireTarget(source, source)).toBe(false);
  });

  it('accepts another agent with assigned agentId', () => {
    expect(isValidWireTarget(source, makeAgentView('a2', 'agent-2'))).toBe(true);
  });

  it('rejects agent without agentId', () => {
    expect(isValidWireTarget(source, makeAgentView('a3', null))).toBe(false);
  });

  it('accepts browser plugin widget', () => {
    expect(isValidWireTarget(source, makeBrowserView('b1'))).toBe(true);
  });

  it('rejects non-browser plugin widget', () => {
    const otherPlugin: PluginCanvasView = {
      ...makeBrowserView('p1'),
      pluginWidgetType: 'plugin:other:widget',
    };
    expect(isValidWireTarget(source, otherPlugin)).toBe(false);
  });

  it('rejects anchor views', () => {
    expect(isValidWireTarget(source, makeAnchorView('anc1'))).toBe(false);
  });

  // Zone wire targets
  describe('zone support', () => {
    function makeZoneView(id: string): ZoneCanvasView {
      return {
        id,
        type: 'zone',
        position: { x: 0, y: 0 },
        size: { width: 600, height: 400 },
        title: `Zone ${id}`,
        displayName: `Zone ${id}`,
        zIndex: 0,
        metadata: {},
        themeId: 'catppuccin-mocha',
        containedViewIds: [],
      };
    }

    it('accepts zone as target from agent source', () => {
      expect(isValidWireTarget(source, makeZoneView('z1'))).toBe(true);
    });

    it('accepts agent as target from zone source', () => {
      const zoneSource = makeZoneView('z1');
      expect(isValidWireTarget(zoneSource, makeAgentView('a2', 'agent-2'))).toBe(true);
    });

    it('accepts zone-to-zone', () => {
      const z1 = makeZoneView('z1');
      const z2 = makeZoneView('z2');
      expect(isValidWireTarget(z1, z2)).toBe(true);
    });

    it('rejects zone-to-self', () => {
      const z1 = makeZoneView('z1');
      expect(isValidWireTarget(z1, z1)).toBe(false);
    });

    it('accepts browser as target from zone source', () => {
      const zoneSource = makeZoneView('z1');
      expect(isValidWireTarget(zoneSource, makeBrowserView('b1'))).toBe(true);
    });

    it('rejects anchor from zone source', () => {
      const zoneSource = makeZoneView('z1');
      expect(isValidWireTarget(zoneSource, makeAnchorView('anc1'))).toBe(false);
    });
  });
});

describe('hitTestViews', () => {
  function makeZoneView(id: string): ZoneCanvasView {
    return {
      id,
      type: 'zone',
      position: { x: 0, y: 0 },
      size: { width: 600, height: 400 },
      title: `Zone ${id}`,
      displayName: `Zone ${id}`,
      zIndex: 0,
      metadata: {},
      themeId: 'catppuccin-mocha',
      containedViewIds: [],
    };
  }

  it('returns agent inside a zone instead of the zone', () => {
    const zone = makeZoneView('z1');
    const agent = makeAgentView('a1', 'agent-1');
    // Agent at (0,0) 200x200 inside zone at (0,0) 600x400
    const result = hitTestViews({ x: 100, y: 100 }, [zone, agent]);
    expect(result?.id).toBe('a1');
  });

  it('returns zone only when no non-zone view overlaps', () => {
    const zone = makeZoneView('z1');
    const agent: AgentCanvasView = {
      ...makeAgentView('a1', 'agent-1'),
      position: { x: 800, y: 800 }, // outside zone
    };
    const result = hitTestViews({ x: 100, y: 100 }, [zone, agent]);
    expect(result?.id).toBe('z1');
  });

  it('returns null when no view is hit', () => {
    const zone = makeZoneView('z1');
    const result = hitTestViews({ x: 1000, y: 1000 }, [zone]);
    expect(result).toBeNull();
  });

  it('prefers agent over zone even when zone has higher zIndex', () => {
    const zone: ZoneCanvasView = { ...makeZoneView('z1'), zIndex: 10 };
    const agent: AgentCanvasView = { ...makeAgentView('a1', 'agent-1'), zIndex: 1 };
    const result = hitTestViews({ x: 100, y: 100 }, [zone, agent]);
    expect(result?.id).toBe('a1');
  });
});

// ── LB-CB-008: useWiring null-agentId guard ─────────────────────────

describe('LB-CB-008: useWiring does not call bind when sourceView has no agentId', () => {
  const viewport = { panX: 0, panY: 0, zoom: 1 };

  beforeEach(() => {
    mockBind.mockClear();
  });

  it('does not call bind when source agent has null agentId', async () => {
    const sourceView: AgentCanvasView = makeAgentView('src', null); // no agentId
    const targetView: AgentCanvasView = makeAgentView('tgt', 'agent-target');
    // Position target at (300,0) so it's at x=300..500, y=0..200
    const views = [
      sourceView,
      { ...targetView, position: { x: 300, y: 0 } },
    ];

    const container = document.createElement('div');
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 1000, height: 1000, right: 1000, bottom: 1000 }),
    });
    const containerRef = { current: container };

    const { result } = renderHook(() =>
      useWiring(views, viewport, containerRef as any),
    );

    // Start a wire drag from the null-agentId source
    act(() => {
      result.current.startWireDrag(sourceView);
    });

    expect(result.current.isWireDragging).toBe(true);

    // Simulate mouseup over the target (x=350 lands in target's 300..500 range)
    act(() => {
      const mouseUpEvent = new MouseEvent('mouseup', {
        bubbles: true,
        clientX: 350,
        clientY: 100,
      });
      window.dispatchEvent(mouseUpEvent);
    });

    expect(result.current.isWireDragging).toBe(false);
    // bind must NOT have been called — sourceAgentId was null
    expect(mockBind).not.toHaveBeenCalled();
  });

  it('calls bind when source agent has a valid agentId', async () => {
    const sourceView: AgentCanvasView = makeAgentView('src', 'agent-source');
    const targetView: AgentCanvasView = { ...makeAgentView('tgt', 'agent-target'), position: { x: 300, y: 0 } };
    const views = [sourceView, targetView];

    const container = document.createElement('div');
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 1000, height: 1000, right: 1000, bottom: 1000 }),
    });
    const containerRef = { current: container };

    const { result } = renderHook(() =>
      useWiring(views, viewport, containerRef as any),
    );

    act(() => {
      result.current.startWireDrag(sourceView);
    });

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 350, clientY: 100 }));
    });

    // bind should have been called (both source and reverse for agent-to-agent)
    expect(mockBind).toHaveBeenCalled();
    const bindArgs = mockBind.mock.calls[0];
    expect(bindArgs[0]).toBe('agent-source');
  });
});
