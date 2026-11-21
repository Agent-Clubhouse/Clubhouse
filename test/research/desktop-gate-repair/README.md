# Isolated stale-swap gate repair candidate — NOT ACTIVE

Project-owner-authorized bounded repair only. Canonical live original SHA256
61797476544935859d70911b17cab44fae4c2575180498ab6d9388a79f8fcf16
is preserved byte-exact as original.zsh; candidate.zsh and gate.patch are for
independent exact-diff review. Neither script is installed by this branch/test.
No live baseline/slot/hold change, test admission, rerun or provider/app work.
Root-state224e and runtime P1 remain separate; their checks do not transfer here.

## Proposed rule

All ordinary guards,128MiB swap tolerance,4GiB targeted/6GiB compiler requests,
actual node test detection, explicit hold allowlists, heavy Swift predicate and
caller retry bounds remain. Header compressor comment is corrected to12GiB.
Sensor failures/malformed values now refuse conservatively rather than supply
a default zero. Extra counter/free-swap completeness is required for repair.

Only a sole swap_grew refusal with existing baseline age>=1800s may qualify.
While continuously holding the existing slot, use initial sample plus two
additional samples after30s sleeps. Every normal guard re-runs each time; only
the old swap baseline is excepted. Raw swap (not truncated) must never increase;
first-to-last drop<=32MiB; Pageouts AND Swapouts each never reset/decrease and
their entire-window deltas<=256pages; free swap>=1024MiB every sample. All
values/commands must be readable, required VM fields complete, counters bounded
integers. Counter comparisons use their full integer values, not per-step-only
deltas. Young/future/unreadable baseline age cannot qualify.

After qualification, log old/new baseline, all samples/guard values and total
paging deltas; logging failure refuses. Under the same slot, preserve original
baseline bytes/metadata in an own temporary backup, stage/rename the new integer
baseline, and obtain a FRESH normal resource observation. Re-run normal guards
with the unchanged128MiB tolerance. Revalidation also rejects unreadable repair
fields, free-swap failure, paging reset or total delta>256. Any such refusal
restores original baseline bytes AND mtime, removes only own temps and releases
the slot. A failed rollback is explicit refusal with the backup retained; never
run child on repair failure. No interprocess CAS or hardware/powerloss promise.
A SIGKILL can leave the existing slot held (unchanged single-owner limitation).

Only successful NORMAL revalidation reaches the existing baseline-before-child
START/child/END path. A child failure AFTER valid admission retains the newly
admitted baseline, as the original gate does; it is not a sampling failure.
No child invocation serves as a stability probe. No thresholds are relaxed.

--dry-run performs ONE advisory observation and age/slot read only. No mkdir,
trap cleanup, sleeps, logging, baseline writes or command invocation. Status0
means advisory predicates pass only; it never means admission and is no
substitute for normal locked qualification/revalidation.

## Deterministic light simulation

Run `python3 test/research/desktop-gate-repair/test_gate.py -v`, then the same
script with `--mutants`. These are standalone standard-library tests of private
TEMPORARY script copies. All four fixed live paths are rewritten and asserted
absent; fake top/vm_stat/sysctl/memory_pressure/ps/date/stat/sleep/tee resources
run in a private PATH. The sole child is a temporary sentinel shell, never real
Vitest/tsc or heavy work. Time advances only in the fake fixture. The tests do
not call/bypass the live gate. No package install/cache/production writes.

Controls include3samples30s apart under one slot, equality/one-over boundaries,
sole-failure/all-guards checks at each sample, raw fractional swap increase,
total paging/reset/unreadable controls, held slot ownership, fresh revalidation
with original-byte/mtime rollback, advisory-only dryrun and normal child status.
Temporary semantic mutants remove nonincrease, relax32→33MiB spread or change
normal128→129MiB tolerance. Each must fail its targeted behavioral test. Mutant
files never replace source. No real resource/production repair proof is inferred.

Status at initial source freeze: tests NOT RUN; independent exact review pending.
No activation or live rebase authorized by this candidate.
