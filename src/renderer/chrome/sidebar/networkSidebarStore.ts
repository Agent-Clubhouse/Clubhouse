import { transientProjectLinksError } from '../../../shared/project-links';
import type { ProjectLinksOp, ProjectLinksView } from '../../../shared/project-links';
/**
 * Show stays local; links and Keep separate choices come from the shared
 * Annex Network replica. Pending edits render immediately and are replayed over
 * incoming snapshots until main acknowledges them. Legacy storage is kept intact.
 */

import { create } from 'zustand';
import { groupPairs, mergeLinks, pairKey, splitLinks, type ShowFilter } from './networkTree';

const STORAGE_KEY = 'clubhouse.networkSidebar';

interface Saved {
  show: ShowFilter;
  links: string[][];
  keptSeparate: string[];
}

interface NetworkSidebarState extends Saved {
  handoffLinkError: boolean;
  linkErrorRetryable: boolean;
  retryHandoffLinks: () => void;
  setShow: (show: ShowFilter) => void;
  /** Link two projects (or their groups) into one group: Merge in the sidebar, Link in a suggestion. */
  link: (a: string, b: string) => void;
  /** Split a group into its projects, and remember each pair as kept separate. */
  split: (projectId: string) => void;
  /** Take one project out of its group, remembering it as kept separate from the rest. */
  unlink: (projectId: string) => void;
  /** Keep a suggested pair separate: it isn't suggested again. */
  keepSeparate: (a: string, b: string) => void;
  /** Unlink deleted local projects network-wide. Unpairing uses only a display filter. */
  prune: (exists: (projectId: string) => boolean) => void;
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Saved> | null) : null;
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
    return {
      show: typeof parsed?.show === 'string' && parsed.show ? parsed.show : 'all',
      links: Array.isArray(parsed?.links) ? parsed!.links.map(strings).filter((g) => g.length > 1) : [],
      keptSeparate: strings(parsed?.keptSeparate),
    };
  } catch {
    // telemetry-exempt: corrupt or blocked storage falls back to showing everything, unlinked
    return { show: 'all', links: [], keptSeparate: [] };
  }
}

let epoch = 0, running = false, hydrated = false;
let offChanged: (() => void) | undefined;
let pending: ProjectLinksOp[] = [];
let base: ProjectLinksView = { revision: -1, links: [], keptSeparate: [] };
function optimistic(state: Pick<Saved, 'links' | 'keptSeparate'>, op: ProjectLinksOp): Pick<Saved, 'links' | 'keptSeparate'> {
  if (op.type === 'link') {
    const links = mergeLinks(state.links, op.a, op.b);
    const linked = new Set(groupPairs(links.find((g) => g.includes(op.a)) ?? []));
    return { links, keptSeparate: state.keptSeparate.filter((k) => !linked.has(k)) };
  }
  if (op.type === 'keepSeparate') return { ...state, keptSeparate: [...new Set([...state.keptSeparate, pairKey(op.a, op.b)])] };
  const group = state.links.find((g) => g.includes(op.a)) ?? [];
  const rest = group.filter((id) => id !== op.a);
  return { links: op.type === 'split' ? splitLinks(state.links, op.a) : [...state.links.filter((g) => g !== group), ...(rest.length > 1 ? [rest] : [])],
    keptSeparate: [...new Set([...state.keptSeparate, ...(op.type === 'split' ? groupPairs(group) : rest.map((id) => pairKey(op.a, id)))])] };
}
function publish(view: ProjectLinksView): void {
  if (view.revision >= base.revision) base = view;
  const next = pending.reduce(optimistic, base);
  useNetworkSidebarStore.setState({ links: next.links, keptSeparate: next.keptSeparate });
}
async function flush(): Promise<void> {
  if (running || !window.clubhouse?.project?.hydrateProjectLinks) return;
  running = true;
  const version = epoch;
  try {
    if (!hydrated) {
      offChanged ??= window.clubhouse.project.onProjectLinksChanged((view) => { if (version === epoch) publish(view); });
      const view = await window.clubhouse.project.hydrateProjectLinks(load());
      if (version !== epoch) return;
      hydrated = true; publish(view);
    }
    let rejected = false;
    while (pending.length && version === epoch) {
      try {
        const view = await window.clubhouse.project.changeProjectLinks(pending[0]);
        if (version !== epoch) return;
        pending.shift(); publish(view);
      } catch (error) { // telemetry-exempt: a visible error reports the refused edit; temporary failures can retry
        if (version !== epoch) return;
        const retryable = transientProjectLinksError(error);
        useNetworkSidebarStore.setState({ handoffLinkError: true, linkErrorRetryable: retryable });
        if (retryable) return;
        pending.shift(); publish(base);
        rejected = true;
      }
    }
    if (version === epoch && !rejected) useNetworkSidebarStore.setState({ handoffLinkError: false, linkErrorRetryable: false });
  } catch (error) { // telemetry-exempt: hydration failed; the settings section reports it
    if (version === epoch) useNetworkSidebarStore.setState({ handoffLinkError: true, linkErrorRetryable: transientProjectLinksError(error) });
  } finally { if (version === epoch) running = false; }
}

function change(op: ProjectLinksOp): void {
  useNetworkSidebarStore.setState({ handoffLinkError: false, linkErrorRetryable: false });
  pending.push(op);
  useNetworkSidebarStore.setState(optimistic(useNetworkSidebarStore.getState(), op));
  void flush();
}
/** Preserve saved legacy choices verbatim for migration and downgrade. Only Show stays local. */
function saveShow(show: ShowFilter): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const previous = raw ? JSON.parse(raw) : {};
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...previous, show }));
  } catch { /* telemetry-exempt: the display works for this session if storage is unavailable */ }
}

export const useNetworkSidebarStore = create<NetworkSidebarState>((set, get) => ({
  ...load(),
  handoffLinkError: false, linkErrorRetryable: false,
  retryHandoffLinks: () => { void flush(); },
  setShow: (show) => { set({ show }); saveShow(show); },
  link: (a, b) => { if (a !== b) change({ type: 'link', a, b }); },
  split: (a) => change({ type: 'split', a }),
  unlink: (a) => { if (get().links.some((g) => g.includes(a))) change({ type: 'unlink', a }); },
  keepSeparate: (a, b) => change({ type: 'keepSeparate', a, b }),
  prune: (exists) => { for (const a of new Set(get().links.flat())) if (!exists(a)) change({ type: 'unlink', a }); },
}));
queueMicrotask(() => { void flush(); });

/** For tests: forget the current window's replica. */
export function _resetNetworkSidebarForTesting(): void {
  epoch++; offChanged?.(); offChanged = undefined;
  pending = []; hydrated = false; running = false;
  base = { revision: -1, links: [], keptSeparate: [] };
  useNetworkSidebarStore.setState({ handoffLinkError: false, linkErrorRetryable: false, show: 'all', links: [], keptSeparate: [] });
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* telemetry-exempt: test reset */ }
}
