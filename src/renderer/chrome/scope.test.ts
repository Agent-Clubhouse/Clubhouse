import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { relativeTo, resolveChromeScope, useChromeScope } from './scope';
import { useChromeFlagStore } from './chromeFlag';
import { useChromeStore } from './chromeStore';
import { useProjectStore } from '../stores/projectStore';
import { useAgentStore } from '../stores/agentStore';
import type { Agent, Project } from '../../shared/types';

const project = { id: 'p1', name: 'Clubhouse', path: '/src/ch' } as Project;
const agent = (over: Partial<Agent> = {}) =>
  ({ id: 'a1', projectId: 'p1', name: 'gallant-swift', kind: 'durable', status: 'running', color: 'blue', worktreePath: '/src/ch/.clubhouse/agents/gallant-swift', ...over }) as Agent;

describe('relativeTo', () => {
  it('returns the path below the root, or . for the root or outside it', () => {
    expect(relativeTo('/src/ch', '/src/ch/.clubhouse/agents/x')).toBe('.clubhouse/agents/x');
    expect(relativeTo('/src/ch/', '/src/ch')).toBe('.');
    expect(relativeTo('/src/ch', '/elsewhere/x')).toBe('.');
    expect(relativeTo('C:\\src\\ch', 'C:\\src\\ch\\.clubhouse\\agents\\x')).toBe('.clubhouse/agents/x');
  });
});

describe('resolveChromeScope', () => {
  it('points at the selected agent worktree', () => {
    expect(resolveChromeScope(project, agent(), null)).toMatchObject({
      kind: 'agent', cwd: '/src/ch/.clubhouse/agents/gallant-swift', relativeRoot: '.clubhouse/agents/gallant-swift', label: 'gallant-swift', isWorktree: true,
    });
  });

  it('carries the worktree branch when the agent has one', () => {
    expect(resolveChromeScope(project, agent({ branch: 'gallant-swift/rows' }), null)?.branch).toBe('gallant-swift/rows');
    expect(resolveChromeScope(project, agent(), null)?.branch).toBeUndefined();
    expect(resolveChromeScope(project, agent({ branch: 'x' }), 'p1')?.branch).toBeUndefined();
  });

  it('falls back to the project root for an agent without a worktree', () => {
    expect(resolveChromeScope(project, agent({ worktreePath: undefined }), null)).toMatchObject({
      kind: 'agent', cwd: '/src/ch', relativeRoot: '.', isWorktree: false, agentName: 'gallant-swift',
    });
  });

  it('points at the project root when the project header is selected or no agent is', () => {
    expect(resolveChromeScope(project, agent(), 'p1')).toMatchObject({ kind: 'project', cwd: '/src/ch', label: 'Clubhouse' });
    expect(resolveChromeScope(project, undefined, null)).toMatchObject({ kind: 'project' });
    expect(resolveChromeScope(project, agent({ projectId: 'other' }), null)).toMatchObject({ kind: 'project' });
  });
});

describe('useChromeScope', () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [project] as never, activeProjectId: 'p1' });
    useAgentStore.setState({ agents: { a1: agent() }, activeAgentId: 'a1' });
    useChromeStore.setState({ projectScopeId: null });
  });

  it('is null while the new layout is off', () => {
    useChromeFlagStore.setState({ enabled: false });
    expect(renderHook(() => useChromeScope('p1')).result.current).toBeNull();
  });

  it('resolves for the active project when the new layout is on', () => {
    useChromeFlagStore.setState({ enabled: true });
    try {
      expect(renderHook(() => useChromeScope('p1')).result.current?.kind).toBe('agent');
      expect(renderHook(() => useChromeScope('other')).result.current).toBeNull();
      expect(renderHook(() => useChromeScope(undefined)).result.current).toBeNull();
    } finally {
      useChromeFlagStore.setState({ enabled: false });
    }
  });
});
