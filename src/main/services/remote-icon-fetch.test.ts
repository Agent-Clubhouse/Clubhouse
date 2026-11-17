import { describe, it, expect, vi } from 'vitest';
import type { SatelliteSnapshot } from '../../shared/types';
import {
  applyFetchedIcons, fetchLeftOutIcons, newRemoteIconState, ICON_FETCH_CONCURRENCY, ICON_FETCH_MAX_FAILURES, ICON_FETCH_RETRY_MS,
  type IconFetchResult,
} from './remote-icon-fetch';

function snap(overrides: Partial<SatelliteSnapshot> = {}): SatelliteSnapshot {
  return {
    projects: [{ id: 'p1', name: 'P', path: '/p', icon: 'p.png' }],
    agents: { p1: [
      { id: 'a1', name: 'a', kind: 'durable', status: 'sleeping', projectId: 'p1', color: 'blue', icon: 'a1.png' },
      { id: 'a2', name: 'b', kind: 'durable', status: 'sleeping', projectId: 'p1', color: 'blue', icon: 'a2.png' },
      { id: 'a3', name: 'c', kind: 'durable', status: 'sleeping', projectId: 'p1', color: 'blue', emoji: '🦊' },
    ] },
    agentIcons: { a1: 'data:image/png;base64,INLINE' },
    projectIcons: {},
    quickAgents: {}, theme: {}, orchestrators: {}, pendingPermissions: [], lastSeq: 0,
    ...overrides,
  } as unknown as SatelliteSnapshot;
}

const ok = (n: string): IconFetchResult => ({ status: 'ok', dataUrl: `data:image/png;base64,${n}` });

describe('fetchLeftOutIcons (#3649)', () => {
  it('fetches only icons the snapshot names but does not carry, then shows them', async () => {
    const state = newRemoteIconState();
    const snapshot = snap();
    const fetchIcon = vi.fn(async (_kind: string, id: string) => ok(id));
    const onFetched = vi.fn();
    await fetchLeftOutIcons(state, () => snapshot, fetchIcon, onFetched);
    // a1 came inline and a3 is an emoji: neither is fetched.
    expect(fetchIcon.mock.calls.map((c) => `${c[0]}:${c[1]}`).sort()).toEqual(['agent:a2', 'project:p1']);
    expect(onFetched).toHaveBeenCalledTimes(1);
    applyFetchedIcons(state, snapshot);
    expect(snapshot.agentIcons).toEqual({ a1: 'data:image/png;base64,INLINE', a2: 'data:image/png;base64,a2' });
    expect(snapshot.projectIcons).toEqual({ p1: 'data:image/png;base64,p1' });
  });

  it('keeps fetched icons on a later snapshot without fetching again', async () => {
    const state = newRemoteIconState();
    const fetchIcon = vi.fn(async (_k: string, id: string) => ok(id));
    await fetchLeftOutIcons(state, () => snap(), fetchIcon, () => {});
    const next = snap();
    expect(applyFetchedIcons(state, next)).toBe(true);
    fetchIcon.mockClear();
    await fetchLeftOutIcons(state, () => next, fetchIcon, () => {});
    expect(fetchIcon).not.toHaveBeenCalled();
  });

  it('fetches again when an agent gets a new icon', async () => {
    const state = newRemoteIconState();
    const fetchIcon = vi.fn(async (_k: string, id: string) => ok(id));
    await fetchLeftOutIcons(state, () => snap(), fetchIcon, () => {});
    const changed = snap();
    changed.agents.p1[1].icon = 'a2-new.png';
    expect(applyFetchedIcons(state, changed)).toBe(true); // p1 still known, a2 is not
    expect(changed.agentIcons?.a2).toBeUndefined();
    fetchIcon.mockClear();
    await fetchLeftOutIcons(state, () => changed, fetchIcon, () => {});
    expect(fetchIcon.mock.calls.map((c) => c[1])).toEqual(['a2']);
  });

  it('runs at most the bounded number at once', async () => {
    const agents = Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, name: 'x', kind: 'durable', status: 'sleeping', projectId: 'p1', color: 'blue', icon: `x${i}.png` }));
    const snapshot = snap({ agents: { p1: agents } as never, agentIcons: {}, projects: [] });
    let live = 0;
    let peak = 0;
    const fetchIcon = async (): Promise<IconFetchResult> => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 1));
      live--;
      return ok('x');
    };
    await fetchLeftOutIcons(newRemoteIconState(), () => snapshot, fetchIcon, () => {});
    expect(peak).toBeLessThanOrEqual(ICON_FETCH_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  it('does not retry a missing icon, and falls back to no image', async () => {
    const state = newRemoteIconState();
    const snapshot = snap();
    const fetchIcon = vi.fn(async (): Promise<IconFetchResult> => ({ status: 'missing' }));
    await fetchLeftOutIcons(state, () => snapshot, fetchIcon, () => {});
    const first = fetchIcon.mock.calls.length;
    await fetchLeftOutIcons(state, () => snapshot, fetchIcon, () => {}, () => Date.now() + 10 * ICON_FETCH_RETRY_MS);
    expect(fetchIcon.mock.calls.length).toBe(first);
    expect(snapshot.agentIcons?.a2).toBeUndefined();
  });

  it('retries a failure only after the delay and only a few times', async () => {
    const state = newRemoteIconState();
    const snapshot = snap({ projects: [] });
    const fetchIcon = vi.fn(async (): Promise<IconFetchResult> => ({ status: 'failed' }));
    let t = 1_000_000;
    const now = () => t;
    await fetchLeftOutIcons(state, () => snapshot, fetchIcon, () => {}, now);
    expect(fetchIcon).toHaveBeenCalledTimes(1);
    // A snapshot right away doesn't retry.
    await fetchLeftOutIcons(state, () => snapshot, fetchIcon, () => {}, now);
    expect(fetchIcon).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) {
      t += ICON_FETCH_RETRY_MS;
      await fetchLeftOutIcons(state, () => snapshot, fetchIcon, () => {}, now);
    }
    expect(fetchIcon).toHaveBeenCalledTimes(ICON_FETCH_MAX_FAILURES);
  });

  it('treats a throwing fetch as a failure', async () => {
    const state = newRemoteIconState();
    const onFetched = vi.fn();
    await fetchLeftOutIcons(state, () => snap({ projects: [] }), async () => { throw new Error('boom'); }, onFetched);
    expect(onFetched).not.toHaveBeenCalled();
  });

  it('does nothing with no snapshot', async () => {
    const fetchIcon = vi.fn();
    await fetchLeftOutIcons(newRemoteIconState(), () => null, fetchIcon, () => {});
    expect(fetchIcon).not.toHaveBeenCalled();
  });
});
