import type { McpCatalogArg, McpCatalogEntry, McpCatalogEntryWithState, WrapperCatalogSnapshot } from './types';

function argsEqual(a?: McpCatalogArg[], b?: McpCatalogArg[]): boolean {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((arg, i) => arg.name === b[i].name && arg.required === b[i].required && arg.description === b[i].description);
}

/**
 * Compute per-entry diff state for the wrapper catalog picker.
 * - new: in current, not in snapshot
 * - changed: id matches, name, description, or args differ from snapshot
 * - removed: in selection (projectDefaults or anyAgentMcpIds) and not in current — appended at end
 * - stable: else
 *
 * Removed entries are appended only when the user has a selection on them.
 */
export function computeCatalogDiff(
  current: McpCatalogEntry[],
  snapshot: WrapperCatalogSnapshot | undefined,
  projectDefaults: string[],
  anyAgentMcpIds: string[],
): McpCatalogEntryWithState[] {
  // Dedupe by id (last wins) so callers don't have to enforce uniqueness.
  const dedupedCurrent = Array.from(new Map(current.map((e) => [e.id, e])).values());

  const snap = snapshot?.lastSeenCatalog ?? [];
  const snapById = new Map(snap.map((entry) => [entry.id, entry]));
  const currentIds = new Set(dedupedCurrent.map((entry) => entry.id));
  const selected = new Set([...projectDefaults, ...anyAgentMcpIds]);

  const out: McpCatalogEntryWithState[] = dedupedCurrent.map((entry) => {
    const prev = snapById.get(entry.id);
    if (!prev) return { ...entry, state: 'new' };
    if (prev.description !== entry.description || prev.name !== entry.name || !argsEqual(prev.args, entry.args)) return { ...entry, state: 'changed' };
    return { ...entry, state: 'stable' };
  });

  for (const prev of snap) {
    if (!currentIds.has(prev.id) && selected.has(prev.id)) {
      out.push({ ...prev, state: 'removed' });
    }
  }

  return out;
}
