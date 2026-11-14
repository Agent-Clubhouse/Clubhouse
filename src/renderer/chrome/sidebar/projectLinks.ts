/**
 * Suggested links between the same project on two machines (#3066): a
 * project here and one on another machine that share a git remote. One
 * suggestion per pair, never again once linked or kept separate.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Project } from '../../../shared/types';
import { useProjectStore } from '../../stores/projectStore';
import { useRemoteProjectStore } from '../../stores/remoteProjectStore';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useNetworkSidebarStore } from './networkSidebarStore';
import { linkGroupOf, pairKey } from './networkTree';

export interface LinkSuggestion {
  /** This machine's project. */
  local: Project;
  /** The same project on another machine. */
  remote: Project & { satelliteId?: string; satelliteName?: string };
}

/** The pairs that share a git remote and aren't linked or kept separate, this machine's projects in order. */
export function linkSuggestions(
  local: readonly Project[],
  localKeys: Readonly<Record<string, string>>,
  remote: readonly (Project & { satelliteId?: string; satelliteName?: string })[],
  links: readonly (readonly string[])[],
  keptSeparate: readonly string[],
): LinkSuggestion[] {
  const kept = new Set(keptSeparate);
  const out: LinkSuggestion[] = [];
  for (const l of local) {
    const key = localKeys[l.id];
    if (!key) continue;
    for (const r of remote) {
      if (r.repoKey !== key) continue;
      if (kept.has(pairKey(l.id, r.id))) continue;
      if (linkGroupOf(links, l.id)?.includes(r.id)) continue;
      out.push({ local: l, remote: r });
    }
  }
  return out;
}

/** Pairing visibility is local and never edits or tombstones the shared groups. */
export function useVisibleProjectLinks(): string[][] {
  const links = useNetworkSidebarStore((s) => s.links);
  const satellites = useAnnexClientStore((s) => s.satellites);
  return useMemo(() => {
    const paired = new Set(satellites.map((s) => s.id));
    return links.map((g) => g.filter((id) => !id.startsWith('remote||') || paired.has(id.split('||')[1])))
      .filter((g) => g.length > 1);
  }, [links, satellites]);
}

/** Every paired computer's projects, as its snapshot listed them; an unpaired computer's are left out. */
export function usePairedRemoteProjects(): Array<Project & { satelliteId?: string; satelliteName?: string }> {
  const satellites = useAnnexClientStore((s) => s.satellites);
  const satelliteProjects = useRemoteProjectStore((s) => s.satelliteProjects);
  return useMemo(() => satellites.flatMap((s) => satelliteProjects[s.id] ?? []), [satellites, satelliteProjects]);
}

/** This machine's projects' git remotes as keys, read again when its projects change; only while another computer is paired. */
export function useLocalRepoKeys(): Record<string, string> {
  const projects = useProjectStore((s) => s.projects);
  const paired = useAnnexClientStore((s) => s.satellites.length > 0);
  const [keys, setKeys] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!paired) { setKeys({}); return undefined; }
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.project.getRepoKeys()).then(
      (k) => { if (alive) setKeys(k ?? {}); },
      // telemetry-exempt: no keys, no suggestions
      () => { if (alive) setKeys({}); },
    );
    return () => { alive = false; };
  }, [projects, paired]);
  return keys;
}

/** Every suggestion now, from this machine's projects and every connected machine's. */
export function useLinkSuggestions(): LinkSuggestion[] {
  const projects = useProjectStore((s) => s.projects);
  const remote = usePairedRemoteProjects();
  const links = useVisibleProjectLinks();
  const keptSeparate = useNetworkSidebarStore((s) => s.keptSeparate);
  const keys = useLocalRepoKeys();
  return useMemo(
    () => linkSuggestions(projects, keys, remote, links, keptSeparate),
    [projects, keys, remote, links, keptSeparate],
  );
}
