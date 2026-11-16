import { useEffect, useMemo, useRef, useState } from 'react';
import type { GroupProject, GroupProjectCoverage } from '../../../shared/group-project-types';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useNetworkSidebarStore } from '../../chrome/sidebar/networkSidebarStore';
import { useProjectStore } from '../../stores/projectStore';
import type { CoverageById } from './groupProjectsDirectory';

/** Computers connecting and disconnecting come in bursts: read once they settle. */
const SETTLE_MS = 250;

/**
 * Reads coverage from the main process, again when the groups, this computer's
 * projects, project links or paired computers change. Until the first read
 * lands, and when a read fails, there is no result, which callers show as "not
 * verified" and never as "covers" or "doesn't cover".
 */
function useCoverageRead(read: () => Promise<GroupProjectCoverage[]>, refresh: readonly unknown[]): { list: GroupProjectCoverage[]; failed: boolean } {
  const [list, setList] = useState<GroupProjectCoverage[]>([]);
  const [failed, setFailed] = useState(false);
  const links = useNetworkSidebarStore((s) => s.links);
  const satellites = useAnnexClientStore((s) => s.satellites);
  const projects = useProjectStore((s) => s.projects);
  const first = useRef(true);

  useEffect(() => {
    let active = true;
    const run = () => {
      Promise.resolve().then(read).then(
        (result) => { if (active) { setList(result ?? []); setFailed(false); } },
        // telemetry-exempt: no coverage is shown as not verified, and the next change reads again.
        () => { if (active) { setList([]); setFailed(true); } },
      );
    };
    const delay = first.current ? 0 : SETTLE_MS;
    first.current = false;
    const timer = setTimeout(run, delay);
    return () => { active = false; clearTimeout(timer); };
    // `read` is a fresh closure each render; the triggers below are what change what it returns.
  }, [...refresh, links, satellites, projects]);

  return { list, failed };
}

/** Every group's coverage, by group id, for the hub. */
export function useGroupCoverage(groups: readonly GroupProject[]): { coverage: CoverageById; failed: boolean } {
  const { list, failed } = useCoverageRead(() => window.clubhouse.groupProject.getCoverage(), [groups]);
  const coverage = useMemo<CoverageById>(() => new Map(list.map((c) => [c.groupProjectId, c])), [list]);
  return { coverage, failed };
}

/** One group's coverage for its Members section; `refresh` changes when its membership does. */
export function useOneGroupCoverage(groupProjectId: string, refresh: unknown): GroupProjectCoverage | undefined {
  const { list } = useCoverageRead(() => window.clubhouse.groupProject.getCoverage(groupProjectId), [groupProjectId, refresh]);
  return list.find((c) => c.groupProjectId === groupProjectId);
}
