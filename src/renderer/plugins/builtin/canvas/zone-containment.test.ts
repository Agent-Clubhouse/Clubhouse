import { describe, it, expect } from 'vitest';
import { buildZoneContainmentMap, getViewThemeOverride } from './zone-containment';
import type { CanvasView, ZoneCanvasView, AgentCanvasView } from './canvas-types';

function makeZone(overrides?: Partial<ZoneCanvasView>): ZoneCanvasView {
  return {
    id: 'zone_1',
    type: 'zone',
    position: { x: 0, y: 0 },
    size: { width: 600, height: 400 },
    title: 'test-zone',
    displayName: 'test-zone',
    zIndex: 0,
    metadata: {},
    themeId: 'nord',
    containedViewIds: ['agent_1'],
    ...overrides,
  };
}

function makeAgent(overrides?: Partial<AgentCanvasView>): AgentCanvasView {
  return {
    id: 'agent_1',
    type: 'agent',
    position: { x: 50, y: 50 },
    size: { width: 200, height: 200 },
    title: 'Agent',
    displayName: 'Agent',
    zIndex: 1,
    metadata: {},
    agentId: 'durable_1',
    ...overrides,
  };
}

describe('buildZoneContainmentMap', () => {
  it('maps contained views to their zone', () => {
    const zone = makeZone({ containedViewIds: ['agent_1', 'agent_2'] });
    const agent1 = makeAgent({ id: 'agent_1' });
    const agent2 = makeAgent({ id: 'agent_2' });
    const map = buildZoneContainmentMap([zone, agent1, agent2]);
    expect(map.viewToZone.get('agent_1')).toBe('zone_1');
    expect(map.viewToZone.get('agent_2')).toBe('zone_1');
    expect(map.zoneThemes.get('zone_1')).toBe('nord');
  });

  it('returns empty maps when no zones', () => {
    const agent = makeAgent();
    const map = buildZoneContainmentMap([agent]);
    expect(map.viewToZone.size).toBe(0);
    expect(map.zoneThemes.size).toBe(0);
  });

  it('handles multiple zones', () => {
    const zone1 = makeZone({ id: 'z1', themeId: 'nord', containedViewIds: ['a1'] });
    const zone2 = makeZone({ id: 'z2', themeId: 'dracula', containedViewIds: ['a2'] });
    const a1 = makeAgent({ id: 'a1' });
    const a2 = makeAgent({ id: 'a2' });
    const map = buildZoneContainmentMap([zone1, zone2, a1, a2]);
    expect(map.viewToZone.get('a1')).toBe('z1');
    expect(map.viewToZone.get('a2')).toBe('z2');
    expect(map.zoneThemes.get('z1')).toBe('nord');
    expect(map.zoneThemes.get('z2')).toBe('dracula');
  });
});

describe('getViewThemeOverride', () => {
  it('returns theme for view in zone', () => {
    const zone = makeZone({ themeId: 'dracula', containedViewIds: ['agent_1'] });
    const map = buildZoneContainmentMap([zone, makeAgent()]);
    expect(getViewThemeOverride('agent_1', map)).toBe('dracula');
  });

  it('returns undefined for view not in any zone', () => {
    const zone = makeZone({ containedViewIds: [] });
    const map = buildZoneContainmentMap([zone, makeAgent()]);
    expect(getViewThemeOverride('agent_1', map)).toBeUndefined();
  });
});
