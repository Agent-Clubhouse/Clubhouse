import type { GroupProject } from '../../../shared/group-project-types';
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

/**
 * Whether a group is verified to cover a project, from what this computer can
 * check: a project-scoped group this computer holds covers the project it names.
 * A copy of another computer's group names that computer's project id, which
 * means nothing here; matching it to a local project is by repository key in the
 * main process, and no renderer check exists yet.
 *
 * TODO(#3549): verified network coverage. Until then a copy is only ever
 * "not verified" (see COVERAGE_NOT_VERIFIED), never "covers" or "doesn't cover".
 */
export function coverageOf(project: GroupProject, projectId: string): 'covers' | 'not-verified' | 'no' {
  if (scopeKind(project) !== 'project') return 'no';
  if (isReplica(project)) return 'not-verified';
  return project.scope?.level === 'project' && project.scope.projectId === projectId ? 'covers' : 'no';
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
 * app-wide groups, then copies of other computers' project groups, which can't be
 * verified here. The view only filters; it never changes a group's scope.
 */
export function buildDirectory(
  groups: readonly GroupProject[], projects: readonly DirectoryProject[], view: GroupProjectsView, query: string,
): Directory {
  const matching = groups.filter((g) => matchesQuery(g, projects, query));
  const sections: DirectorySection[] = [];
  const add = (key: string, heading: string, list: GroupProject[], note?: string) => {
    if (list.length > 0) sections.push({ key, heading, ...(note && { note }), groups: [...list].sort(compareGroups) });
  };

  if (view.kind === 'project') {
    const project = projects.find((p) => p.id === view.projectId);
    const covering = matching.filter((g) => coverageOf(g, view.projectId) === 'covers');
    const appWide = matching.filter((g) => scopeKind(g) === 'app');
    const notVerified = matching.filter((g) => coverageOf(g, view.projectId) === 'not-verified');
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
    add(`host:${host}`, `Projects on ${host}`, byHost.get(host)!, `${COVERAGE_NOT_VERIFIED}.`);
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
