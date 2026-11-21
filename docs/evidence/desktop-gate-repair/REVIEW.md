# Bounded stale-swap gate repair: independent review requested, NOT ACTIVE

Exact source branch auto-reset-policy-design/desktop-gate-stale-swap-repair
@4be6edfd3b87fd8434c62550ea17bffb8d356bec,
tree5d84bbae9f1bb4b19432e86291f4b9e85bf83009, based on
main5bbabde2d9f6dcb4db248d0976681fc331f5611e.
Review test/research/desktop-gate-repair/candidate.zsh, gate.patch,
original.zsh, test_gate.py and README.md. No script installation, live repair,
baseline reset/admission, heavy test bypass, app/provider work or PR here.
Root224e and host coordinator P1 are preserved separately.

## Executed evidence

Standalone project-owner-authorized LIGHT standard-library fake-resource
simulations only. The harness rewrites/asserts absent all four fixed live paths
in temporary candidate copies, fakes resources AND time, and runs only a
temporary sentinel-writing shell. No Vitest/tsc or real job is admitted.
Three qualification samples30s apart are simulated, not real live resource
sampling. Serial tests, no heavy worker pool or install/dependency mutation.

- Exact4be19tests PASS, unittest129.504s, command/exit0/raw retained.
- Three semantic mutants each produce the intended behavioral failure/exit1:
  missing raw nonincrease allows3945.10→3945.11; spread32→33 admits32.01drop;
  normal tolerance128→129 admits129MiB growth on a young baseline. Aggregate
  mutant driver exits0 only because ALL three were killed. Assertions fail on
  observed fake-child admission, not import/compile/targeting error.
- Each receipt embeds exact clean before/after head/tree, all five source hashes,
  sealer hash, command, exit, times, raw SHA. All source seals equal; live gate
  hash and baseline byte-hash/mtime are unchanged before/after every command.
- Initiala6fd6317358ce19d5a90fe3ee8e7df2878c72d22 full run retained:19tests,
 13failures, exit1. Fake top had a Python percent-format error, so refusal
  negatives from that run earn NO policy proof. Fix and stronger sampling-stage
  assertions are in source successor4be; initial source/history/evidence remain.

Original live61797476544935859d70911b17cab44fae4c2575180498ab6d9388a79f8fcf16
is preserved byte-exact. The tests NEVER execute the checked-in candidate with
its live paths; they use path-rewritten copies only. Mutant temporary files were
removed by the fixture; preserved reconstructions match the recorded executed
SHA256 bytes exactly, with old/new snippets and actual commands in mutants.json.
No retro-seal or claim of retained executed temp files.

## Specific review boundaries

Only sole swap_grew + baseline age>=1800s can enter the locked3-sample window.
Every existing guard is rechecked at each sample; raw swap nonincreasing/drop
<=32MiB, BOTH total paging deltas<=256pages/no resets, free swap>=1024MiB
each. Sensor/command failures and incomplete VM fields refuse conservatively.
No threshold or128MiB tolerance change, hold bypass, test-detector waiver,
reservation or retry-policy change. Stale compressor comment corrected to12GiB.

All qualification samples/deltas and old/new values log before replacement.
The same held slot covers staged rebase and FRESH ordinary predicate rerun.
Final refusal restores old baseline bytes AND mtime using own backup; tests
cover guards, unreadability/reset/total deltas after replacement. Any failed
rollback refuses and retains backup visibly; no child. Ordinary child failure
after successful admission retains that admitted baseline, preserving the old
meaning of last admission. No physical-IO/powerloss/interprocess CAS proof.
SIGKILL can leave a held slot as before; no automatic stale-slot deletion.

Dryrun is a single advisory read, no sleeps/logging/slot or baseline mutation,
no child, even for passing predicates or existing held slot. It cannot substitute
for future locked revalidation. Any activation/live sampling requires the
separate independent exact-diff QA and subsequent authorized step.

No root224e test/compiler/lint credit transfers from these simulations.
