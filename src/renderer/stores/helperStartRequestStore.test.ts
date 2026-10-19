import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import type { HelperStartRequest } from '../../shared/types';
import {
  describeHelperStarts,
  startRequestsByOrchestrator,
  startRequestsFor,
  useHelperStartRequestStore,
} from './helperStartRequestStore';

const PROJECT = path.join(path.sep, 'work', 'proj');

function request(id: string, orchestratorId: string, name: string, createdAt: string): HelperStartRequest {
  return {
    requestId: id, projectPath: PROJECT, orchestratorId, orchestratorName: 'Orch',
    args: { name, task: 't' }, createdAt, expiresAt: '2026-10-20T00:00:00.000Z',
  };
}

describe('helperStartRequestStore (#2234)', () => {
  beforeEach(() => useHelperStartRequestStore.setState({ requests: {} }));

  it('adds and removes requests by id', () => {
    const store = useHelperStartRequestStore.getState();
    store.add(request('r1', 'o', 'a', '2026-10-18T10:00:00.000Z'));
    store.add(request('r2', 'o', 'b', '2026-10-18T09:00:00.000Z'));
    expect(Object.keys(useHelperStartRequestStore.getState().requests).sort()).toEqual(['r1', 'r2']);
    store.remove(['r1', 'unknown']);
    expect(Object.keys(useHelperStartRequestStore.getState().requests)).toEqual(['r2']);
  });

  it('groups by orchestrator, oldest first, and describes them for Needs you', () => {
    const requests = {
      r1: request('r1', 'o', 'later', '2026-10-18T10:00:00.000Z'),
      r2: request('r2', 'o', 'first', '2026-10-18T09:00:00.000Z'),
      r3: request('r3', 'other', 'x', '2026-10-18T08:00:00.000Z'),
    };
    expect(startRequestsFor(requests, 'o').map((r) => r.requestId)).toEqual(['r2', 'r1']);
    const grouped = startRequestsByOrchestrator(requests);
    expect(Object.keys(grouped).sort()).toEqual(['o', 'other']);
    expect(describeHelperStarts(grouped.o)).toBe('Wants to start 2 helpers');
    expect(describeHelperStarts(grouped.other)).toBe('Wants to start the helper x');
  });
});
