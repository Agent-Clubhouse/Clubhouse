# Independent QA: desktop gate repair R1, memory units (exact readback)

Reviewer: qa-details-local-composition, November 21, 2026.

- **Source:** `274a39410c714931abfd38369d53b9101d5b60c5`, tree `e3ae0e77c55a1da6017ed3f85129e8a64bac85b6`, branch `desktop-gate-memory-units-r1`. Its parent is `4be6edfd3`.
- **Candidate:** sha256 **`d45cbfb0449abc1ce34bbc84960292dca70e6b551944beb9109b79d11fe9a7d3`**, which I recomputed.
- **Evidence:** `6c99d5fcb`, with `docs/evidence/desktop-gate-memory-r1/`. All 10 manifest entries are ok.
- **Method:** source read plus hashing. I ran no gate.

## Changes since `4be6edfd3` (in `candidate.zsh`): exactly the R-1 scope

- **`tomb`:**
  - accepts exactly **one** token matching `^[0-9]+([.][0-9]+)?[BKMGT]$` and converts binary units to MiB;
  - rounds up (**ceiling**), so 0B is 0, 512K is 1, 1G is 1,024, 1T is 1,048,576, and **12 GiB + 1 B gives 12,289, which refuses** against the guard `> 12288`;
  - for any other input (empty, more than one line, an unknown unit, negative or overflowing), exits 1.

  Ceiling rounding is the conservative choice for an upper-bound guard.
- **`compmb=$(tomb "$comp") || reads_ok=0`:** an unparseable compressor value makes the sample unreadable and **refuses at every stage**: initial, repair samples and the post-repair check.
- **`unused`** is diagnostic only. It is validated by the same token regex and otherwise set to `unknown`, and it is **removed** from the fail-closed set. Available memory still comes from `vm_stat`.
- Nothing else changes. The swap parse still requires the `M` suffix, and `sysctl vm.swapusage` always prints `%.2fM`, so that is safe.

## The corrupt-baseline procedure is documented (README "Corrupt saved baseline")

- A corrupt baseline refuses as unreadable and is never auto-repaired, deleted, reset or treated as absent.
- The owner inspects it without changing it, records the bytes, hash, mtime, script identity and observed state, and preserves the file.
- No manual reset is authorized. That is ACCEPTED.

## Evidence (hashing only)

- **`selected-tests`** at `274a39410`: 7 of 7 passed.
  - new unit and over-limit-fraction cases;
  - 0B and KiB compressor and unused values through the full repair;
  - unused as diagnostic with an unknown fallback;
  - an unparseable compressor failing closed at every stage;
  - success with exact bounds and locked revalidation;
  - normal threshold equality;
  - dry run.

  Before and after: same head, tree and sources, clean, with `liveGateUnchanged` and `liveBaselineUnchanged` both true.
- **`ceil-mutant`:** a floor-rounding mutant **admits** an over-limit `0.011718750001T` compressor (`START … comp=0.011718750001T`) and fails 5 assertions. It is killed, and the live gate and baseline are unchanged.
- **Gap:** only 7 of the **23** tests ran at the final head. The original 19 tests and 3 mutants are proof for `4be` only, and the parse change touches `read_sample`, which every test uses.

## Verdict

- **APPROVE candidate `d45cbfb0…a9a7d3` (source `274a39410`)** as the final repair logic. R-1 is resolved, and the boundary conversion is conservative.
- **One precondition before activation (light, fake resources only):** run the **full** `test_gate.py` (23 tests), plus the 3 original mutants (tolerance 129, spread 33, no non-increasing check) and the floor mutant, **on exact `274a39410`**. Record them with the same receipt format and with live-gate and baseline-unchanged seals.
  - If they're green, no further QA round is needed. I'll accept the receipt by hash readback.
  - If anything fails, it comes back for review.
- **Activation:** follow the procedure from my `ad85eff9` report, steps 1 to 8, using the candidate sha `d45cbfb0…a9a7d3`. Step 2 confirms the live gate is still `61797476…`, records the `SWAPBASE` bytes, sha and mtime, and confirms no slot and no child. Step 5 reads back `d45cbfb0…`. Step 6 is the dry-run check that the baseline is unchanged.
- No admission, waiver, root or P1 proof is inferred.

## Addendum: precondition receipts accepted by hash readback (`b2086475d`, tree `7ab712bff`)

- **Location:** `origin/auto-reset-policy-design/desktop-gate-activation-evidence`, under `docs/evidence/desktop-gate-activation/preconditions/`. All 10 manifest entries match their committed blobs.
- **`full23`:** head `274a39410`, candidate `d45cbfb0…`. **Ran 23 tests in 168.659 s, OK**, exit 0.
- **`original3`:** at the same head. All three mutants are **killed** with exit 1 and `FAILED (failures=1)`: remove non-increasing, relax spread from 32 to 33, and relax tolerance from 128 to 129. The driver exited 0.
- **`floor`:** the floor-pressure MiB mutant is **killed** with exit 1 and `FAILED (failures=5)`. The driver exited 0.
- **All receipts:** `sourceSealEqual`, `liveGateUnchanged` and `liveBaselineUnchanged` are all **true**.
- **The precondition is MET.** Activation may proceed under the conditional authorization, following the `ad85eff9` procedure with candidate `d45cbfb0…a9a7d3`. Any mismatch stops for review.
