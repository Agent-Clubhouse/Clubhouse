/**
 * Icons a satellite's snapshot left out to stay in its size budget (#3649). The snapshot still
 * names each agent or project's `icon`, so the ones with no image in it are fetched through the
 * satellite's icon routes: lazily, a few at a time, each once. A failure is not retried until a
 * later snapshot comes after the retry delay, and only a few times, so it can't turn into a storm.
 */

/** The parts of a satellite's snapshot this reads and fills. */
export interface IconSnapshot {
  projects: unknown[];
  agents: Record<string, unknown[]>;
  agentIcons?: Record<string, string>;
  projectIcons?: Record<string, string>;
  dispatcher?: unknown;
}

interface Named { id: string; icon?: string; emoji?: string }

export type IconKind = 'agent' | 'project';

export type IconFetchResult =
  | { status: 'ok'; dataUrl: string }
  | { status: 'missing' }
  | { status: 'failed' };

export interface RemoteIconState {
  /** What was fetched, by kind and id, with the icon name it was for. A new name is a new icon. */
  have: Map<string, { icon: string; dataUrl: string }>;
  /** Fetches that came back without an image, by key, with the icon name they were for. */
  tried: Map<string, { icon: string; failures: number; lastAtMs: number; missing: boolean }>;
  running: boolean;
  /** A snapshot came while fetching, so look again once done. */
  again: boolean;
}

export const ICON_FETCH_CONCURRENCY = 4;
export const ICON_FETCH_MAX_FAILURES = 3;
export const ICON_FETCH_RETRY_MS = 30_000;

export function newRemoteIconState(): RemoteIconState {
  return { have: new Map(), tried: new Map(), running: false, again: false };
}

const keyOf = (kind: IconKind, id: string) => `${kind}:${id}`;

interface Want { kind: IconKind; id: string; icon: string }

/** Everything the snapshot says has an image file, whether or not the snapshot carries it. */
function namedIcons(snapshot: IconSnapshot): Want[] {
  const wants: Want[] = [];
  for (const project of (snapshot.projects ?? []) as Named[]) {
    if (project.icon) wants.push({ kind: 'project', id: project.id, icon: project.icon });
  }
  for (const agents of Object.values(snapshot.agents ?? {})) {
    for (const agent of agents as Named[]) {
      // An emoji avatar draws instead of the image, so there's nothing to fetch for it.
      if (agent.icon && !agent.emoji) wants.push({ kind: 'agent', id: agent.id, icon: agent.icon });
    }
  }
  const dispatcher = (snapshot.dispatcher as { agent?: Partial<Named> } | undefined)?.agent;
  if (dispatcher?.id && dispatcher.icon && !dispatcher.emoji) wants.push({ kind: 'agent', id: dispatcher.id, icon: dispatcher.icon });
  return wants;
}

/** Put fetched icons into a snapshot that doesn't carry them. Returns whether anything was added. */
export function applyFetchedIcons(state: RemoteIconState, snapshot: IconSnapshot): boolean {
  let added = false;
  for (const want of namedIcons(snapshot)) {
    const hit = state.have.get(keyOf(want.kind, want.id));
    if (!hit || hit.icon !== want.icon) continue;
    const field = want.kind === 'agent' ? 'agentIcons' : 'projectIcons';
    const map = (snapshot[field] ??= {});
    if (!map[want.id]) { map[want.id] = hit.dataUrl; added = true; }
  }
  return added;
}

function dueNow(state: RemoteIconState, want: Want, nowMs: number): boolean {
  const key = keyOf(want.kind, want.id);
  const have = state.have.get(key);
  if (have && have.icon === want.icon) return false;
  const tried = state.tried.get(key);
  if (!tried || tried.icon !== want.icon) return true;
  if (tried.missing || tried.failures >= ICON_FETCH_MAX_FAILURES) return false;
  return nowMs - tried.lastAtMs >= ICON_FETCH_RETRY_MS;
}

/**
 * Fetch the icons `snapshot` names but doesn't carry. `current` says whether the connection
 * and snapshot are still the ones this began for; `onFetched` runs after a batch added images.
 */
export async function fetchLeftOutIcons(
  state: RemoteIconState,
  getSnapshot: () => IconSnapshot | null,
  fetchIcon: (kind: IconKind, id: string) => Promise<IconFetchResult>,
  onFetched: () => void,
  now: () => number = Date.now,
): Promise<void> {
  if (state.running) { state.again = true; return; }
  state.running = true;
  try {
    do {
      state.again = false;
      const snapshot = getSnapshot();
      if (!snapshot) return;
      // Forget what's no longer named, so the cache stays as small as the snapshot.
      const named = namedIcons(snapshot);
      const live = new Set(named.map((w) => keyOf(w.kind, w.id)));
      for (const map of [state.have, state.tried]) {
        for (const key of [...map.keys()]) if (!live.has(key)) map.delete(key);
      }
      const missing = named.filter((want) => {
        const carried = (want.kind === 'agent' ? snapshot.agentIcons : snapshot.projectIcons)?.[want.id];
        return !carried && dueNow(state, want, now());
      });
      let added = false;
      let next = 0;
      const worker = async () => {
        while (next < missing.length) {
          const want = missing[next++];
          const key = keyOf(want.kind, want.id);
          let result: IconFetchResult;
          try {
            result = await fetchIcon(want.kind, want.id);
          } catch {
            // telemetry-exempt: a failed icon is counted and retried within the limits above, and shows initials meanwhile
            result = { status: 'failed' };
          }
          if (result.status === 'ok') {
            state.have.set(key, { icon: want.icon, dataUrl: result.dataUrl });
            state.tried.delete(key);
            added = true;
          } else {
            const prev = state.tried.get(key);
            const failures = prev && prev.icon === want.icon ? prev.failures + 1 : 1;
            state.tried.set(key, { icon: want.icon, failures, lastAtMs: now(), missing: result.status === 'missing' });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(ICON_FETCH_CONCURRENCY, missing.length) }, worker));
      if (added) onFetched();
      // Only a look at newer snapshots for new work; failures wait for a snapshot after their delay.
    } while (state.again);
  } finally {
    state.running = false;
  }
}
