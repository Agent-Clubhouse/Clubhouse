import { afterEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { effectiveOrchestratorOf, newAgentOrchestrator, useEffectiveOrchestrator } from './effective-orchestrator';
import { useProjectStore } from '../../stores/projectStore';
import { useRemoteProjectStore } from '../../stores/remoteProjectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';

describe('effectiveOrchestratorOf (#2975)', () => {
  it('is the agent\'s own CLI, else the project\'s "Agents run on", else Claude Code', () => {
    expect(effectiveOrchestratorOf({ orchestrator: 'copilot-cli' }, { orchestrator: 'codex-cli' })).toBe('copilot-cli');
    expect(effectiveOrchestratorOf({}, { orchestrator: 'codex-cli' })).toBe('codex-cli');
    expect(effectiveOrchestratorOf({ orchestrator: null }, {})).toBe('claude-code');
    expect(effectiveOrchestratorOf({}, undefined)).toBe('claude-code');
  });

  it('skips a project value the app does not know, as main does', () => {
    const known = [{ id: 'claude-code' }, { id: 'codex-cli' }];
    expect(effectiveOrchestratorOf({}, { orchestrator: 'opencode' }, known)).toBe('claude-code');
    expect(effectiveOrchestratorOf({}, { orchestrator: 'codex-cli' }, known)).toBe('codex-cli');
    // Before the list loads, the project value stands.
    expect(effectiveOrchestratorOf({}, { orchestrator: 'opencode' }, [])).toBe('opencode');
  });
});

describe('useEffectiveOrchestrator (#2975)', () => {
  afterEach(() => {
    useProjectStore.setState({ projects: [] });
    useRemoteProjectStore.setState({ satelliteProjects: {} });
    useOrchestratorStore.setState({ allOrchestrators: [] });
  });

  it('reads a local agent\'s project from the project store', () => {
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'P', path: '/p', orchestrator: 'codex-cli' }] as never });
    const { result } = renderHook(() => useEffectiveOrchestrator({ projectId: 'p1' }));
    expect(result.current).toBe('codex-cli');
  });

  it('reads a satellite agent\'s project from that satellite', () => {
    const id = 'remote||sat1||p9';
    useRemoteProjectStore.setState({ satelliteProjects: { sat1: [{ id, name: 'P', path: '/p', orchestrator: 'copilot-cli', remote: true, satelliteId: 'sat1', satelliteName: 'Mac' }] } as never });
    const { result } = renderHook(() => useEffectiveOrchestrator({ projectId: id }));
    expect(result.current).toBe('copilot-cli');
  });
});

describe('newAgentOrchestrator (#2975)', () => {
  const offered = [{ id: 'claude-code' }, { id: 'codex-cli' }];
  it('starts on the project\'s "Agents run on" when it is offered', () => {
    expect(newAgentOrchestrator({ orchestrator: 'codex-cli' }, offered)).toBe('codex-cli');
  });
  it('starts on the first CLI offered otherwise', () => {
    expect(newAgentOrchestrator({ orchestrator: 'copilot-cli' }, offered)).toBe('claude-code');
    expect(newAgentOrchestrator(undefined, [{ id: 'codex-cli' }])).toBe('codex-cli');
    expect(newAgentOrchestrator(undefined, [])).toBe('claude-code');
  });
});
