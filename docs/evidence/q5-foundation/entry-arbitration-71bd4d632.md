# Journal entry arbitration: duplicate handles and queued settlement

Canonical issue #3758. Corrected source is
`71bd4d632e58161400d086fa2305ce45580cad60`, tree
`95d0c8e07d3ca08d7b0626942b9a498118dd0d28`, pushed on
`auto-reset-policy-design/q5-durable-delivery-ledger`.
Test-only baseline is `b8bd6c0e3ba26215a144115d2edbb4a880b49c0e`, tree
`3b7eace2f0c31482840855493a084a16222ec5b1`, pushed on
`auto-reset-policy-design/q5-entry-arbitration-baseline`.
Accepted6d/472 and earlier exact proofs remain unchanged.

## Reproduced gaps and ordering

The test-only baseline changes tests, not journal source, relative to6d.
Two focused controls actually fail: distinct captured handles both enter one
attempt; entry admitted while a pending unsubmitted commit awaits IO can leave
the same post ready afterward. The second control detects the invariant breach
`enteredDuringTransition:true, readyAfterTransition:true`; it does not mandate
a specific fix. These are isolated store controls, not observed app/provider
execution or a claim that the separate shared runtime fence is implemented.

Corrected entry has a synchronous attempt-wide check; two handles cannot both
enter. A settlement request synchronously increments an attempt-local entry
hold before enqueueing any asynchronous work. Recovery similarly holds all
entry. Capture and entry refuse while held; holds release in finally when the
queued transition completes or rejects. Reference counts retain overlapping
requests' holds. Entry before a settlement request remains irreversible:
existing G1 converts later unsubmitted to uncertain, including after handle
release. A requested unsubmitted transition wins against subsequent entry;
after committed release, only a new intent can establish fresh coverage.

Unrelated attempts remain admissible during attempt-local settlement. Genuine
already-entered ACKs keep their separate capability path and serialize behind
pending uncertainty; they are not blocked by entry holds. Recovered uncertainty
still cannot mint acknowledgement provenance. No physical send, runtime/session
generation, queue callback, recovery owner, or provider API was added here.

## Actual exact-head proof

| Exact source | Admitted check | Result |
| --- | --- | --- |
| b8bd6c0e3 | journal test filter `entry arbitration:` | exit1;2failed,19skipped;174ms |
| 71bd4d632 | entire changed journal suite, maxWorkers2 | exit0;24passed/1file;7.99s |
| 71bd4d632 | full root `tsc --noEmit -p tsconfig.json` | exit0 |
| 71bd4d632 | journal source/test ESLint | exit0;0errors/0warnings |

Current24 includes duplicate-handle, awaited-unsubmitted, immediate uncertain
and recovery admission holds, unrelated-attempt liveness, genuine late ACK,
persisted state reopening, and existing G1 guarded-vs-mutant child controls.
The baseline only executes its two new controls. No baseline compiler/lint or
new mutation mechanism is claimed. Root ES2020 config excludes tests; Vitest
transpilation is not a separate test typecheck. The Vite native-loader advisory
is preserved in raw test output; it was not suppressed.

All four commands were admitted sequentially inside desktop-test-gate (min4
tests/lint,min6 compiler); no refusals, retries, cancellations or bypass.
Each embedded receipt binds clean equal before/after head/tree and22 source
hashes, exact argv, timestamps, exit and raw SHA256. Raw child output and
observed gate output are retained beside each receipt; manifest indexes36
receipts total and preserves prior32 entries. Evidence packaging head is not
the tested source, and does not retro-seal prior work.

The byte-identical existing dependency cache was linked only in this worktree
with caches excluded; original node_modules is now restored. No installs,
shared dependency writes, access changes, app imports or activation occurred.
Independent review is required for the full arbitration/settlement/recovery
invariants. Lazy authoritative state, R1 activation, migration, runtime/phone,
IPC/UI, platform and product performance remain separate acceptance gates.
