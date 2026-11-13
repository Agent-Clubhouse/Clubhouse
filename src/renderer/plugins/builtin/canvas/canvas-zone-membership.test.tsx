/**
 * Zone wires to a group project whose members are a record (#3357): only a
 * person adding a card to a zone adds a member. Showing another canvas tab,
 * or a reload, re-expands its zones as restores, which never undo an exclusion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { act, render } from '@testing-library/react';
import { CanvasWorkspace } from './CanvasWorkspace';
import type { AgentCanvasView, CanvasView, PluginCanvasView, ZoneCanvasView } from './canvas-types';
import type { ZoneWireDefinition } from './zone-wire-store';
import type { PluginAPI } from '../../../../shared/plugin-types';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';

const zone = (id: string, containedViewIds: string[]): ZoneCanvasView => ({
  id, type: 'zone', position: { x: 0, y: 0 }, size: { width: 600, height: 400 }, title: id, displayName: id,
  zIndex: 0, metadata: {}, themeId: 'catppuccin-mocha', containedViewIds,
});
const agent = (id: string, agentId: string): AgentCanvasView => ({
  id, type: 'agent', position: { x: 50, y: 50 }, size: { width: 200, height: 200 }, title: id, displayName: id, zIndex: 1, metadata: {}, agentId,
});
const gpCard = (id: string, gpId: string): PluginCanvasView => ({
  id, type: 'plugin', position: { x: 700, y: 50 }, size: { width: 200, height: 200 }, title: id, displayName: id, zIndex: 1,
  metadata: { groupProjectId: gpId }, pluginWidgetType: 'plugin:group-project:group-project', pluginId: 'group-project',
});
const wire: ZoneWireDefinition = { id: 'zw', sourceZoneId: 'z1', targetId: 'gp_1', targetType: 'group-project' };

function api(): PluginAPI {
  return {
    agents: { list: () => [], onAnyChange: () => ({ dispose: () => {} }), getDetailedStatus: () => null },
    projects: { list: () => [] },
    context: { mode: 'project', projectId: 'p1' },
    widgets: { AgentAvatar: () => null, AgentTerminal: () => null, SleepingAgent: () => null },
    settings: { get: () => undefined, getAll: () => ({}), set: () => {}, onChange: () => ({ dispose: () => {} }) },
  } as unknown as PluginAPI;
}

function workspace(views: CanvasView[], zoneSessionKey: string) {
  const noop = vi.fn();
  return (
    <CanvasWorkspace
      views={views} viewport={{ panX: 0, panY: 0, zoom: 1 }} zoomedViewId={null} selectedViewId={null} selectedViewIds={[]}
      wireDefinitions={[]} onAddWireDefinition={noop} onRemoveWireDefinition={noop} onUpdateWireDefinition={noop}
      zoneWireDefinitions={[wire]} zoneSessionKey={zoneSessionKey}
      api={api()} onViewportChange={noop} onAddView={noop} onAddPluginView={noop} onRemoveView={noop} onMoveView={noop}
      onMoveViews={noop} onResizeView={noop} onFocusView={noop} onUpdateView={noop} onZoomView={noop} onSelectView={noop}
      onToggleSelectView={noop} onSetSelectedViewIds={noop} onClearSelection={noop}
    />
  );
}

const binds = (bind: ReturnType<typeof vi.fn>) => bind.mock.calls.map((c) => [c[0], c[2]]);

describe('zone wires to a group project (#3357)', () => {
  let bind: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    useMcpBindingStore.setState({ bindings: [] });
    bind = vi.fn(async () => ({ notMember: true }));
    vi.spyOn(window.clubhouse.mcpBinding, 'bind').mockImplementation(bind);
  });

  it('switching canvas tabs re-expands the new canvas as restores, never adding its zone members', async () => {
    const first = [zone('z1', ['card-a']), agent('card-a', 'agent-a'), gpCard('gp', 'gp_1')];
    const second = [zone('z1', ['card-b']), agent('card-b', 'agent-b'), gpCard('gp', 'gp_1')];
    const { rerender } = render(workspace(first, 'canvas-1:1'));
    await act(async () => {});
    expect(binds(bind)).toEqual([['agent-a', 'restore']]);

    bind.mockClear();
    rerender(workspace(second, 'canvas-2:1'));
    await act(async () => {});
    expect(binds(bind)).toEqual([['agent-b', 'restore']]);

    // Back again: still a restore, and the refused member isn't retried on later changes.
    bind.mockClear();
    rerender(workspace(first, 'canvas-1:1'));
    await act(async () => {});
    expect(binds(bind)).toEqual([['agent-a', 'restore']]);
  });

  it('a reload of the same canvas is a hydration too', async () => {
    const views = [zone('z1', ['card-a']), agent('card-a', 'agent-a'), gpCard('gp', 'gp_1')];
    const { rerender } = render(workspace(views, 'canvas-1:1'));
    await act(async () => {});
    bind.mockClear();
    rerender(workspace([...views], 'canvas-1:2'));
    await act(async () => {});
    expect(binds(bind)).toEqual([['agent-a', 'restore']]);
  });

  it('a card moved into a zone on the same canvas is a person adding it', async () => {
    const before = [zone('z1', []), agent('card-a', 'agent-a'), gpCard('gp', 'gp_1')];
    const after = [zone('z1', ['card-a']), agent('card-a', 'agent-a'), gpCard('gp', 'gp_1')];
    const { rerender } = render(workspace(before, 'canvas-1:1'));
    await act(async () => {});
    rerender(workspace(after, 'canvas-1:1'));
    await act(async () => {});
    expect(binds(bind)).toEqual([['agent-a', undefined]]);
  });
});
