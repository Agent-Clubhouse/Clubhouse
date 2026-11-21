# Independent QA: desktop gate activation outcome (durable verification)

Reviewer: qa-details-local-composition, November 21, 2026.

- **Evidence:** `cd587011b978e886f78866d8b10b5c841e5b8ec2`, tree `ef82623ff12893feae6dabd2cc14c99a8733075d`, on `origin/auto-reset-policy-design/desktop-gate-activation-evidence`, under `docs/evidence/desktop-gate-activation/outcome/`. All **16 manifest entries match** their committed blobs.
- **Independent of this:** my read-only check of the live host at about 19:23Z found the live gate at sha `d45cbfb0…`, mode 755, uid 501 and gid 20; the `…backup-61797476-20261121T191738Z` backup present; the `SWAP_REPAIR`, `START` and `END rc=0` log lines; a `SWAPBASE` of 3929; and the lock absent.

## Verified from the evidence

- **Activation:** authorized and scoped to the gate only. The prerequisites bind the pre-activation receipts for full23, original3 and the floor mutant. The rollback copy `rollback-original.zsh.txt` has sha `6179747654493585…`, the original.
- **Dry run:** at 19:18:15Z, `--dry-run q5-ledger 4` gave exit **75**, reporting *"guards= swap_grew=1812->3929M baseline_age_s=21627; … no slot/baseline/child changes"*. The before and after states are **identical**: gate sha `d45cbfb0…`, mode 493 (0755), baseline sha and mtime in ns, and the slot absent.
- **The gate's own log:**
  - `SWAP_REPAIR q5-ledger old=1812 new=3929 age_s=21764 pageouts_delta=0 swapouts_delta=0`, with sample 1 at used 3929.44 and free 1190.56;
  - `START` at 19:21:35Z;
  - `END rc=0` at 19:21:41Z.
- **After the caller ran:** source `224e0797d` clean, slot absent, live gate `d45cbfb0…`, backup `61797476…`, mode 0o755, dependencies restored, and the own-log sha recorded.
- **Root `224e` run, `root-224e/`:** exit 0 at head `224e0797d`. **4 test files and 50 tests passed.** Its 23 source hashes are equal before and after, which I recomputed against the committed maps.

## Verdict

- **Gate activation is VERIFIED durably.** It matches my independent live check.
- **The credit is limited:**
  - **Gate:** the repair is installed and working, and it admitted the first normal run.
  - **Root `224e`:** 50 passing tests at that exact head. That is test execution only.
- **Still needed:**
  - **Root `224e`:** type checks (min 6) and an 8-file lint (min 4) through the ordinary gate, then source acceptance review;
  - **P1:** its own exact-head gated tests, types, lint and mutants.
- The earlier exit-75 refusals stay recorded as NOT RUN. No waiver.
