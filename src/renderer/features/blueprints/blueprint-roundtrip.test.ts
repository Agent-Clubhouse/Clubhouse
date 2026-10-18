/**
 * Export → import round trip for wires (#2068): what a canvas exports must
 * import back to the same wires through the shared parse/plan path.
 */

import { describe, it, expect } from 'vitest';
import type { CanvasInstance, CanvasView } from '../../plugins/builtin/canvas/canvas-types';
import type { McpBindingEntry } from '../../stores/mcpBindingStore';
import type { Agent } from '../../../shared/types';
import { exportCanvasToBlueprint } from './blueprint-export';
import { parseAnyBlueprint } from './parse-blueprint';

const base = { position: { x: 0, y: 0 }, size: { width: 480, height: 480 }, zIndex: 0 };
const views: CanvasView[] = [
  { ...base, id: 'v-lead', type: 'agent', title: 'Lead', displayName: 'Lead', metadata: {}, agentId: 'agent-lead', projectId: 'p1' },
  { ...base, id: 'v-dev', type: 'agent', title: 'Dev', displayName: 'Dev', metadata: {}, agentId: 'agent-dev', projectId: 'p1' },
  { ...base, id: 'v-board', type: 'plugin', title: 'Board', displayName: 'Board', pluginWidgetType: 'plugin:group-project:group-project', pluginId: 'group-project', metadata: { groupProjectId: 'gp-7' } },
  { ...base, id: 'v-docs', type: 'plugin', title: 'Docs', displayName: 'Docs', pluginWidgetType: 'plugin:browser:webview', pluginId: 'browser', metadata: {} },
] as CanvasView[];

const canvas: CanvasInstance = {
  id: 'c1', name: 'Team', views, viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: views.length,
  zoomedViewId: null, selectedViewId: null, minimapAutoHide: true, elkAlgorithm: 'layered', elkDirection: 'RIGHT', layoutCenterId: null,
};

const agents = {
  'agent-lead': { id: 'agent-lead', name: 'Lead', kind: 'durable', status: 'sleeping', color: 'blue', projectId: 'p1' },
  'agent-dev': { id: 'agent-dev', name: 'Dev', kind: 'durable', status: 'sleeping', color: 'green', projectId: 'p1' },
} as unknown as Record<string, Agent>;

const wires: McpBindingEntry[] = [
  // A two-way pair with the same options (the reverse lists disabled tools in another order).
  { agentId: 'agent-lead', targetId: 'agent-dev', targetKind: 'agent', label: 'Dev', instructions: { send_message: 'Ask before merging' }, disabledTools: ['broadcast', 'read_output'] },
  { agentId: 'agent-dev', targetId: 'agent-lead', targetKind: 'agent', label: 'Lead', instructions: { send_message: 'Ask before merging' }, disabledTools: ['read_output', 'broadcast'] },
  { agentId: 'agent-lead', targetId: 'gp-7', targetKind: 'group-project', label: 'Board', instructions: { '*': 'Post status' } },
  { agentId: 'agent-lead', targetId: 'v-docs', targetKind: 'browser', label: 'Docs' },
];

describe('blueprint wire round trip', () => {
  it('exports group-project wires and folds a matching agent pair into one bidirectional wire', () => {
    const manifest = exportCanvasToBlueprint(canvas, { agents, projects: {}, wireDefinitions: wires });
    const refName = new Map(manifest.canvas.views.map((v) => [v.refId, v.displayName]));
    expect(manifest.canvas.wires.map((w) => ({ ...w, sourceRef: refName.get(w.sourceRef), targetRef: refName.get(w.targetRef) }))).toEqual([
      { sourceRef: 'Lead', targetRef: 'Dev', bidirectional: true, instructions: { send_message: 'Ask before merging' }, disabledTools: ['broadcast', 'read_output'] },
      { sourceRef: 'Lead', targetRef: 'Board', instructions: { '*': 'Post status' } },
      { sourceRef: 'Lead', targetRef: 'Docs' },
    ]);
  });

  it('keeps a pair with different options as two wires', () => {
    const differing = [wires[0], { ...wires[1], instructions: { send_message: 'Something else' } }];
    const manifest = exportCanvasToBlueprint(canvas, { agents, projects: {}, wireDefinitions: differing });
    expect(manifest.canvas.wires).toHaveLength(2);
    expect(manifest.canvas.wires.some((w) => w.bidirectional)).toBe(false);
  });

  it('imports back to the same wires through parseAnyBlueprint', () => {
    const manifest = exportCanvasToBlueprint(canvas, { agents, projects: {}, wireDefinitions: wires });
    const result = parseAnyBlueprint(JSON.parse(JSON.stringify(manifest)), {
      agents: Object.values(agents), projects: [], groupProjectIds: new Set(['gp-7']),
    });
    const viewName = new Map(result.canvas.views.map((v) => [v.id, v.displayName]));
    const imported = result.wires.create.map((w) => ({
      agentId: w.agentId, targetKind: w.targetKind,
      targetId: w.targetKind === 'browser' ? `view:${viewName.get(w.targetId)}` : w.targetId,
      ...(w.instructions ? { instructions: w.instructions } : {}),
      ...(w.disabledTools ? { disabledTools: [...w.disabledTools].sort() } : {}),
    }));
    expect(imported).toEqual([
      { agentId: 'agent-lead', targetKind: 'agent', targetId: 'agent-dev', instructions: { send_message: 'Ask before merging' }, disabledTools: ['broadcast', 'read_output'] },
      { agentId: 'agent-dev', targetKind: 'agent', targetId: 'agent-lead', instructions: { send_message: 'Ask before merging' }, disabledTools: ['broadcast', 'read_output'] },
      { agentId: 'agent-lead', targetKind: 'group-project', targetId: 'gp-7', instructions: { '*': 'Post status' } },
      { agentId: 'agent-lead', targetKind: 'browser', targetId: 'view:Docs' },
    ]);
    expect(result.wires.deferred).toEqual([]);
    expect(result.wires.skipped).toEqual([]);
  });
});
