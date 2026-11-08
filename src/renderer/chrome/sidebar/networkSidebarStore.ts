/**
 * What the sidebar across machines remembers (#3065, #3066), on this machine
 * only: which machine Show narrows to, which projects are linked into one
 * group, and pairs the person kept separate (so a suggestion to link them
 * isn't made again). Only the display depends on it.
 */

import { create } from 'zustand';
import { groupPairs, mergeLinks, pairKey, pruneLinks, splitLinks, type ShowFilter } from './networkTree';

const STORAGE_KEY = 'clubhouse.networkSidebar';

interface Saved {
  show: ShowFilter;
  links: string[][];
  keptSeparate: string[];
}

interface NetworkSidebarState extends Saved {
  setShow: (show: ShowFilter) => void;
  /** Link two projects (or their groups) into one group: Merge in the sidebar, Link in a suggestion. */
  link: (a: string, b: string) => void;
  /** Split a group into its projects, and remember each pair as kept separate. */
  split: (projectId: string) => void;
  /** Take one project out of its group, remembering it as kept separate from the rest. */
  unlink: (projectId: string) => void;
  /** Keep a suggested pair separate: it isn't suggested again. */
  keepSeparate: (a: string, b: string) => void;
  /** Drop projects that are gone from every link. */
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

function save(state: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ show: state.show, links: state.links, keptSeparate: state.keptSeparate }));
  } catch {
    // telemetry-exempt: the display works for this session; it's only not remembered
  }
}

export const useNetworkSidebarStore = create<NetworkSidebarState>((set, get) => {
  const update = (next: Partial<Saved>) => {
    set(next);
    const s = get();
    save({ show: s.show, links: s.links, keptSeparate: s.keptSeparate });
  };
  return {
    ...load(),
    setShow: (show) => update({ show }),
    link: (a, b) => {
      if (a === b) return;
      const links = mergeLinks(get().links, a, b);
      const linked = new Set(groupPairs(links.find((g) => g.includes(a)) ?? []));
      update({ links, keptSeparate: get().keptSeparate.filter((k) => !linked.has(k)) });
    },
    split: (projectId) => {
      const group = get().links.find((g) => g.includes(projectId)) ?? [];
      update({ links: splitLinks(get().links, projectId), keptSeparate: [...new Set([...get().keptSeparate, ...groupPairs(group)])] });
    },
    unlink: (projectId) => {
      const group = get().links.find((g) => g.includes(projectId));
      if (!group) return;
      const rest = group.filter((id) => id !== projectId);
      const links = [...get().links.filter((g) => g !== group), ...(rest.length > 1 ? [rest] : [])];
      update({ links, keptSeparate: [...new Set([...get().keptSeparate, ...rest.map((id) => pairKey(projectId, id))])] });
    },
    keepSeparate: (a, b) => update({ keptSeparate: [...new Set([...get().keptSeparate, pairKey(a, b)])] }),
    prune: (exists) => {
      const links = pruneLinks(get().links, exists);
      if (JSON.stringify(links) !== JSON.stringify(get().links)) update({ links });
    },
  };
});

/** For tests: forget everything. */
export function _resetNetworkSidebarForTesting(): void {
  useNetworkSidebarStore.setState({ show: 'all', links: [], keptSeparate: [] });
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* telemetry-exempt: test reset */ }
}
