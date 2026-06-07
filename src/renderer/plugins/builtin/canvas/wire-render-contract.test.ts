import { describe, it, expect } from 'vitest';
import { resolveRenderedWires, resolveZoneWireViews, buildViewIndex } from './wire-render-contract';
import type { AgentCanvasView, ZoneCanvasView, PluginCanvasView, CanvasView } from './canvas-types';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import type { ZoneWireDefinition } from './zone-wire-store';

function makeZone(id: string, containedViewIds: string[] = []): ZoneCanvasView {
  return {
    id, type: 'zone',
    position: { x: 0, y: 0 }, size: { width: 600, height: 400 },
    title: id, displayName: id, zIndex: 0, metadata: {},
    themeId: 'catppuccin-mocha', containedViewIds,
  };
}

function makeAgent(id: string, agentId: string): AgentCanvasView {
  return {
    id, type: 'agent',
    position: { x: 50, y: 50 }, size: { width: 200, height: 200 },
    title: id, displayName: id, zIndex: 1, metadata: {}, agentId,
  };
}

function makeGroupProject(id: string, gpId: string): PluginCanvasView {
  return {
    id, type: 'plugin',
    position: { x: 900, y: 50 }, size: { width: 200, height: 200 },
    title: id, displayName: id, zIndex: 1, metadata: { groupProjectId: gpId },
    pluginWidgetType: 'plugin:group-project:group-project', pluginId: 'group-project',
  };
}

function binding(agentId: string, targetId: string, targetKind: McpBindingEntry['targetKind']): McpBindingEntry {
  return { agentId, targetId, targetKind, label: targetId };
}

function zoneWire(id: string, sourceZoneId: string, targetId: string, targetType: ZoneWireDefinition['targetType']): ZoneWireDefinition {
  return { id, sourceZoneId, targetId, targetType };
}

describe('resolveRenderedWires — binding wires', () => {
  it('resolves an agent→agent binding to one wire with both endpoints', () => {
    const a1 = makeAgent('v1', 'durable_1');
    const a2 = makeAgent('v2', 'durable_2');
    const wires = resolveRenderedWires([a1, a2], [binding('durable_1', 'durable_2', 'agent')], []);
    expect(wires).toHaveLength(1);
    expect(wires[0].kind).toBe('binding');
    expect(wires[0].source.id).toBe('v1');
    expect(wires[0].target.id).toBe('v2');
    expect(wires[0].key).toBe('binding:durable_1--durable_2');
  });

  it('resolves an agent→group-project binding via groupProjectId', () => {
    const a1 = makeAgent('v1', 'durable_1');
    const gp = makeGroupProject('v2', 'gp_123');
    const wires = resolveRenderedWires([a1, gp], [binding('durable_1', 'gp_123', 'group-project')], []);
    expect(wires).toHaveLength(1);
    expect(wires[0].target.id).toBe('v2');
  });

  it('drops a binding whose source or target view is missing (no throw)', () => {
    const a1 = makeAgent('v1', 'durable_1');
    expect(resolveRenderedWires([a1], [binding('durable_1', 'gp_missing', 'group-project')], [])).toHaveLength(0);
    expect(resolveRenderedWires([a1], [binding('durable_missing', 'durable_1', 'agent')], [])).toHaveLength(0);
  });
});

describe('resolveRenderedWires — zone wires', () => {
  it('renders ONE wire to the zone, with the zone as an endpoint (not one per member)', () => {
    const zone = makeZone('z1', ['v1', 'v2']);
    const a1 = makeAgent('v1', 'durable_1');
    const a2 = makeAgent('v2', 'durable_2');
    const target = makeAgent('v3', 'durable_3');
    const views: CanvasView[] = [zone, a1, a2, target];
    const wires = resolveRenderedWires(views, [], [zoneWire('zw1', 'z1', 'durable_3', 'agent')]);
    const zoneWires = wires.filter((w) => w.kind === 'zone');
    expect(zoneWires).toHaveLength(1);
    expect(zoneWires[0].source.id).toBe('z1');
    expect(zoneWires[0].source.type).toBe('zone');
    expect(zoneWires[0].target.id).toBe('v3');
    expect(zoneWires[0].key).toBe('zone:zw1');
  });

  it('resolves zone→zone, zone→group-project targets', () => {
    const z1 = makeZone('z1', []);
    const z2 = makeZone('z2', []);
    const gp = makeGroupProject('gpv', 'gp_9');
    const views: CanvasView[] = [z1, z2, gp];
    const w1 = resolveZoneWireViews(zoneWire('a', 'z1', 'z2', 'zone'), buildViewIndex(views));
    expect(w1?.target.id).toBe('z2');
    const w2 = resolveZoneWireViews(zoneWire('b', 'z1', 'gp_9', 'group-project'), buildViewIndex(views));
    expect(w2?.target.id).toBe('gpv');
  });

  it('drops a zone wire whose source is not a zone or whose target is missing', () => {
    const z1 = makeZone('z1', []);
    const a1 = makeAgent('v1', 'durable_1');
    // target missing
    expect(resolveRenderedWires([z1], [], [zoneWire('zw1', 'z1', 'durable_x', 'agent')])).toHaveLength(0);
    // source not a zone
    expect(resolveZoneWireViews(zoneWire('zw2', 'v1', 'durable_1', 'agent'), buildViewIndex([a1]))).toBeNull();
  });

  it('emits binding wires before zone wires, deterministically', () => {
    const a1 = makeAgent('v1', 'durable_1');
    const a2 = makeAgent('v2', 'durable_2');
    const zone = makeZone('z1', ['v1']);
    const wires = resolveRenderedWires(
      [a1, a2, zone],
      [binding('durable_1', 'durable_2', 'agent')],
      [zoneWire('zw1', 'z1', 'durable_2', 'agent')],
    );
    expect(wires.map((w) => w.kind)).toEqual(['binding', 'zone']);
  });
});
