import type { GroupProject, GroupProjectCoverage } from '../../../shared/group-project-types';
import type { GroupProjectsView } from './groupProjectsNavStore';

/** The parts of a project the directory needs to name and match groups. */
export interface DirectoryProject {
  id: string;
  name: string;
  displayName?: string;
}

/** One heading in the hub, with the groups under it. */
export interface DirectorySection {
  key: string;
  heading: string;
  /** Plain-text explanation under the heading, when the section's meaning isn't obvious from it. */
  note?: string;
  groups: GroupProject[];
}

export interface Directory {
  sections: DirectorySection[];
  /** Groups matching the search that the view leaves out (a project view only). */
  hiddenByView: number;
  /** Groups shown. */
  shown: number;
}

export const APP_WIDE_HEADING = 'App-wide';
export const NEEDS_REVIEW_HEADING = 'Needs scope review';
/** Said of a network copy of a project group: this computer can't tell which of its projects it covers. */
export const COVERAGE_NOT_VERIFIED = 'Coverage not verified on this computer';

export type ScopeKind = 'app' | 'project' | 'unresolved';

/** Legacy or missing scope is unresolved: no scope is inferred here. */
export function scopeKind(project: GroupProject): ScopeKind {
  const scope = project.scope;
  if (!scope || (scope.reach !== 'local' && scope.reach !== 'network')) return 'unresolved';
  if (scope.level === 'app') return 'app';
  if (scope.level === 'project' && typeof scope.projectId === 'string' && scope.projectId.trim()) return 'project';
  return 'unresolved';
}

/** A copy of a group another computer hosts. */
export function isReplica(project: GroupProject): boolean {
  return project.network?.role === 'replica';
}

export const projectLabel = (project: DirectoryProject) => project.displayName || project.name;

/** The main process's coverage read for each group, by group id. A group with no entry hasn't been checked yet. */
export type CoverageById = ReadonlyMap<string, GroupProjectCoverage>;

/**
 * Whether a group covers one of this computer's projects. A project-scoped group
 * this computer holds covers the project it names. Anything else covers a project
 * only through an explicit project link, which the main process reads (#3549); a
 * repository match never counts. A copy of another computer's group with no link
 * to the project is "no" only once its coverage was checked and this computer
 * can tell; until then, or when it can't, it is "not-verified".
 */
export function coverageOf(project: GroupProject, projectId: string, coverage?: CoverageById): 'covers' | 'not-verified' | 'no' {
  if (scopeKind(project) !== 'project') return 'no';
  if (!isReplica(project) && project.scope?.level === 'project') {
    // A project group this computer holds covers the project it names; a local-reach one covers nothing else.
    if (project.scope.projectId === projectId) return 'covers';
    if (project.scope.reach === 'local') return 'no';
  }
  // Anything else is judged by its links. With no read yet, or a failed one, that is "not verified", never "no".
  const view = coverage?.get(project.id);
  if (view?.copies.some((c) => c.thisComputer && c.projectId === projectId && c.state === 'verified')) return 'covers';
  return view && !view.localUnknown ? 'no' : 'not-verified';
}

/** "Covers Atlas, Atlas on Laptop." and, for copies this computer can't check, what isn't verified. Null when nothing is covered. */
export function coverageLine(coverage: GroupProjectCoverage | undefined): string | null {
  if (!coverage?.scoped) return null;
  const covered = coverage.copies.filter((c) => c.state === 'verified').map((c) => c.name);
  const unknown = coverage.copies.filter((c) => c.state === 'unknown').map((c) => c.name);
  const parts: string[] = [];
  if (covered.length) parts.push(`Covers ${covered.join(', ')}.`);
  if (unknown.length) parts.push(`${COVERAGE_NOT_VERIFIED}: ${unknown.join(', ')}.`);
  else if (coverage.localUnknown) parts.push(`${COVERAGE_NOT_VERIFIED}.`);
  return parts.join(' ') || null;
}

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Name order, with the id breaking ties so a row never moves between renders. */
export const compareGroups = (a: GroupProject, b: GroupProject) => byText(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const hostNameOf = (project: GroupProject) => project.hostName ?? 'This computer';

/** The words a search matches: name, description, the project it covers and its host. */
function searchText(project: GroupProject, projects: readonly DirectoryProject[]): string {
  const scope = project.scope;
  const local = scope?.level === 'project' && !isReplica(project) ? projects.find((p) => p.id === scope.projectId) : undefined;
  return [project.name, project.description, local ? projectLabel(local) : '', hostNameOf(project)].join('\n').toLowerCase();
}

export function matchesQuery(project: GroupProject, projects: readonly DirectoryProject[], query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = searchText(project, projects);
  return terms.every((term) => text.includes(term));
}

/**
 * Sections for the hub. All groups: one section per project, then app-wide, then
 * groups whose scope needs review. A project view: that project's groups, then
 * app-wide groups, then copies of other computers' project groups this computer
 * can't verify. The view only filters; it never changes a group's scope.
 */
export function buildDirectory(
  groups: readonly GroupProject[], projects: readonly DirectoryProject[], view: GroupProjectsView, query: string,
  coverage?: CoverageById,
): Directory {
  const matching = groups.filter((g) => matchesQuery(g, projects, query));
  const sections: DirectorySection[] = [];
  const add = (key: string, heading: string, list: GroupProject[], note?: string) => {
    if (list.length > 0) sections.push({ key, heading, ...(note && { note }), groups: [...list].sort(compareGroups) });
  };

  if (view.kind === 'project') {
    const project = projects.find((p) => p.id === view.projectId);
    const covering = matching.filter((g) => coverageOf(g, view.projectId, coverage) === 'covers');
    const appWide = matching.filter((g) => scopeKind(g) === 'app');
    const notVerified = matching.filter((g) => coverageOf(g, view.projectId, coverage) === 'not-verified');
    add(`project:${view.projectId}`, project ? projectLabel(project) : 'This project', covering);
    add('app', APP_WIDE_HEADING, appWide);
    add('not-verified', 'Copies from other computers', notVerified, `${COVERAGE_NOT_VERIFIED}. These cover a project on the computer that hosts them.`);
    const shown = covering.length + appWide.length + notVerified.length;
    return { sections, hiddenByView: matching.length - shown, shown };
  }

  const byProject = new Map<string, GroupProject[]>();
  const byHost = new Map<string, GroupProject[]>();
  const appWide: GroupProject[] = [];
  const review: GroupProject[] = [];
  for (const g of matching) {
    const kind = scopeKind(g);
    if (kind === 'unresolved') review.push(g);
    else if (kind === 'app') appWide.push(g);
    else if (isReplica(g)) byHost.set(hostNameOf(g), [...(byHost.get(hostNameOf(g)) ?? []), g]);
    else {
      const id = g.scope!.level === 'project' ? g.scope!.projectId : '';
      byProject.set(id, [...(byProject.get(id) ?? []), g]);
    }
  }
  const headed = [...byProject.entries()].map(([id, list]) => {
    const project = projects.find((p) => p.id === id);
    return { id, heading: project ? projectLabel(project) : 'Project not on this computer', list };
  }).sort((a, b) => byText(a.heading, b.heading) || (a.id < b.id ? -1 : 1));
  for (const { id, heading, list } of headed) add(`project:${id}`, heading, list);
  for (const host of [...byHost.keys()].sort(byText)) {
    const list = byHost.get(host)!;
    // Each row says what it covers. The section only says so while a copy's coverage hasn't been read.
    add(`host:${host}`, `Projects on ${host}`, list, list.some((g) => !coverage?.has(g.id)) ? `${COVERAGE_NOT_VERIFIED}.` : undefined);
  }
  add('app', APP_WIDE_HEADING, appWide);
  add('review', NEEDS_REVIEW_HEADING, review, 'Legacy groups with no scope. Their members are kept, and no scope is inferred.');
  return { sections, hiddenByView: 0, shown: matching.length };
}

/** "Scope: Atlas. Reach: This computer." in plain text. */
export function scopeReachLine(project: GroupProject, projects: readonly DirectoryProject[]): string {
  const kind = scopeKind(project);
  if (kind === 'unresolved') return 'Scope unresolved. Existing members kept.';
  const scope = project.scope!;
  const reach = scope.reach === 'local' ? 'This computer' : 'Network';
  if (kind === 'app') return `Scope: App-wide. Reach: ${reach}.`;
  const local = scope.level === 'project' && !isReplica(project) ? projects.find((p) => p.id === scope.projectId) : undefined;
  const name = local ? projectLabel(local) : isReplica(project) ? `a project on ${hostNameOf(project)}` : 'a project not on this computer';
  return `Scope: ${name}. Reach: ${reach}.`;
}
