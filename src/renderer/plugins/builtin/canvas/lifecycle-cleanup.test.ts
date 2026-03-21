import { describe, it, expect } from 'vitest';
import { findBindingsForView } from './main';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import type { AgentCanvasView, PluginCanvasView, CanvasView } from './canvas-types';

function makeAgentView(id: string, agentId: string): AgentCanvasView {
  return {
    id, type: 'agent', agentId,
    position: { x: 0, y: 0 }, size: { width: 300, height: 200 },
    zIndex: 0, title: 'Agent', displayName: 'Agent', metadata: {},
  };
}

function makeBrowserView(id: string): PluginCanvasView {
  return {
    id, type: 'plugin', pluginWidgetType: 'plugin:browser:webview', pluginId: 'browser',
    position: { x: 0, y: 0 }, size: { width: 300, height: 200 },
    zIndex: 0, title: 'Browser', displayName: 'Browser', metadata: {},
  };
}

function makeGroupProjectView(id: string, groupProjectId: string): PluginCanvasView {
  return {
    id, type: 'plugin', pluginWidgetType: 'plugin:group-project:group-project', pluginId: 'group-project',
    position: { x: 0, y: 0 }, size: { width: 300, height: 200 },
    zIndex: 0, title: 'GP', displayName: 'GP', metadata: { groupProjectId },
  };
}

function makeBinding(agentId: string, targetId: string, targetKind: 'agent' | 'browser' | 'group-project' = 'agent'): McpBindingEntry {
  return { agentId, targetId, targetKind, label: 'Test' };
}

describe('findBindingsForView', () => {
  const bindings: McpBindingEntry[] = [
    makeBinding('agent-A', 'agent-B', 'agent'),
    makeBinding('agent-B', 'agent-A', 'agent'),
    makeBinding('agent-A', 'browser-1', 'browser'),
    makeBinding('agent-A', 'gp_123', 'group-project'),
    makeBinding('agent-C', 'agent-D', 'agent'),
  ];

  it('finds bindings where an agent view is the source', () => {
    const view = makeAgentView('cv1', 'agent-A');
    const result = findBindingsForView(view, bindings);
    // agent-A is source in 3 bindings, and target in 1 (agent-B -> agent-A)
    expect(result).toHaveLength(4);
  });

  it('finds bindings where an agent view is only the target', () => {
    const view = makeAgentView('cv2', 'agent-B');
    const result = findBindingsForView(view, bindings);
    // agent-B is source in 1 binding (B->A), target in 1 (A->B)
    expect(result).toHaveLength(2);
  });

  it('finds bindings for a browser view by view ID', () => {
    const view = makeBrowserView('browser-1');
    const result = findBindingsForView(view, bindings);
    // browser-1 is a target in 1 binding
    expect(result).toHaveLength(1);
    expect(result[0].targetId).toBe('browser-1');
  });

  it('finds bindings for a group project view by groupProjectId', () => {
    const view = makeGroupProjectView('cv3', 'gp_123');
    const result = findBindingsForView(view, bindings);
    expect(result).toHaveLength(1);
    expect(result[0].targetId).toBe('gp_123');
  });

  it('returns empty for views with no bindings', () => {
    const view = makeAgentView('cv4', 'agent-unconnected');
    const result = findBindingsForView(view, bindings);
    expect(result).toHaveLength(0);
  });

  it('returns empty for agent view with null agentId', () => {
    const view: AgentCanvasView = {
      id: 'cv5', type: 'agent', agentId: null,
      position: { x: 0, y: 0 }, size: { width: 300, height: 200 },
      zIndex: 0, title: 'Empty', displayName: 'Empty', metadata: {},
    };
    const result = findBindingsForView(view, bindings);
    expect(result).toHaveLength(0);
  });
});
