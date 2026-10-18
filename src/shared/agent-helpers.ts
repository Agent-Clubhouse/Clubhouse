import type { DurableAgentConfig } from './types';

/**
 * Helpers (#2224): a helper is a durable agent whose `parentAgentId` names
 * another durable agent. These pure functions are shared by main and renderer.
 */

/** True when a durable agent has been disposed and must not spawn. */
export function isDisposedAgent(config: Pick<DurableAgentConfig, 'disposedAt'> | null | undefined): boolean {
  return !!config?.disposedAt;
}

/**
 * Why `childId` can't take `parentId` as its parent, or null when it can.
 * Rejects self-parenting, unknown agents and any link that would make the
 * child its own ancestor.
 */
export function parentLinkError(
  agents: ReadonlyArray<Pick<DurableAgentConfig, 'id' | 'parentAgentId'>>,
  childId: string,
  parentId: string,
): string | null {
  if (childId === parentId) return 'An agent cannot be its own parent';
  const byId = new Map(agents.map((a) => [a.id, a]));
  if (!byId.has(childId)) return 'Agent not found';
  if (!byId.has(parentId)) return 'Parent agent not found';
  const seen = new Set<string>();
  let cursor: string | undefined = parentId;
  while (cursor) {
    if (cursor === childId) return 'That parent would create a cycle';
    // A cycle already on disk must not hang the walk.
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentAgentId;
  }
  return null;
}
