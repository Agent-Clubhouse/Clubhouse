/**
 * Which group projects take their members from their membership record
 * (#3357). Sources that used to hold group-project memberships (canvas wires,
 * orchestrator connections) leave those group projects to the record. The
 * membership module installs the list; with none installed, nothing is
 * filtered.
 */

import { groupProjectHost } from './group-project-host';

let managedGroupProjects: (() => Promise<ReadonlySet<string>>) | null = null;

/** Set by the membership module when its binding source is registered. */
export function setManagedGroupProjects(list: (() => Promise<ReadonlySet<string>>) | null): void {
  managedGroupProjects = list;
}

/** The group projects whose membership record holds their members; empty when none is installed. */
export async function managedGroupProjectIds(): Promise<ReadonlySet<string>> {
  return managedGroupProjects ? managedGroupProjects() : new Set();
}

/**
 * Drop stored group project bindings whose agent was refused or moved out by
 * scope (#3355): excluded pairs aren't restored. Others are restores of pairs
 * that were members already, which scope never evicts. A failed check drops
 * the pair (fails closed).
 */
export async function withinScope<T extends { targetKind: string; targetId: string; agentId: string }>(bindings: T[]): Promise<T[]> {
  const kept: T[] = [];
  for (const b of bindings) {
    if (b.targetKind !== 'group-project' || await groupProjectHost.admits(b.targetId, b.agentId, { restore: true }).catch(() => false)) kept.push(b);
  }
  return kept;
}

/** Drop bindings to group projects whose membership record holds their members. */
export async function withoutManagedMembers<T extends { targetKind: string; targetId: string }>(bindings: T[]): Promise<T[]> {
  if (!managedGroupProjects || !bindings.some((b) => b.targetKind === 'group-project')) return bindings;
  const managed = await managedGroupProjects();
  return bindings.filter((b) => b.targetKind !== 'group-project' || !managed.has(b.targetId));
}
