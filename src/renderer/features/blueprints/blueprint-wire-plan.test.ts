import { describe, it, expect } from 'vitest';
import type { BlueprintWire } from '../../../shared/blueprint-types';
import type { CanvasView } from '../../plugins/builtin/canvas/canvas-types';
import { BROWSER_WIDGET_TYPE, GROUP_PROJECT_WIDGET_TYPE, planBlueprintWires } from './blueprint-wire-plan';

const base = { position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, zIndex: 0, metadata: {} };
const agent = (id: string, agentId: string | null, metadata: Record<string, string> = {}): CanvasView =>
  ({ ...base, id, title: id, displayName: id, type: 'agent', agentId, metadata }) as CanvasView;
const widget = (id: string, pluginWidgetType: string, metadata: Record<string, string> = {}): CanvasView =>
  ({ ...base, id, title: id, displayName: id, type: 'plugin', pluginWidgetType, pluginId: pluginWidgetType.split(':')[1], metadata }) as CanvasView;
const refs = (...ids: string[]) => new Map(ids.map((id) => [id, id]));

describe('planBlueprintWires', () => {
  it('creates an explicit reverse wire next to a bidirectional one only once', () => {
    const wires: BlueprintWire[] = [
      { sourceRef: 'a', targetRef: 'b', bidirectional: true },
      { sourceRef: 'b', targetRef: 'a' },
    ];
    const plan = planBlueprintWires(wires, refs('a', 'b'), [agent('a', 'agent-a'), agent('b', 'agent-b')]);
    expect(plan.create.map((w) => `${w.agentId}->${w.targetId}`)).toEqual(['agent-a->agent-b', 'agent-b->agent-a']);
  });

  it('ignores bidirectional for widget targets', () => {
    const plan = planBlueprintWires(
      [{ sourceRef: 'a', targetRef: 'web', bidirectional: true }],
      refs('a', 'web'),
      [agent('a', 'agent-a'), widget('web', BROWSER_WIDGET_TYPE)],
    );
    expect(plan.create).toEqual([expect.objectContaining({ agentId: 'agent-a', targetId: 'web', targetKind: 'browser' })]);
  });

  it('defers a group project with no group project id yet', () => {
    const plan = planBlueprintWires(
      [{ sourceRef: 'a', targetRef: 'gp' }],
      refs('a', 'gp'),
      [agent('a', 'agent-a'), widget('gp', GROUP_PROJECT_WIDGET_TYPE)],
    );
    expect(plan.create).toEqual([]);
    expect(plan.deferred).toEqual([expect.objectContaining({ reason: 'target_unbound', targetViewId: 'gp' })]);
  });

  it('only treats the exact browser and group-project widgets as targets', () => {
    const plan = planBlueprintWires(
      [{ sourceRef: 'a', targetRef: 'x' }, { sourceRef: 'a', targetRef: 'y' }],
      refs('a', 'x', 'y'),
      [agent('a', 'agent-a'), widget('x', 'plugin:my-browser-ish:thing'), widget('y', 'plugin:files:group-projects-list', { groupProjectId: 'gp' })],
    );
    expect(plan.create).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['unsupported_target', 'unsupported_target']);
  });

  it('skips wires from a non-agent view or to a view that does not exist', () => {
    const plan = planBlueprintWires(
      [{ sourceRef: 'web', targetRef: 'a' }, { sourceRef: 'a', targetRef: 'gone' }],
      refs('a', 'web'),
      [agent('a', 'agent-a'), widget('web', BROWSER_WIDGET_TYPE)],
    );
    expect(plan.skipped.map((s) => s.reason)).toEqual(['source_not_agent', 'missing_view']);
  });

  it('copies metadata onto each definition without sharing it, and carries the project name', () => {
    const wire: BlueprintWire = { sourceRef: 'a', targetRef: 'b', bidirectional: true, instructions: { '*': 'Be brief' }, disabledTools: ['broadcast'] };
    const plan = planBlueprintWires([wire], refs('a', 'b'), [agent('a', 'agent-a', { projectName: 'web-app' }), agent('b', 'agent-b')]);
    expect(plan.create).toHaveLength(2);
    for (const entry of plan.create) {
      expect(entry).toMatchObject({ instructions: { '*': 'Be brief' }, disabledTools: ['broadcast'], projectName: 'web-app' });
    }
    expect(plan.create[0].instructions).not.toBe(wire.instructions);
    expect(plan.create[0].disabledTools).not.toBe(plan.create[1].disabledTools);
  });

  it('leaves empty metadata off', () => {
    const plan = planBlueprintWires([{ sourceRef: 'a', targetRef: 'b', instructions: {}, disabledTools: [] }], refs('a', 'b'), [agent('a', 'agent-a'), agent('b', 'agent-b')]);
    expect(plan.create[0]).not.toHaveProperty('instructions');
    expect(plan.create[0]).not.toHaveProperty('disabledTools');
  });

  it('labels definitions the way wiring by hand does', () => {
    const plan = planBlueprintWires([{ sourceRef: 'a', targetRef: 'b' }], refs('a', 'b'), [agent('a', 'agent-a'), agent('b', 'agent-b')]);
    expect(plan.create[0]).toMatchObject({ label: 'b', agentName: 'a', targetName: 'b' });
  });

  it('skips a wire from a card to itself, or between two cards of the same agent', () => {
    const plan = planBlueprintWires(
      [{ sourceRef: 'a', targetRef: 'a' }, { sourceRef: 'a', targetRef: 'twin' }],
      refs('a', 'twin'),
      [agent('a', 'agent-a'), agent('twin', 'agent-a')],
    );
    expect(plan.create).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['self', 'self']);
  });
});

