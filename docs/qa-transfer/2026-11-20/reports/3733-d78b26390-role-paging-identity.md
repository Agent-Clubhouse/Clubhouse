# Independent QA: #14 role Connections paging, current-main identity bridge

Reviewer: qa-details-local-composition. November 21, 2026. I compared git trees and ancestry only and ran nothing.

## Verdict

**Identity CONFIRMED.** The approval at `dd4fe6694` (report `f0de12db5`, source `1bd612ca6`) carries over to `d78b26390f49b2048ff9859f7fb27d1310b5225c` without re-running anything, because the trees are identical. The owner may open the normal standalone PR. Hosted CI on that PR is the remaining gate.

## Checks

- `origin/details-local-composition/3733-role-paging-main` = `d78b26390`, and `origin/main` = `d991a39e7` (#3749 landed: "Compose #3733 remote Details parity (partial)…").
- **Ancestry:** `d78b26390` → `381f5e256` → `d991a39e7`, i.e. two picks directly on main. Main is an ancestor of the head.
- **Tree identities,** each `git diff --quiet` exiting 0:
  - `d991a39e7` (main) has the same tree as `2820e56dd`, the reviewed #3749 head the approved work was based on;
  - `381f5e256` has the same tree as `55ee36bfb`, the approved contract commit;
  - `d78b26390` has the same tree as `1bd612ca6`, the approved source.
- **Evidence applies:** the sealed evidence in `evidence/3733-role-paging/` on `dd4fe6694` was bound to `1bd612ca6`, which has an identical tree, so it applies unchanged to `d78b26390`. That evidence is 1206 passed across 11 files, tsc and lint 0, and 4 effective mutations. The new branch does not carry the evidence docs; they stay on `dd4fe6694`.

## Limits retained

- Connections-only role paging. **Role Actions paging stays deferred.**
- Targeted proof only. The two gaps stay open: the receipt-only renderer reset is not discriminated, and the authorize-before-parse order is verified from source only.
- The unpublished P7w source is not covered. Stale conflicts from the earlier held #3721 work are not evidence about it.
