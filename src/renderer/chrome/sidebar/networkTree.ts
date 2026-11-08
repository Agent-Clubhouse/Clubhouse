/**
 * The sidebar across machines (#3065): every machine's projects in one list,
 * grouped by project. Linked projects (#3066), the same project on two
 * machines say, show as one group with every machine's agents in it; each
 * agent still runs on its own machine. The Show filter narrows the list to one
 * machine. Only the display changes: projects, agents and their machines are
 * as they were.
 */

import type { Project } from '../../../shared/types';

/** Show every machine, only this one, or one other machine by its id. */
export type ShowFilter = 'all' | 'local' | string;

export interface NetworkProjectsInput<P extends Project> {
  /** This machine's projects, in the sidebar's order. */
  local: readonly P[];
  /** Each other machine's projects, by machine id, in that machine's order. */
  remote: Readonly<Record<string, readonly P[]>>;
  /** Machine ids in the order their projects follow this machine's (by name, say). */
  machineOrder: readonly string[];
  /** Groups of linked project ids. */
  links: readonly (readonly string[])[];
  show: ShowFilter;
  /** The machine a project is on: null for this one. */
  machineOf: (projectId: string) => string | null;
}

export interface NetworkProjects<P extends Project> {
  /** One entry per group, under its first project's id: this machine's, when it has one. */
  projects: P[];
  /** The project ids each entry stands for, the entry's own first. */
  members: Record<string, string[]>;
}

/** The link group a project is in, if any. */
export function linkGroupOf(links: readonly (readonly string[])[], projectId: string): readonly string[] | undefined {
  return links.find((group) => group.includes(projectId));
}

export function buildNetworkProjects<P extends Project>(input: NetworkProjectsInput<P>): NetworkProjects<P> {
  const shown = (p: P) => {
    if (input.show === 'all') return true;
    const machine = input.machineOf(p.id);
    return input.show === 'local' ? machine === null : machine === input.show;
  };
  const ordered = [
    ...input.local,
    ...input.machineOrder.flatMap((m) => input.remote[m] ?? []),
  ].filter(shown);
  const byId = new Map(ordered.map((p) => [p.id, p]));
  const placed = new Set<string>();
  const projects: P[] = [];
  const members: Record<string, string[]> = {};
  for (const project of ordered) {
    if (placed.has(project.id)) continue;
    const group = (linkGroupOf(input.links, project.id) ?? [project.id]).filter((id) => byId.has(id));
    // Shown under the first of its projects in the list, which is this machine's when there is one.
    const ids = [project.id, ...group.filter((id) => id !== project.id)];
    for (const id of ids) placed.add(id);
    projects.push(project);
    members[project.id] = ids;
  }
  return { projects, members };
}

/** Link two projects, or the groups they're in, into one. */
export function mergeLinks(links: readonly (readonly string[])[], a: string, b: string): string[][] {
  const groupA = linkGroupOf(links, a) ?? [a];
  const groupB = linkGroupOf(links, b) ?? [b];
  const merged = [...new Set([...groupA, ...groupB])];
  return [...links.filter((g) => g !== groupA && g !== groupB).map((g) => [...g]), merged];
}

/** Split a group back into its projects. */
export function splitLinks(links: readonly (readonly string[])[], projectId: string): string[][] {
  const group = linkGroupOf(links, projectId);
  return links.filter((g) => g !== group).map((g) => [...g]);
}

/** A pair's key, the same either way round. */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('\n');
}

/** Every pair in a group, as keys. */
export function groupPairs(group: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) out.push(pairKey(group[i], group[j]));
  return out;
}

/** Links with projects that are gone taken out, and groups left with one project dropped. */
export function pruneLinks(links: readonly (readonly string[])[], exists: (projectId: string) => boolean): string[][] {
  return links.map((g) => g.filter(exists)).filter((g) => g.length > 1);
}
