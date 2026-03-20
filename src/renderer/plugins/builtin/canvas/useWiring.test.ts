import { describe, it, expect } from 'vitest';
import { isValidWireTarget } from './useWiring';
import type { AgentCanvasView, PluginCanvasView, AnchorCanvasView } from './canvas-types';

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
});
