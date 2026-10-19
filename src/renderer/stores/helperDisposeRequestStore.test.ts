import { describe, it, expect, beforeEach } from 'vitest';
import { useHelperDisposeRequestStore, describeHelperDispose, type PendingHelperDispose } from './helperDisposeRequestStore';
import type { HelperDisposeChecks } from '../../shared/types';

function pending(checks: HelperDisposeChecks, forceRequested = false): PendingHelperDispose {
  return {
    request: { projectPath: '/p', orchestratorId: 'orch', helperId: 'h', helperName: 'Docs', checks, forceRequested },
    orchestratorName: 'Orch',
    at: 1,
  };
}

describe('helperDisposeRequestStore (#2229)', () => {
  beforeEach(() => useHelperDisposeRequestStore.setState({ requests: {}, reviewing: null }));

  it('keeps one request per helper and dismisses it', () => {
    const store = useHelperDisposeRequestStore.getState();
    store.add(pending({ dirty: 1, unpushed: 0, unmerged: 0 }).request, 'Orch', 5);
    store.add(pending({ dirty: 2, unpushed: 0, unmerged: 0 }).request, 'Orch', 9);
    expect(Object.keys(useHelperDisposeRequestStore.getState().requests)).toEqual(['h']);
    expect(useHelperDisposeRequestStore.getState().requests.h).toMatchObject({ at: 9, request: { checks: { dirty: 2 } } });
    store.dismiss('h');
    expect(useHelperDisposeRequestStore.getState().requests).toEqual({});
  });

  it('opens a pending request for review and closes it when dismissed (#2232)', () => {
    const store = useHelperDisposeRequestStore.getState();
    store.review('h');
    expect(useHelperDisposeRequestStore.getState().reviewing).toBeNull();
    store.add(pending({ dirty: 0, unpushed: 0, unmerged: 0 }).request, 'Orch', 5);
    store.review('h');
    expect(useHelperDisposeRequestStore.getState().reviewing).toBe('h');
    store.dismiss('h');
    expect(useHelperDisposeRequestStore.getState()).toMatchObject({ requests: {}, reviewing: null });
  });

  it('describes who asked and what the checks found', () => {
    expect(describeHelperDispose(pending({ dirty: 1, unpushed: 2, unmerged: 3 }, true)))
      .toBe('Orch asked to dispose this helper (forced). 1 uncommitted file, 2 unpushed commits, 3 unmerged commits.');
    expect(describeHelperDispose(pending({ dirty: 0, unpushed: 0, unmerged: null, error: "couldn't check, git failed" })))
      .toBe("Orch asked to dispose this helper. Couldn't check, git failed.");
    expect(describeHelperDispose(pending({ dirty: 0, unpushed: 0, unmerged: 0 })))
      .toBe('Orch asked to dispose this helper. Nothing would be lost.');
  });
});
