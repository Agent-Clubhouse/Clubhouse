# Independent QA: desktop test gate stale-swap repair, exact diff

Reviewer: qa-details-local-composition, November 21, 2026.

- **Source:** `4be6edfd3b87fd8434c62550ea17bffb8d356bec`, tree `5d84bbae9f1bb4b19432e86291f4b9e85bf83009`, branch `origin/auto-reset-policy-design/desktop-gate-stale-swap-repair`.
- **Files:** under `test/research/desktop-gate-repair/`.
- **Script hashes (recomputed):** candidate `candidate.zsh` is sha256 `f80745f1…fdb4fd`; original `original.zsh` is `61797476…cf16`, equal to the live gate's recorded hash.
- **Evidence:** `5a6dd656a`, with `docs/evidence/desktop-gate-repair/`. All 12 manifest entries are ok.
- **My execution:** read-only host observations only (`top`, `memory_pressure`, `vm_stat`, `sysctl vm.swapusage`) to check output formats. **No gate run, no admission, no live change.**

## The approved rules: VERIFIED in the diff

- **Trigger:** the repair runs only when `reason` is exactly ` swap_grew=${base}->${swapmb}M`, so swap is the **only** failure. It also requires `baseline_age` of at least 1,800 s, taken from the `SWAPBASE` mtime, with an existing file, readable `date` and `stat`, and an age that isn't negative.
- **Samples:** with the **slot held**, sample 1 is the initial observation and samples 2 and 3 follow, each after `sleep 30`. An interrupted sleep refuses.
- **Each sample:**
  - the baseline is unchanged;
  - all normal guards are re-evaluated, and anything beyond `swap_grew` refuses;
  - `repair_sample_readable`: normal fields readable, all four `vm_stat` page lines present and canonical, decimal used and free swap, unsigned pageouts and swapouts, **free swap at least 1,024 MiB**, and counters at most 15 digits.
- **Stability:**
  - `current <= previous` and `first - current <= 32` on the raw decimal used swap. Together these make swap non-increasing with a spread of at most 32 MiB.
  - Pageouts and swapouts must not decrease (a reset refuses), and their cumulative deltas from the first sample are **each at most 256**.
- **After sampling:**
  1. The baseline mtime must be unchanged.
  2. `SWAP_REPAIR` is logged with the old and new values, the deltas and all samples. A log failure refuses.
  3. A `cp -p` backup preserves the bytes and mtime.
  4. The new baseline is staged in a temp file and moved into place.
  5. A **fresh** `read_sample` runs under the same slot. It must be readable, the counters are checked again over the whole window, and then the **normal** predicates run against the new base with the **unchanged +128** tolerance.
- **Rollback:** any refusal after the update makes `cleanup` move the backup back over `SWAPBASE`, restoring the original bytes and mtime. A failed rollback is reported and the backup is preserved. On admission, `repair_complete=1` and the backup is removed. A child failure after admission isn't treated as a repair failure.
- **Normal behaviour retained:** the slot, the explicit and allow holds, the heavy Swift hold, the other-test detection, every threshold, and the baseline write on admission, which now refuses if the write fails. A missing baseline still means first admission.
- **Dry run:** one read, then a check of the lock directory, then an advisory message. **It takes no slot, writes nothing, never sleeps and runs no child.** It prints the guards and baseline age and states that the real decision needs locked sampling.

## Tests (deterministic, with fake resources)

- 19 of 19 passed at `4be6edfd3` (129.5 s).
- They cover:
  - exact bounds;
  - a young baseline, which never samples;
  - an unreadable or future-dated baseline age;
  - the 128 tolerance unchanged;
  - non-increasing raw swap;
  - a spread of 33 refuses;
  - the window-wide paging limit;
  - a counter reset;
  - free swap checked in every sample;
  - every normal guard checked in each sample;
  - equality thresholds;
  - unreadable samples not treated as safe;
  - rollback of bytes and mtime after a post-repair refusal;
  - an interrupted sample or log failure leaving the baseline unchanged;
  - a held slot;
  - dry-run in every case;
  - an absent baseline;
  - a child failure.
- 3 mutants killed: tolerance relaxed from 128 to 129, spread relaxed from 32 to 33, and removing the non-increasing check.
- The initial fixture failure at `a6fd63173` (13 failed) is preserved as a fixture defect.
- The receipts record that the live gate hash and the baseline's bytes and mtime were unchanged before and after every command.

## Blocker R-1 (required, liveness): unit parsing is now fail-closed for every unit except M and G

- `tomb` parses only values ending in `G` or `M`.
- The new `read_sample` makes **`mb` (unused) and `compmb` (compressor)** mandatory unsigned integers. If either fails to parse, the result is `unreadable_sample` and the gate refuses.
- **The regression:** the original used `${compmb:-0}`, which never refused on a parse failure. If `top` ever reports the compressor as `0B`, `512K` or `1T`, or reports unused memory in `K` or `B`, **every admission refuses forever**. That's the same class of permanent refusal this repair exists to fix.
- Today's host output (`1115M compressor`, `7966M unused`) parses, but the tests only use `M`.
- **Fix:**
  - extend `tomb` to `B`, `K`, `M`, `G` and `T` (B rounds down to MiB, K divides by 1,024, T multiplies by 1,024×1,024);
  - **drop `mb` (unused) from the fail-closed set entirely**, since it only appears in the START log line and isn't a guard;
  - add fixture cases for `0B` and `512K` compressor values, an unused value in `K`, and an unparseable token, which still refuses for the compressor guard.

## Notes, not blockers

- A corrupt `SWAPBASE`, one that doesn't contain an unsigned integer, now refuses through `unreadable_sample` until the owner intervenes. That's acceptable fail-closed behaviour. Document the procedure: the owner inspects the file and records the action. No automatic reset.
- The extra post-repair counter check is stricter than approved, which is acceptable.

## Verdict

- **APPROVE the candidate's repair logic and rollback as matching the approved design, once R-1 is fixed.**
- After the R-1 change, give me the successor diff with the new fixture cases for a brief readback before live activation.
- No admission or waiver is granted, and no root or P1 proof is inferred.

## Safe activation and readback procedure, after the R-1 successor is approved

1. Freeze the exact approved candidate and record its sha256.
2. Confirm the live gate's sha256 is still `61797476…cf16`. Record `SWAPBASE`'s bytes, sha256 and mtime. Confirm no slot (`/tmp/clubhouse-desktop-test.lock` absent) and no active gate child.
3. Back up the live gate, preserving its mode, beside it.
4. Write the candidate to a temp file **in the same directory**, set the same mode, and `mv` it atomically over the live gate.
5. Read back the live gate's sha256, which must equal the approved candidate.
6. Run `--dry-run <owner> 4` once. Expect the advisory output with exit 75 or 0. Confirm `SWAPBASE`'s bytes and mtime are unchanged and no lock directory remains.
7. Make the first real admission through a normal caller at its usual cadence. Expect either `SWAP_REPAIR` followed by START in the gate log, or a typed refusal. Record the log lines and the new baseline.
8. **Rollback:** `mv` the backup over the live gate and read back `61797476…`. `SWAPBASE` is restored by the gate's own rollback, or left as written by a legitimate admission.
