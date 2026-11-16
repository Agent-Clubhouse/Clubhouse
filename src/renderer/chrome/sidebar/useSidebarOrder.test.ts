import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Agent } from '../../../shared/types';
import { useChromeStore } from '../chromeStore';
import { useSidebarOrder } from './useSidebarOrder';
import { sidebarProjectGroups, sidebarProjectOrder } from './sidebarProjectOrder';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const agent = (id: string, projectId: string, status: Agent['status'] = 'running'): Agent => ({
  id, projectId, name: id, kind: 'durable', status, color: 'blue',
});
const REMOTE = 'remote||sat||go';

function order(
  projects: string[],
  agentsByProject: Record<string, Agent[]>,
  projectActivity: Record<string, number>,
  members?: Record<string, string[]>,
  agentActivity: Record<string, number> = {},
): string[] {
  useChromeStore.setState({ projectSort: 'recent', projectActivity, agentActivity });
  const { result } = renderHook(() => useSidebarOrder(projects.map((id) => ({ id })), agentsByProject, members));
  return result.current.projects.map((p) => p.id);
}

describe('useSidebarOrder Recent order across machines (#3542)', () => {
  beforeEach(() => {
    useChromeStore.setState({ projectSort: 'manual', agentSort: 'manual', projectActivity: {}, agentActivity: {}, pinnedProjectIds: [] });
  });

  it('keeps unlinked local projects in plain recent order', () => {
    expect(order(['a', 'b', 'c'], {}, { a: NOW - 3 * DAY, b: NOW - HOUR, c: NOW - DAY })).toEqual(['b', 'c', 'a']);
  });

  it('puts a local project with a running agent above sleeping-only and empty projects', () => {
    // Spawned a week ago and never slept: its project activity is the spawn.
    const agents = { go: [agent('a1', 'go')], site: [agent('s1', 'site', 'sleeping')] };
    expect(order(['site', 'empty', 'go'], agents, { go: NOW - 7 * DAY, site: NOW - DAY, empty: NOW - 2 * HOUR })).toEqual(['go', 'empty', 'site']);
  });

  it('puts a remote project with a running agent first, though it only has its first-seen seed', () => {
    const agents = { [REMOTE]: [agent('remote||sat||a1', REMOTE)] };
    expect(order(['site', REMOTE], agents, { site: NOW - DAY, [REMOTE]: NOW - 9 * DAY })).toEqual([REMOTE, 'site']);
  });

  it('ranks a linked group by activity on either copy', () => {
    const members = { go: ['go', REMOTE] };
    // Activity recorded under the remote copy's id only.
    expect(order(['site', 'go'], {}, { site: NOW - DAY, go: NOW - 9 * DAY, [REMOTE]: NOW - HOUR }, members)).toEqual(['go', 'site']);
    // An agent running on the other machine, listed under the group.
    expect(order(['site', 'go'], { go: [agent('remote||sat||a1', REMOTE)] }, { site: NOW - DAY, go: NOW - 9 * DAY }, members)).toEqual(['go', 'site']);
    // And one running on this machine's copy.
    expect(order(['site', 'go'], { go: [agent('a2', 'go')] }, { site: NOW - DAY, go: NOW - 9 * DAY }, members)).toEqual(['go', 'site']);
  });

  it('orders running rows among themselves by recorded activity, and their agents\' spawns and turns here', () => {
    const agents = { a: [agent('a1', 'a')], b: [agent('b1', 'b')], c: [] };
    expect(order(['a', 'b', 'c'], agents, { a: NOW - 2 * DAY, b: NOW - DAY, c: NOW - HOUR })).toEqual(['b', 'a', 'c']);
    expect(order(['a', 'b', 'c'], agents, { a: NOW - 2 * DAY, b: NOW - DAY, c: NOW - HOUR }, undefined, { a1: NOW - 60_000 })).toEqual(['a', 'b', 'c']);
  });

  it('orders the same before and after an unlinked to linked transition', () => {
    const activity = { site: NOW - DAY, go: NOW - 9 * DAY, [REMOTE]: NOW - HOUR };
    const remoteAgent = agent('remote||sat||a1', REMOTE);
    expect(order(['site', 'go', REMOTE], { [REMOTE]: [remoteAgent] }, activity)).toEqual([REMOTE, 'site', 'go']);
    expect(order(['site', 'go'], { go: [remoteAgent] }, activity, { go: ['go', REMOTE] })).toEqual(['go', 'site']);
  });

  it('does not count sleeping agents', () => {
    expect(order(['site', 'go'], { go: [agent('a1', 'go', 'sleeping')] }, { site: NOW - DAY, go: NOW - 9 * DAY }, undefined, { a1: NOW })).toEqual(['site', 'go']);
  });

  it('ignores times that are not finite numbers', () => {
    const members = { go: ['go', REMOTE] };
    expect(order(['site', 'go'], {}, { site: NOW - DAY, go: NOW - HOUR, [REMOTE]: Number.NaN }, members)).toEqual(['go', 'site']);
    expect(order(['site', 'go'], { go: [agent('a1', 'go')], site: [agent('s1', 'site')] },
      { site: NOW - DAY, go: NOW - HOUR }, undefined, { a1: Number.NaN, s1: Number.POSITIVE_INFINITY })).toEqual(['go', 'site']);
  });

  it('keeps pinned precedence over the Recent order', () => {
    const activity = { pin: NOW - 9 * DAY, go: NOW - 9 * DAY };
    const sorted = order(['pin', 'go'], { go: [agent('a1', 'go')] }, activity);
    expect(sorted).toEqual(['go', 'pin']);
    // The tree's sections, as ProjectTree builds them from this order.
    const groups = sidebarProjectGroups(sorted.map((id) => ({ id })), {
      projectSort: 'manual', projectActivity: activity, pinnedProjectIds: ['pin'], inactiveProjectIds: [], idleDays: 0,
    }, { runningIds: new Set(['go']), activeProjectId: null, now: NOW });
    expect([...groups.pinned, ...groups.active].map((p) => p.id)).toEqual(['pin', 'go']);
  });

  it('returns the same array while status events leave the order as it is', () => {
    useChromeStore.setState({ projectSort: 'recent', projectActivity: { a: NOW - DAY, b: NOW - HOUR }, agentActivity: {} });
    const projects = [{ id: 'a' }, { id: 'b' }];
    const { result, rerender } = renderHook(({ agents }) => useSidebarOrder(projects, agents), {
      initialProps: { agents: { a: [agent('a1', 'a')] } as Record<string, Agent[]> },
    });
    const first = result.current.projects;
    expect(first.map((p) => p.id)).toEqual(['a', 'b']);
    // A new agent list each status event, with the same agents running.
    rerender({ agents: { a: [{ ...agent('a1', 'a') }] } });
    rerender({ agents: { a: [{ ...agent('a1', 'a') }] } });
    expect(result.current.projects).toBe(first);
    // A real change still moves the rows.
    rerender({ agents: { a: [agent('a1', 'a', 'sleeping')] } });
    expect(result.current.projects.map((p) => p.id)).toEqual(['b', 'a']);
  });
});

describe('sidebarProjectGroups idle fold across linked copies (#3557)', () => {
  const state = (projectActivity: Record<string, number>, over: Partial<Parameters<typeof sidebarProjectGroups>[1]> = {}) => ({
    projectSort: 'manual' as const, projectActivity, pinnedProjectIds: [], inactiveProjectIds: [], idleDays: 7, ...over,
  });
  const groups = (
    ids: string[], activity: Record<string, number>, members?: Record<string, string[]>,
    over: Partial<Parameters<typeof sidebarProjectGroups>[1]> = {},
  ) => {
    const g = sidebarProjectGroups(ids.map((id) => ({ id })), state(activity, over), { runningIds: new Set(), activeProjectId: null, now: NOW, members });
    return { active: g.active.map((p) => p.id), idle: g.idle.map((p) => p.id) };
  };

  it('keeps a linked group out of the fold when only another copy was active', () => {
    const members = { go: ['go', REMOTE] };
    const activity = { go: NOW - 20 * DAY, [REMOTE]: NOW - HOUR };
    expect(groups(['go'], activity, members)).toEqual({ active: ['go'], idle: [] });
    // Without the members, the old rule: the row's own activity only.
    expect(groups(['go'], activity)).toEqual({ active: [], idle: ['go'] });
  });

  it('folds a linked group when every copy is past the window', () => {
    const members = { go: ['go', REMOTE] };
    expect(groups(['go'], { go: NOW - 20 * DAY, [REMOTE]: NOW - 9 * DAY }, members)).toEqual({ active: [], idle: ['go'] });
  });

  it('leaves unlinked projects as they were, with or without members', () => {
    const activity = { a: NOW - HOUR, b: NOW - 20 * DAY };
    const expected = { active: ['a'], idle: ['b'] };
    expect(groups(['a', 'b'], activity)).toEqual(expected);
    expect(groups(['a', 'b'], activity, { a: ['a'], b: ['b'] })).toEqual(expected);
  });

  it('ignores copies\' times that are not finite, and a group with none stays active', () => {
    const members = { go: ['go', REMOTE] };
    expect(groups(['go'], { go: NOW - 20 * DAY, [REMOTE]: Number.POSITIVE_INFINITY }, members)).toEqual({ active: [], idle: ['go'] });
    expect(groups(['go'], { go: NOW - 20 * DAY, [REMOTE]: Number.NaN }, members)).toEqual({ active: [], idle: ['go'] });
    expect(groups(['go'], {}, members)).toEqual({ active: ['go'], idle: [] });
  });

  it('keeps pins, inactive marks and the never-idle setting as they were', () => {
    const members = { go: ['go', REMOTE], old: ['old', 'remote||sat||old'] };
    const activity = { go: NOW - 20 * DAY, [REMOTE]: NOW - HOUR, old: NOW - 20 * DAY };
    // Marked inactive: idle at once, whatever a copy did.
    expect(groups(['go', 'old'], activity, members, { inactiveProjectIds: ['go'] })).toEqual({ active: [], idle: ['go', 'old'] });
    // Pinned rows are in the pinned section, not the fold.
    const pinned = sidebarProjectGroups(['go', 'old'].map((id) => ({ id })), state(activity, { pinnedProjectIds: ['old'] }),
      { runningIds: new Set(), activeProjectId: null, now: NOW, members });
    expect(pinned.pinned.map((p) => p.id)).toEqual(['old']);
    // idleDays 0: never idle.
    expect(groups(['old'], activity, members, { idleDays: 0 })).toEqual({ active: ['old'], idle: [] });
  });
});

describe('sidebarProjectOrder Recent order matches the sidebar (#3558)', () => {
  it('puts a project with a long-running agent first, as the sidebar does', () => {
    const projects = ['site', 'go', 'docs'];
    const activity = { site: NOW - DAY, docs: NOW - 2 * DAY, go: NOW - 9 * DAY };
    const agentsByProject = { go: [agent('a1', 'go')] };
    const sidebar = order(projects, agentsByProject, activity);
    const picker = sidebarProjectOrder(projects.map((id) => ({ id })), {
      projectSort: 'recent', projectActivity: activity, pinnedProjectIds: [], inactiveProjectIds: [], idleDays: 0,
    }, { runningIds: new Set(['go']), activeProjectId: null, now: NOW, agentsByProject, agentActivity: {} });
    expect(sidebar).toEqual(['go', 'site', 'docs']);
    expect(picker.map((p) => p.id)).toEqual(sidebar);
  });

  it('orders running projects by their agents\' spawns and turns, as the sidebar does', () => {
    const projects = ['a', 'b'];
    const activity = { a: NOW - 2 * DAY, b: NOW - DAY };
    const agentsByProject = { a: [agent('a1', 'a')], b: [agent('b1', 'b')] };
    const agentActivity = { a1: NOW - 60_000 };
    const sidebar = order(projects, agentsByProject, activity, undefined, agentActivity);
    const picker = sidebarProjectOrder(projects.map((id) => ({ id })), {
      projectSort: 'recent', projectActivity: activity, pinnedProjectIds: [], inactiveProjectIds: [], idleDays: 0,
    }, { runningIds: new Set(['a', 'b']), activeProjectId: null, now: NOW, agentsByProject, agentActivity });
    expect(picker.map((p) => p.id)).toEqual(sidebar);
  });
});
