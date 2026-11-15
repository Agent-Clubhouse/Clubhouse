import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Agent, AgentDetailedStatus } from '../../../shared/types';
import { useChromeStore } from '../chromeStore';
import { useSidebarOrder, type SidebarRecencyInput } from './useSidebarOrder';
import { sidebarProjectGroups } from './sidebarProjectOrder';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const agent = (id: string, projectId: string, status: Agent['status'] = 'running'): Agent => ({
  id, projectId, name: id, kind: 'durable', status, color: 'blue',
});
const detail = (timestamp: number): AgentDetailedStatus => ({ state: 'working', message: '', timestamp });
const REMOTE = 'remote||sat||go';

function order(
  projects: string[],
  agentsByProject: Record<string, Agent[]>,
  recency: SidebarRecencyInput,
  projectActivity: Record<string, number>,
  pinned: string[] = [],
): string[] {
  useChromeStore.setState({ projectSort: 'recent', projectActivity, pinnedProjectIds: pinned, agentActivity: {} });
  const { result } = renderHook(() => useSidebarOrder(projects.map((id) => ({ id })), agentsByProject, recency));
  return result.current.projects.map((p) => p.id);
}

describe('useSidebarOrder Recent order across machines (#3542)', () => {
  beforeEach(() => {
    useChromeStore.setState({ projectSort: 'manual', agentSort: 'manual', projectActivity: {}, agentActivity: {}, pinnedProjectIds: [] });
  });

  it('keeps unlinked local projects in plain recent order', () => {
    expect(order(['a', 'b', 'c'], {}, {}, { a: NOW - 3 * DAY, b: NOW - HOUR, c: NOW - DAY })).toEqual(['b', 'c', 'a']);
  });

  it('ranks a local project by its running agents, above sleeping-only and empty projects', () => {
    // Spawned a week ago and never slept: its project activity is the spawn, but the agent was busy just now.
    const agents = { go: [agent('a1', 'go')], site: [agent('s1', 'site', 'sleeping')] };
    expect(order(['site', 'empty', 'go'], agents, { detailed: { a1: detail(NOW - 60_000), s1: detail(NOW - 30_000) } },
      { go: NOW - 7 * DAY, site: NOW - DAY, empty: NOW - 2 * HOUR })).toEqual(['go', 'empty', 'site']);
  });

  it('ranks a remote project by its running agents', () => {
    const agents = { [REMOTE]: [agent('remote||sat||a1', REMOTE)] };
    // The remote row only ever had its first-seen seed here.
    expect(order(['site', REMOTE], agents, { detailed: { 'remote||sat||a1': detail(NOW - 60_000) } },
      { site: NOW - DAY, [REMOTE]: NOW - 9 * DAY })).toEqual([REMOTE, 'site']);
  });

  it('ranks a linked group by activity on either copy', () => {
    const members = { go: ['go', REMOTE] };
    // Activity recorded on the remote copy's id only.
    expect(order(['site', 'go'], {}, { members }, { site: NOW - DAY, go: NOW - 9 * DAY, [REMOTE]: NOW - HOUR })).toEqual(['go', 'site']);
    // An agent running on the other machine, listed under the group.
    const agents = { go: [agent('remote||sat||a1', REMOTE)] };
    expect(order(['site', 'go'], agents, { members, detailed: { 'remote||sat||a1': detail(NOW - 60_000) } },
      { site: NOW - DAY, go: NOW - 9 * DAY })).toEqual(['go', 'site']);
    // And one running on this machine's copy.
    const local = { go: [agent('a2', 'go')] };
    expect(order(['site', 'go'], local, { members, detailed: { a2: detail(NOW - 60_000) } },
      { site: NOW - DAY, go: NOW - 9 * DAY })).toEqual(['go', 'site']);
  });

  it('orders the same before and after an unlinked to linked transition', () => {
    const activity = { site: NOW - DAY, go: NOW - 9 * DAY, [REMOTE]: NOW - HOUR };
    expect(order(['site', 'go', REMOTE], {}, {}, activity)).toEqual([REMOTE, 'site', 'go']);
    expect(order(['site', 'go'], {}, { members: { go: ['go', REMOTE] } }, activity)).toEqual(['go', 'site']);
  });

  it('does not count sleeping agents', () => {
    const agents = { go: [agent('a1', 'go', 'sleeping')] };
    expect(order(['site', 'go'], agents, { detailed: { a1: detail(NOW - 60_000) } }, { site: NOW - DAY, go: NOW - 9 * DAY })).toEqual(['site', 'go']);
  });

  it('keeps pinned precedence over the Recent order', () => {
    const agents = { go: [agent('a1', 'go')] };
    const activity = { pin: NOW - 9 * DAY, go: NOW - 9 * DAY };
    const sorted = order(['pin', 'go'], agents, { detailed: { a1: detail(NOW - 60_000) } }, activity, ['pin']);
    expect(sorted).toEqual(['go', 'pin']);
    // The tree's sections, as ProjectTree builds them from this order.
    const groups = sidebarProjectGroups(sorted.map((id) => ({ id })), {
      projectSort: 'manual', projectActivity: activity, pinnedProjectIds: ['pin'], inactiveProjectIds: [], idleDays: 0,
    }, { runningIds: new Set(['go']), activeProjectId: null, now: NOW });
    expect([...groups.pinned, ...groups.active].map((p) => p.id)).toEqual(['pin', 'go']);
  });
});
