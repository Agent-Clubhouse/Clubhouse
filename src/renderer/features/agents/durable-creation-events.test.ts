import { describe, it, expect, beforeEach } from 'vitest';
import { applyDurableCreationEvent } from './durable-creation-events';
import { useAgentStore } from '../../stores/agentStore';
import type { Agent, DurableCreationEvent } from '../../../shared/types';

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
    applyDurableCreationEvent(event('failed', { reason: 'The branch already exists' }));
    expect(useAgentStore.getState().agents.h1).toMatchObject({ status: 'error', creationFailed: true, errorMessage: 'The branch already exists', parentAgentId: 'lead' });
  });

  it('clears the mark when the creation is ready', () => {
    applyDurableCreationEvent(event('failed', { reason: 'x' }));
    applyDurableCreationEvent(event('ready'));
    expect(useAgentStore.getState().agents.h1.status).toBe('sleeping');
    expect(useAgentStore.getState().agents.h1.creationFailed).toBeFalsy();
  });
});
