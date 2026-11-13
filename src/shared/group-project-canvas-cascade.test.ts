import { describe, expect, it } from 'vitest';
import { removeGroupProjectCanvasReferences } from './group-project-canvas-cascade';

const gp = (id: string, groupProjectId: string) => ({ id, type: 'plugin', pluginWidgetType: 'plugin:group-project:group-project', metadata: { groupProjectId } });

describe('group project canvas cleanup', () => {
  it('removes only the target cards and associated references on every canvas', () => {
    const instances = [
      { id: 'one', views: [gp('a', 'gp'), gp('b', 'other'), { id: 'z', type: 'zone', containedViewIds: ['a', 'b'] }], selectedViewId: 'a', zoomedViewId: 'b', deferredWires: [{ sourceViewId: 'x', targetViewId: 'a' }, { sourceViewId: 'x', targetViewId: 'b' }], future: 42 },
      { id: 'two', views: [gp('c', 'gp')], layoutCenterId: 'c' },
    ];
    const wires = [{ targetKind: 'group-project', targetId: 'gp' }, { targetKind: 'group-project', targetId: 'other' }, { targetKind: 'agent', targetId: 'gp' }];
    const zones = [{ targetType: 'group-project', targetId: 'gp' }, { targetType: 'group-project', targetId: 'other' }];
    const result = removeGroupProjectCanvasReferences(instances, wires, zones, 'gp');
    expect(result.instances).toEqual([
      { id: 'one', views: [gp('b', 'other'), { id: 'z', type: 'zone', containedViewIds: ['b'] }], selectedViewId: null, zoomedViewId: 'b', deferredWires: [{ sourceViewId: 'x', targetViewId: 'b' }], future: 42 },
      { id: 'two', views: [], layoutCenterId: null },
    ]);
    expect(result.wires).toEqual(wires.slice(1));
    expect(result.zoneWires).toEqual(zones.slice(1));
    expect(instances[0].views).toHaveLength(3);
  });

  it('refuses incomplete inventory rather than silently dropping it', () => {
    expect(() => removeGroupProjectCanvasReferences([{ views: [null] }], [], [], 'gp')).toThrow();
    expect(() => removeGroupProjectCanvasReferences([], [null], [], 'gp')).toThrow();
  });
});

describe('late canvas saves', () => {
  it('strips tombstoned references without changing unrelated keys', async () => {
    const { stripDeletedGroupProjectsFromCanvasKey } = await import('./group-project-canvas-cascade');
    const value = [{ id: 'one', views: [gp('a', 'gone'), gp('b', 'kept')] }];
    expect(stripDeletedGroupProjectsFromCanvasKey('canvas-instances', value, ['gone'])).toEqual([{ id: 'one', views: [gp('b', 'kept')] }]);
    expect(stripDeletedGroupProjectsFromCanvasKey('canvas-wires', [{ targetKind: 'group-project', targetId: 'gone' }], ['gone'])).toEqual([]);
    expect(stripDeletedGroupProjectsFromCanvasKey('other', value, ['gone'])).toBe(value);
  });
});
