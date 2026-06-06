/**
 * Selection-persistence logic for the git diff views.
 *
 * Both the canvas widget and the sidebar/main panel poll `git.info()` on an
 * interval. A transient or failed read can return an empty (or briefly
 * incomplete) status snapshot. Dropping the user's file selection on any single
 * such poll resets the diff view to "Select a file" while they're still looking
 * at it. This helper keeps the decision pure and well-tested.
 */

export interface SelectionPersistenceResult {
  /** Whether the current selection should be cleared. */
  drop: boolean;
  /** Updated count of consecutive polls in which the file was absent. */
  misses: number;
}

/**
 * Decide whether a background status poll should drop the current file
 * selection. The selection is only dropped once the file has been absent from a
 * non-empty status across two consecutive polls; empty snapshots are treated as
 * transient reads and never drop the selection.
 */
export function evaluateSelectionPersistence(
  status: Array<{ path: string }>,
  selectedFile: string | null,
  consecutiveMisses: number,
): SelectionPersistenceResult {
  if (!selectedFile) return { drop: false, misses: 0 };
  if (status.some((f) => f.path === selectedFile)) return { drop: false, misses: 0 };
  // Empty snapshots are almost always transient (failed/partial read) — ignore.
  if (status.length === 0) return { drop: false, misses: consecutiveMisses };
  const misses = consecutiveMisses + 1;
  return { drop: misses >= 2, misses };
}
