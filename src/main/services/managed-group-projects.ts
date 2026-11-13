/**
 * Which group projects take their members from their membership record
 * (#3357). Sources that used to hold group-project memberships (canvas wires,
 * orchestrator connections) leave those group projects to the record. The
 * membership module installs the list; with none installed, nothing is
 * filtered.
 */

let managedGroupProjects: (() => Promise<ReadonlySet<string>>) | null = null;

/** Set by the membership module when its binding source is registered. */
export function setManagedGroupProjects(list: (() => Promise<ReadonlySet<string>>) | null): void {
  managedGroupProjects = list;
}

/** The group projects whose membership record holds their members; empty when none is installed. */
export async function managedGroupProjectIds(): Promise<ReadonlySet<string>> {
  return managedGroupProjects ? managedGroupProjects() : new Set();
}

/** Drop bindings to group projects whose membership record holds their members. */
export async function withoutManagedMembers<T extends { targetKind: string; targetId: string }>(bindings: T[]): Promise<T[]> {
  if (!managedGroupProjects || !bindings.some((b) => b.targetKind === 'group-project')) return bindings;
  const managed = await managedGroupProjects();
  return bindings.filter((b) => b.targetKind !== 'group-project' || !managed.has(b.targetId));
}
