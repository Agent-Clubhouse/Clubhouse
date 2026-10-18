import { describe, it, expect } from 'vitest';
import { collectCanvasEndpointIds, findAgentCanvasHits, reconcilePersistedWires } from './canvas-persistence';

const views = [
  { id: 'v1', type: 'agent', agentId: 'durable_a' },
  { id: 'v2', type: 'plugin', metadata: { groupProjectId: 'gp_1' } },
  { id: 'br', type: 'plugin', metadata: {} },
  { id: 'v3', type: 'agent', agentId: null },
];
const wire = (agentId: string, targetId: string) => ({ agentId, targetId, targetKind: 'agent', label: 'x' });

describe('canvas-persistence', () => {
  it('collects view ids, agent ids and group project ids', () => {
    expect([...collectCanvasEndpointIds(views)].sort()).toEqual(['br', 'durable_a', 'gp_1', 'v1', 'v2', 'v3']);
  });

  it('drops wires with a missing endpoint or missing fields', () => {
    const kept = reconcilePersistedWires([
      wire('durable_a', 'gp_1'),
      wire('durable_a', 'br'),
      wire('durable_a', 'durable_gone'),
      wire('durable_gone', 'gp_1'),
      { agentId: 'durable_a', targetId: 'gp_1', targetKind: '', label: 'x' },
    ], views);
    expect(kept.map((w) => w.targetId)).toEqual(['gp_1', 'br']);
  });

  it('keeps every well-formed wire when there are no views to reconcile against', () => {
    expect(reconcilePersistedWires([wire('a', 'b')], [])).toHaveLength(1);
  });

  it('finds each canvas holding an agent card', () => {
    const canvases = [
      { id: 'c1', name: 'one', views },
      { id: 'c2', name: 'two', views: [{ id: 'x', type: 'agent', agentId: 'durable_b' }] },
      { id: 'c3', name: 'three', views: [{ id: 'y', type: 'agent', agentId: 'durable_a' }] },
    ];
    expect(findAgentCanvasHits(canvases, 'durable_a')).toEqual([
      { canvasId: 'c1', name: 'one', viewId: 'v1' },
      { canvasId: 'c3', name: 'three', viewId: 'y' },
    ]);
    expect(findAgentCanvasHits(canvases, 'nobody')).toEqual([]);
  });
});
