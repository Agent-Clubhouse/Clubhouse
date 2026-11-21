# Independent QA: Q5 PR #3768 hosted G2/G4 verdict

Reviewer: qa-details-local-composition, November 21, 2026.

- **Source:** `0e6c898ada85efefb80bc3aec61e07d3d15d2b19`, which is the PR #3768 head. The PR is OPEN and in draft, based on `main`.
- **Owner bundle:** `d0c9e2a48`, `pr3768/hosted/`.
- **Method:** I fetched every hosted fact myself with `gh` (read only), not from the owner's bundle. I made no reruns and no writes.

## Bundle note (owner correction acknowledged)

- The `d0c9` manifest references four `.log` excerpts that **aren't committed**, because `.log` files are gitignored. Remote completeness and checkout-log credit for that **bundle** are withheld until the corrected immutable ref exists.
- The verdict below rests on my own `gh` retrieval, not on the missing files.

## Facts I retrieved with `gh`

- **Run `44926471482`:** Validate, `pull_request`, **attempt 1**, completed **success**, with `headSha` `0e6c898ad`.
- **Job `136913610220`**, "Unit + Component Tests (windows-latest, 2/2)": success. I fetched its log through the jobs logs API (1,578,584 bytes). It shows:
  - fetching `+a2b621bbd6790059d22abaae2ef519b747bb202e`, then `[new ref] a2b621bbd… -> pull/3768/merge`, then `git checkout --force refs/remotes/pull/3768/merge`, then `a2b621bbd…` printed at line 152;
  - Microsoft Windows Server 2025 10.0.26100. The runner image is `windows-2025-vs2026` version **20261116.315.1**. The provisioner agent version 20261111.635 is a different field.
  - `node-version: 22.23.4`, then `node: v22.23.4`.
- **Merge commit:** I fetched `a2b621bbd`. Its parents are **`f19eceee2`** (main, #3767) and **`0e6c898ad`**. All five index paths have blob IDs **equal** at `a2b621bbd` and `0e6c898ad`.
  - main `77fa09532..f19eceee2` adds only the owned-listener files, which don't overlap the index.
- **Artifacts:**
  - `14716349143` (`test-results-windows-latest-2`), API digest `sha256:7d06f09b…af87c`;
  - `14716785413` (`-1`), digest `sha256:9acd8a62…bc35`.

  Both belong to run `44926471482`, neither has expired, and the ZIPs I downloaded match those digests exactly.

## JUnit (parsed from my own downloads)

- **Shard 1:** no Q5 suite, and its green result isn't counted.
- **Shard 2:**
  - `pages.test.ts` has 39 cases: **37 passed, 2 skipped, 0 failures or errors.** The two skipped are exactly the explicit win32 predicates, "preserves native POSIX read-only reuse and actual sync" and "refuses an actual regular-file to FIFO swap without a blocking open".
  - `durability.test.ts` has 11 cases: **11 passed.**
  - **Total Q5: 48 passed and 2 expected platform skips.**
- **G2:** **exactly one** testcase, "lazy immutable notice index > native Windows reuse sync succeeds without platform or descriptor overrides", in shard 2 `pages.test.ts`. It has **no child elements**, so no failure, error or skip, and its time is 0.024 s. That makes it **present, passed and not skipped.**
- **G4:** all passed, with **no symlink EPERM, ENOTSUP or EACCES skips**:
  - directory or symlink replacement;
  - the unflushed-process barrier control;
  - failed reused-file sync with a retained prefix flush;
  - a symlink swap to the original inode;
  - a followed final symlink without `O_NOFOLLOW`;
  - own-temp cleanup after `beforePageRename`;
  - actual rename refusal against a conflicting directory;
  - prior-process temp after an actual temp-opened exit.
- **Correction in the owner's favour:** the bundle says JUnit captured no child stdout. In fact the barrier control's `system-out` **is** present. It shows, on Windows, the preparation child exiting **77**, then `pendingBeforeFlush 3`, `syncPosition 2` before `prefixPosition 3`, `pendingAfterFlush 0`, *"PASS: reused orphan earned file and prefix barriers"*, and the skip-dirty mutant child exiting with **code 2**. That is stronger raw native evidence than the bundle claims.

## Verdict

- **G2 PASSED** and **G4 PASSED** on the hosted Windows checkout of merge `a2b621bbd`, which contains `0e6c` plus `f19eceee2`.
- The five source hashes are verified equal to the reviewed assembly.
- **Limits that stay in place:**
  - The checkout is normal Actions attribution plus canonical git blobs, not an atomic hosted working-tree seal.
  - The filesystem type wasn't recorded, so NTFS is assumed but not observed.
  - **No credit** for FAT, network or `ino == 0` filesystems, native read-only attributes, deny-write sharing, power loss, the heap, the catalog, activation, R1, runtime or whole-Q5.
  - The native test emits no `directoryDurability`, so no directory-sync mode is inferred.
- **Before marking ready or landing:**
  - the final current-main guard, since main has moved to `f19eceee2` or later;
  - the corrected immutable evidence ref for the owner's bundle, which is the owner's completeness item and not a G2 or G4 blocker.
