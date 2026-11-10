import { describe, it, expect, beforeEach } from 'vitest';
import { applyDurableCreationEvent } from './durable-creation-events';
import { useAgentStore } from '../../stores/agentStore';
import type { Agent, DurableAgentConfig, DurableCreationEvent } from '../../../shared/types';

/** The record main keeps for a failed asynchronous creation, marked failed with its reason. */
const failedConfig = (reason: string): DurableAgentConfig => ({
  id: 'h1', name: 'h1', color: 'blue', createdAt: '2026-10-18T00:00:00Z', parentAgentId: 'lead',
  creation: { state: 'failed', startedAt: '2026-10-18T00:00:00Z', stage: 'failed', reason },
});

const event = (stage: DurableCreationEvent['stage'], over: Partial<DurableCreationEvent> = {}): DurableCreationEvent => ({
  projectPath: '/src/ch', agentId: 'h1', stage, at: '2026-10-18T00:00:00Z', elapsedMs: 1, ...over,
});

describe('applyDurableCreationEvent', () => {
  beforeEach(() => {
    useAgentStore.setState({
      agents: { h1: { id: 'h1', projectId: 'p1', name: 'h1', kind: 'durable', status: 'creating', color: 'blue', parentAgentId: 'lead' } as Agent },
    });
  });

  it('marks a failed creation, with its reason, so the sidebar says it couldn\'t start (#2231)', () => {
    applyDurableCreationEvent(event('failed', { reason: 'The branch already exists', config: failedConfig('The branch already exists') }));
    expect(useAgentStore.getState().agents.h1).toMatchObject({ status: 'error', creationFailed: true, errorMessage: 'The branch already exists', parentAgentId: 'lead' });
  });

  it('clears the mark when the creation is ready', () => {
    applyDurableCreationEvent(event('failed', { reason: 'x', config: failedConfig('x') }));
    applyDurableCreationEvent(event('ready'));
    expect(useAgentStore.getState().agents.h1.status).toBe('sleeping');
    expect(useAgentStore.getState().agents.h1.creationFailed).toBeFalsy();
  });

  it('removes the row when a failed creation took its record with it (#3246)', () => {
    applyDurableCreationEvent(event('failed', { reason: 'Copilot CLI can\'t use the Default permissions' }));
    expect(useAgentStore.getState().agents.h1).toBeUndefined();
  });

  it('removes a cancelled creation, and ignores a removal for a row it never had', () => {
    applyDurableCreationEvent(event('cancelled'));
    expect(useAgentStore.getState().agents.h1).toBeUndefined();
    const before = useAgentStore.getState().agents;
    applyDurableCreationEvent(event('failed', { agentId: 'unknown', reason: 'x' }));
    expect(useAgentStore.getState().agents).toBe(before);
  });
});
