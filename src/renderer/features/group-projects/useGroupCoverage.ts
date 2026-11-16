import { useEffect, useMemo, useState } from 'react';
import type { GroupProject, GroupProjectCoverage } from '../../../shared/group-project-types';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useNetworkSidebarStore } from '../../chrome/sidebar/networkSidebarStore';
import { useProjectStore } from '../../stores/projectStore';
import type { CoverageById } from './groupProjectsDirectory';

/**
 * The main process's verified coverage for every group (#3549), read again when
 * the groups, this computer's projects, project links or paired computers change.
 * Until the first read lands, and when a read fails, there is no entry, which the
 * directory shows as "not verified" and never as "covers" or "doesn't cover".
 */
export function useGroupCoverage(groups: readonly GroupProject[]): { coverage: CoverageById; failed: boolean } {
  const [list, setList] = useState<GroupProjectCoverage[]>([]);
  const [failed, setFailed] = useState(false);
  const links = useNetworkSidebarStore((s) => s.links);
  const satellites = useAnnexClientStore((s) => s.satellites);
  const projects = useProjectStore((s) => s.projects);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => window.clubhouse.groupProject.getCoverage()).then(
      (result) => { if (active) { setList(result ?? []); setFailed(false); } },
      // telemetry-exempt: no coverage is shown as not verified, and the next change reads again.
      () => { if (active) { setList([]); setFailed(true); } },
    );
    return () => { active = false; };
  }, [groups, links, satellites, projects]);

  const coverage = useMemo<CoverageById>(() => new Map(list.map((c) => [c.groupProjectId, c])), [list]);
  return { coverage, failed };
}
