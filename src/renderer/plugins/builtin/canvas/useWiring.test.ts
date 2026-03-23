import { describe, it, expect } from 'vitest';
import { isValidWireTarget, hitTestViews } from './useWiring';
import type { AgentCanvasView, PluginCanvasView, AnchorCanvasView, ZoneCanvasView } from './canvas-types';

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
