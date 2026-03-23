import { describe, it, expect } from 'vitest';
import { expandZoneWires, reconcileZoneBindings } from './zone-wire-expansion';
import type { AgentCanvasView, ZoneCanvasView, PluginCanvasView } from './canvas-types';
import type { ZoneWireDefinition } from './zone-wire-store';

function makeZone(id: string, containedViewIds: string[]): ZoneCanvasView {
  return {
    id,
    type: 'zone',
    position: { x: 0, y: 0 },
    size: { width: 600, height: 400 },
    title: id,
    displayName: id,
    zIndex: 0,
    metadata: {},
    themeId: 'catppuccin-mocha',
    containedViewIds,
  };
}

function makeAgent(id: string, agentId: string): AgentCanvasView {
  return {
    id,
    type: 'agent',
    position: { x: 50, y: 50 },
    size: { width: 200, height: 200 },
    title: id,
    displayName: id,
    zIndex: 1,
    metadata: {},
    agentId,
  };
}

function makeBrowser(id: string): PluginCanvasView {
  return {
    id,
    type: 'plugin',
    position: { x: 50, y: 50 },
    size: { width: 200, height: 200 },
    title: id,
    displayName: id,
    zIndex: 1,
    metadata: {},
    pluginWidgetType: 'plugin:browser:webview',
    pluginId: 'browser',
  };
}

function makeGroupProject(id: string, gpId: string): PluginCanvasView {
  return {
    id,
    type: 'plugin',
    position: { x: 50, y: 50 },
    size: { width: 200, height: 200 },
    title: id,
    displayName: id,
    zIndex: 1,
    metadata: { groupProjectId: gpId },
    pluginWidgetType: 'plugin:group-project:group-project',
    pluginId: 'group-project',
  };
}

describe('expandZoneWires', () => {
  it('zone -> agent: creates bindings from zone agents to target agent', () => {
    const zone = makeZone('z1', ['a1', 'a2']);
    const a1 = makeAgent('a1', 'durable_1');
    const a2 = makeAgent('a2', 'durable_2');
    const target = makeAgent('a3', 'durable_3');
    const wire: ZoneWireDefinition = { id: 'w1', sourceZoneId: 'z1', targetId: 'durable_3', targetType: 'agent' };

    const result = expandZoneWires([wire], [zone, a1, a2, target]);
    expect(result.length).toBe(2);
    expect(result.find((b) => b.agentId === 'durable_1' && b.targetId === 'durable_3')).toBeTruthy();
    expect(result.find((b) => b.agentId === 'durable_2' && b.targetId === 'durable_3')).toBeTruthy();
  });

  it('zone -> agent: also connects target agent to zone browsers', () => {
    const zone = makeZone('z1', ['a1', 'b1']);
    const a1 = makeAgent('a1', 'durable_1');
    const b1 = makeBrowser('b1');
    const target = makeAgent('a2', 'durable_2');
    const wire: ZoneWireDefinition = { id: 'w1', sourceZoneId: 'z1', targetId: 'durable_2', targetType: 'agent' };

    const result = expandZoneWires([wire], [zone, a1, b1, target]);
    expect(result.find((b) => b.agentId === 'durable_1' && b.targetId === 'durable_2')).toBeTruthy();
    expect(result.find((b) => b.agentId === 'durable_2' && b.targetId === 'b1' && b.targetKind === 'browser')).toBeTruthy();
  });

  it('zone -> group project: connects all zone agents to group project', () => {
    const zone = makeZone('z1', ['a1', 'a2']);
    const a1 = makeAgent('a1', 'durable_1');
    const a2 = makeAgent('a2', 'durable_2');
    const gp = makeGroupProject('gp1', 'gp_id_1');
    const wire: ZoneWireDefinition = { id: 'w1', sourceZoneId: 'z1', targetId: 'gp_id_1', targetType: 'group-project' };

    const result = expandZoneWires([wire], [zone, a1, a2, gp]);
    expect(result.length).toBe(2);
    expect(result.every((b) => b.targetKind === 'group-project' && b.targetId === 'gp_id_1')).toBe(true);
  });

  it('zone -> zone: creates cross-product bindings', () => {
    const z1 = makeZone('z1', ['a1']);
    const z2 = makeZone('z2', ['a2']);
    const a1 = makeAgent('a1', 'durable_1');
    const a2 = makeAgent('a2', 'durable_2');
    const wire: ZoneWireDefinition = { id: 'w1', sourceZoneId: 'z1', targetId: 'z2', targetType: 'zone' };

    const result = expandZoneWires([wire], [z1, z2, a1, a2]);
    expect(result.find((b) => b.agentId === 'durable_1' && b.targetId === 'durable_2')).toBeTruthy();
  });

  it('deduplicates bindings', () => {
    const zone = makeZone('z1', ['a1']);
    const a1 = makeAgent('a1', 'durable_1');
    const target = makeAgent('a2', 'durable_2');
    const wire1: ZoneWireDefinition = { id: 'w1', sourceZoneId: 'z1', targetId: 'durable_2', targetType: 'agent' };
    const wire2: ZoneWireDefinition = { id: 'w2', sourceZoneId: 'z1', targetId: 'durable_2', targetType: 'agent' };

    const result = expandZoneWires([wire1, wire2], [zone, a1, target]);
    // Should only have one binding, not duplicates
    expect(result.length).toBe(1);
  });

  it('returns empty when zone has no contained agents', () => {
    const zone = makeZone('z1', []);
    const target = makeAgent('a1', 'durable_1');
    const wire: ZoneWireDefinition = { id: 'w1', sourceZoneId: 'z1', targetId: 'durable_1', targetType: 'agent' };
    const result = expandZoneWires([wire], [zone, target]);
    // Only browser/group-project bindings from target to zone contents, but zone is empty
    expect(result.length).toBe(0);
  });
});

describe('reconcileZoneBindings', () => {
  it('identifies bindings to add and remove', () => {
    const desired = [
      { agentId: 'a1', targetId: 'a2', targetKind: 'agent' as const, label: 'A2', agentName: 'A1', targetName: 'A2' },
      { agentId: 'a1', targetId: 'a3', targetKind: 'agent' as const, label: 'A3', agentName: 'A1', targetName: 'A3' },
    ];
    const current = [
      { agentId: 'a1', targetId: 'a2' },
      { agentId: 'a1', targetId: 'a4' },
    ];
    const { toAdd, toRemove } = reconcileZoneBindings(desired, current);
    expect(toAdd.length).toBe(1);
    expect(toAdd[0].targetId).toBe('a3');
    expect(toRemove.length).toBe(1);
    expect(toRemove[0].targetId).toBe('a4');
  });

  it('individual bindings not in zone expansion are only in toRemove, not toAdd', () => {
    // Simulates the real usage where only toAdd is used — individual bindings
    // that aren't part of zone expansion are not affected.
    const desired = [
      { agentId: 'a1', targetId: 'a2', targetKind: 'agent' as const, label: 'A2', agentName: 'A1', targetName: 'A2' },
    ];
    const current = [
      { agentId: 'a1', targetId: 'a2' }, // matches zone expansion
      { agentId: 'a1', targetId: 'a3' }, // individual binding (not in zone expansion)
    ];
    const { toAdd, toRemove } = reconcileZoneBindings(desired, current);
    // Nothing new to add
    expect(toAdd.length).toBe(0);
    // a1->a3 appears in toRemove but since the real handler only uses toAdd,
    // this individual binding is preserved
    expect(toRemove.length).toBe(1);
    expect(toRemove[0].targetId).toBe('a3');
  });
});
