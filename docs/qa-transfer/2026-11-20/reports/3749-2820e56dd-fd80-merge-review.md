# Independent QA: PR #3749 main fd80 merge

Reviewer: qa-details-local-composition. November 21, 2026.
Head: `2820e56dd6d345bea7377d7c8b43f42bab6d8c87` (`origin/details-local-composition/3733-main-fd80`, remote verified). It adds docs only on top of the merge `3a23aec18597115238f98d0fbf99ae7bb8a9a172`, whose parents are `33cfd9cf0` (the current PR head) and main `fd80a1c58` (#3753 P7 and #3754 L1; `origin/main` matches).
Method: I read source and committed artifacts only, ran nothing, and had no access to the host-local originals.

## Verdict

**APPROVE the bounded merge.** The ordinary descendant update can follow once run 44882652217 completes, as you said. This is targeted proof only: not the full suite and not hosted. The original sim trigger is still unknown.

## Merge

- **Identical to the automatic `merge-tree` result,** with no conflicts. `package-lock.json` equals both parents'.
- **Nothing dropped:**
  - `annex-client.ts` and `shared/types.ts` delete 0 lines relative to either parent.
  - `group-project-remote-create.ts` deletes only the PR side's old `.catch(() => null)` line, which #3754 replaced.
- **`shared/types.ts`:** #3753 adds `via?: 'direct' | 'reverse'` inside `AnnexDirection` (:1342). The #3733 Details fields `snapshotReceipt` and `connectionGeneration` stay on `SatelliteConnection` (:1390/:1392). These are separate interfaces with no overlap.
- **Fences retained in the merge:**
  - wake `connectionAttempt` ×5 and the clock-only retry;
  - Details O1 `invalidateSnapshotAdmission(sat, receipt)` ×2;
  - the P2 `annex-routes.ts`;
  - the #3754 thrown-lookup-stays-pending fix.

## Evidence (`evidence/3733-main-fd80/`)

- **Committed copies:** all 8 match `SHA256SUMS`. The raw host-local hashes are listed separately and cannot be verified here.
- **Head:** `validated-head` is `3a23aec18`.
- **Status:** pre-status is empty, and a clean post-status is printed at the end of `focused.txt`.
- **Focused run:** **14 files, 1683 passed**, exit 0.
- **Typecheck and lint:** tsc exits 0. Lint has 0 errors and 793 warnings.
- **Store:** `store-before` and `store-after` are identical (`node_modules` mtime 00:04:05, `.cache` 02:40:30, 0 entries). This is consistent with the isolated per-entry dependency links, so the run left the shared store untouched.

## Limits

- No full suite and no hosted run.
- A single parallel sim pass does not establish the original trigger.
- Run 44882652217 on `33cfd9cf0` is untouched.
- The #3720 rename-contract pause is separate.
