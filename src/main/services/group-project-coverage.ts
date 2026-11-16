/**
 * Verified network project coverage for group projects (#3549).
 *
 * A project group covers its own project and the copies of it that the person
 * linked by hand (explicit project links, #3546). A shared repository never
 * adds a copy: it is reported as a match so the person can be offered a link.
 * A copy this computer can't check right now (offline, snapshot incomplete) is
 * "unknown", never "not covered". Members, the create preview and the
 * directory all read this one rule.
 */
import type { CoverageCopy, GroupProject, GroupProjectCoverage, GroupProjectScope } from '../../shared/group-project-types';
import { projectLinkPairKey, type NetworkProjectRef } from '../../shared/project-links';
import { projectLinksStore } from './project-links-store';
import { linkedProjectCopies, verifyCopy } from './group-project-linked-agents';
import { groupProjectHost } from './group-project-host';
import * as projectStore from './project-store';
import { repoKeysFor } from './project-repo-keys';
import { projectLinksSyncedWith } from './project-links-network';
import { appLog } from './log-service';

type Satellites = Parameters<typeof verifyCopy>[1];
interface LocalProject { id: string; name: string; displayName?: string; path: string }

export interface CoverageInputs {
  groupProjectId: string;
  scope: GroupProjectScope | undefined;
  /** A copy of another computer's group project. */
  replica: boolean;
  /** The machine whose project the scope names: this computer unless a replica. */
  host: string | null;
  self: string | null;
  isMember: (machine: string) => boolean;
  /** Whether this computer's link records are known to include that machine's (a full link sync succeeded). */
  linksSynced: (machine: string) => boolean;
  projects: readonly LocalProject[];
  satellites: Satellites;
  repoKeys: Readonly<Record<string, string>>;
}

const labelOf = (p: LocalProject) => p.displayName || p.name;

const NOT_SCOPED = (groupProjectId: string): GroupProjectCoverage => ({
  groupProjectId, scoped: false, copies: [], localUnknown: false, complete: true, repositoryMatches: [],
});

/** The pairs the person told this computer to keep apart or unlink, read once for a group's matches. */
function separatedPairs(): Set<string> {
  return new Set(projectLinksStore().records().filter((r) => !r.linked).map((r) => projectLinkPairKey(...r.projects)));
}

export function computeCoverage(i: CoverageInputs): GroupProjectCoverage {
  const scope = i.scope;
  if (scope?.level !== 'project') return NOT_SCOPED(i.groupProjectId);
  const local = new Map(i.projects.map((p) => [p.id, p]));
  const copies: CoverageCopy[] = [];
  const finish = (localUnknown: boolean, repositoryMatches: GroupProjectCoverage['repositoryMatches'] = []): GroupProjectCoverage => ({
    groupProjectId: i.groupProjectId, scoped: true, copies, localUnknown, repositoryMatches,
    complete: !localUnknown && copies.every((c) => c.state === 'verified'),
  });
  const thisComputer = (copy: NetworkProjectRef): CoverageCopy | null => {
    const project = local.get(copy.projectId);
    return project ? { machine: copy.machine, projectId: copy.projectId, name: labelOf(project), thisComputer: true, state: 'verified' } : null;
  };
  const other = (copy: NetworkProjectRef): CoverageCopy => {
    const { name, verified } = verifyCopy(copy, i.satellites, i.isMember);
    return { machine: copy.machine, projectId: copy.projectId, name, thisComputer: false, state: verified ? 'verified' : 'unknown' };
  };

  if (!i.replica) {
    // The group's own project is always covered. Links only extend a network group, as agent membership does.
    const own = i.self ? thisComputer({ machine: i.self, projectId: scope.projectId }) : null;
    if (own) copies.push(own);
    if (scope.reach !== 'network') return finish(false);
    try {
      for (const copy of linkedProjectCopies(i.self, scope.projectId)) {
        const entry = copy.machine === i.self ? thisComputer(copy) : other(copy);
        if (entry) copies.push(entry);
      }
    } catch (error) { // telemetry-exempt: logged by linksUnreadable; coverage is shown as not verified
      return linksUnreadable(i, error, finish);
    }
    return finish(false);
  }

  // A copy of another computer's group names that computer's project. This computer's
  // projects are covered only where a link joins them to it.
  if (!i.host || !i.self) return finish(true);
  const hostRef = { machine: i.host, projectId: scope.projectId };
  const hostView = verifyCopy(hostRef, i.satellites, i.isMember);
  copies.push({ machine: i.host, projectId: scope.projectId, name: hostView.name, thisComputer: false, state: hostView.verified ? 'verified' : 'unknown' });
  try {
    for (const copy of linkedProjectCopies(i.host, scope.projectId)) {
      const entry = copy.machine === i.self ? thisComputer(copy) : other(copy);
      if (entry) copies.push(entry);
    }
  } catch (error) { // telemetry-exempt: logged by linksUnreadable; coverage is shown as not verified
    return linksUnreadable(i, error, finish);
  }
  const linkedHere = new Set(copies.filter((c) => c.thisComputer).map((c) => c.projectId));
  const hostKey = hostView.project?.repoKey;
  const candidates = hostKey ? i.projects.filter((p) => !linkedHere.has(p.id) && i.repoKeys[p.id] === hostKey) : [];
  const separated = candidates.length ? separatedPairs() : new Set<string>();
  const repositoryMatches = candidates
    .filter((p) => !separated.has(projectLinkPairKey(hostRef, { machine: i.self!, projectId: p.id })))
    .map((p) => ({ projectId: p.id, name: labelOf(p) }));
  // No link here is "not covered" only when this computer's link records are known to include the host's:
  // connected, a network member, and a full link sync done. A lagging sync or an old peer leaves it unknown.
  const linksKnown = hostView.sat?.state === 'connected' && i.isMember(i.host) && i.linksSynced(i.host);
  return finish(linkedHere.size === 0 && !linksKnown, repositoryMatches);
}

function linksUnreadable(i: CoverageInputs, error: unknown, finish: (unknown: boolean) => GroupProjectCoverage): GroupProjectCoverage {
  // telemetry-exempt: the directory shows coverage as not verified, and the read can be retried
  appLog('core:group-project', 'warn', 'Project links could not be read for coverage', { meta: { error: String(error), groupProjectId: i.groupProjectId } });
  return finish(true);
}

type Environment = Pick<CoverageInputs, 'self' | 'isMember' | 'linksSynced' | 'projects' | 'satellites' | 'repoKeys'>;

/** Repository keys are read only when a copy of another computer's group needs them: they run git. */
async function environment(needRepoKeys: boolean): Promise<Environment> {
  const [projects, { getSatellites }] = await Promise.all([projectStore.list(), import('./annex-client')]);
  return {
    self: groupProjectHost.selfMachine(),
    isMember: (machine) => groupProjectHost.isNetworkMember(machine),
    linksSynced: projectLinksSyncedWith,
    projects, satellites: getSatellites(), repoKeys: needRepoKeys ? await repoKeysFor(projects) : {},
  };
}

const inputsFor = (gp: Pick<GroupProject, 'id' | 'scope' | 'host' | 'network'>, env: Environment): CoverageInputs => {
  const replica = gp.network?.role === 'replica';
  return { ...env, groupProjectId: gp.id, scope: gp.scope, replica, host: replica ? gp.host?.machine ?? null : env.self };
};

export async function describeCoverage(gp: GroupProject): Promise<GroupProjectCoverage> {
  return computeCoverage(inputsFor(gp, await environment(gp.network?.role === 'replica')));
}

/** The same read for a scope not yet created (the create preview). */
export async function previewCoverage(scope: GroupProjectScope): Promise<GroupProjectCoverage> {
  return computeCoverage(inputsFor({ id: 'preview', scope, host: undefined, network: undefined }, await environment(false)));
}

/** Every group's coverage, or just the one named. */
export async function listCoverage(groupProjectId?: string): Promise<GroupProjectCoverage[]> {
  const groups = (await groupProjectHost.list()).filter((gp) => groupProjectId === undefined || gp.id === groupProjectId);
  const env = await environment(groups.some((gp) => gp.network?.role === 'replica'));
  return groups.map((gp) => computeCoverage(inputsFor(gp, env)));
}
