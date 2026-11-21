# Independent QA: PR #3749 main daa7 merge

Reviewer: qa-details-local-composition. November 21, 2026.
Head: `2836db383fecc534291da596b9caa471cf10c44c` (`origin/details-local-composition/3733-main-daa7`, remote verified). It adds docs only on top of the merge `b28fbae691be9cab1286164b8970a1c9d12ac52c`, whose parents are `879064193` and `daa7dab5e` (`origin/main` matches).
Method: I read source and artifacts only and ran nothing.

## Verdict

**APPROVE the merge source.** The focused proof is **not green**: there is 1 failure in an unrelated group-project sim, recorded below as an unresolved observation. Hosted CI on the merged head is the gate.

## Merge

- **Against the automatic merge-tree,** the recorded merge differs only by the 3 conflict-marker lines in `binding-manager.ts`.
- **Against `daa7`,** the merge deletes 0 lines. Against `879`, it deletes only #3738's own change to `bind()`.
- **Imports are the union:** `createHash`, display-settings and `initializeBindingToolKey`.
- **Other files:** `bridge-server.test.ts` auto-merged. `package-lock.json` equals main's.

## Evidence (`evidence/3733-main-daa7/`)

- **Seals:** all 11 match. `validated-head` is `b28fbae69`, with an empty pre-status.
- **Typecheck and lint:** tsc exits 0. Lint has 0 errors and 793 warnings.
- **Focused run:** 70 files; **3056 passed, 6 skipped, 1 failed**; exit 1.
- **The failure:** `group-project-remote-create.sim.test.ts:338`, "a crash after the create but before its answer was saved still answers created after a restart (QA #3569)". It fails at `vi.waitFor(() => expect(startedOn.get('Studio')).toEqual([made.id]))`.
  - The sim file is unchanged by the merge and by #3738.
  - The #3733 stack changes no group-project production file between 69ef and b28; the only one touched is a test file, `group-project-tools.test.ts`. The failing assertion does not involve tool names.
  - Run alone, the same sim passes 23 of 23 on `b28fbae69` and on main.
  - This is the **second sighting** of an intermittent group-sim failure. The earlier one, before 3751, was unlogged. It is unclassified, so I am not calling it a flake or anything else. A likely hypothesis is recovery-start timing under multi-file load, against the default 1 s `waitFor`, but that is not proven.
  - It needs its own bounded diagnosis, which the owner is assigning.
- **Gap:** the focused run has a pre-status but no separate post-status file.
