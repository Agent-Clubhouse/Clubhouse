# #3772 bounded assertion-cost candidate

**Fixture-only candidate awaiting independent delta review.** Existing PR #3772
remains at `0e779377f19e2c40347e983dd81ea752637a61d1`; this separate review ref
does not update it or rerun the failed workflow.

Executed candidate `869b9d74670db3f3fcfda359e4b25177c9afcd33`,
tree `8444e6f88e46d519b78c85fbb04b0df85a49be5d`, changes exactly one line in
`src/main/services/handoff-transfer-source.test.ts`: the final aggregate
`expect(Buffer.concat(chunks)).toEqual(f.bytes)` becomes
`expect(Buffer.concat(chunks).equals(f.bytes)).toBe(true)`.
Every chunk SHA256, offset, eof, bound, verification/open/close assertion and
existing timeout remains unchanged. No production handoff, consumer, workflow,
dependency, compiler option or permission change is made.

## Original hosted gate, preserved

[Validate 44966571904](https://github.com/Agent-Clubhouse/Clubhouse/actions/runs/44966571904)
failed on approved PR head `0e779377f…`: 32 successful jobs, four skipped,
one failed. Windows unit/component shard 1/2, job `137036894874`, timed out in
the unchanged 600 KiB handoff fixture at 5.3225339 seconds against its existing
5-second test limit. All other jobs passed; this remains an overall failure.

The actual checkout `e755594650524ee522dc1cfe846de2b8fbbe7537` has parents c43
and 0e779 and the exact PR-head tree `2c4f13a41473bece2f7e0c7c1a4a9ddf12e1a79e`.
The fixture/service/configuration inputs are byte-unchanged from c43.
The original JUnit artifact `14732446194` is downloaded, byte-verified against
the uploaded ZIP digest and archived. It contains one failing testcase with
that name/time. Full terminal metadata and a byte-preserved failure-log excerpt
are included; the excerpt is not represented as the entire original log.
The full original log remains preserved in the session and the official run.

Full failed-log SHA256:
`1d6f88543d64aecd5c4c435dd6600d8d493a8b0191ad76f3c4227dbe93725f36`.
Original JUnit ZIP SHA256:
`7dce5c3ddab2dcd6ae105df93ed865569da325174b06e3248cc31cc61b83d4fe`.

## Controlled matching/mismatch measurement

Normal min4 gate attempt 54 ran the unchanged eight-case fixture and four
temporary measurement cases: **12 passed**. The actual Vitest deep matcher and
the proposed native equality plus boolean matcher compared identical input pairs.
Each case used 614,400 bytes, reconstructed through the same three 256 KiB-bounded
base64 chunks. First/middle/last mismatch cases flip one byte; both comparators
reject them. Match succeeds for distinct equal Buffer objects, not identity.
Three samples alternate comparator order; no timing assertion or timeout override
is introduced.

Darwin arm64, Node v24.22.1, median milliseconds:

| Case | Deep matcher | Native equality + matcher |
|---|---:|---:|
| Match | 455.054167 | 0.059875 |
| First byte differs | 0.009459 | 0.008083 |
| Middle byte differs | 10.733250 | 0.020042 |
| Last byte differs | 20.373833 | 0.022833 |

The matching case is about 7,600 times faster locally. All sample arrays,
data hashes and the exact temporary probe bytes are preserved in the originals.
Expected matching-content SHA256 is
`15e1627a43db0ef74fb503bf82a157091b125c711d5cdadb276fe31fb5b22745`.

This demonstrates a material, removable assertion hotspot and controlled byte
comparison equivalence. It does **not** prove the cause of the original Windows
timeout or classify it as a flake. The replacement follows existing native byte
equality prior art in `handoff-snapshot.test.ts` and `annex-control.test.ts`.

## Exact candidate proof

- Attempt 55, clean exact candidate869, normal min4 gate: all **eight fixture
  tests pass**, resumed 600 KiB case observed at **3 ms**, at most two workers.
- Attempt 56, normal min6 compiler gate: actual failed task-local config omitted
  existing repository ambient declarations and JavaScript roots. Its original
  config/output/receipt are preserved. No source correction, new declarations,
  cast, compiler-option relaxation or install resolves it.
- Attempt 57: not executed because the preceding chain stopped at 56; no credit.
- Attempt 58, clean unchanged candidate869, normal min6: targeted fixture typing
  passes with the unchanged inherited fixture compiler options and repository
  `.d.ts`/`.js` roots explicitly included.
- Attempt 59, clean unchanged candidate869, normal min4: strict fixture ESLint
  passes with **zero errors and warnings**.

The temporary compiler configs inherit
`docs/annex-reverse-routes.tsconfig.json`, select the actual fixture, and are
task-local ignored files, not project/configuration changes. Both configs and
their command seals are archived. The temporary performance probe is removed
from the worktree after its byte-verified archival. No broader consumer or local
E2E run is repeated for this one-line fixture-only delta.

[Manifest](manifest.json) binds source/input hashes, all five actual command
originals/receipts, the unexecuted tail, measurement data, compiler configs,
producer archives, original hosted metadata, original ZIP and log excerpt.
The source869 to evidence-only successor bridge preserves all executed source,
test, policy and package inputs.

The prior [consumer/R1 approval](https://github.com/Agent-Clubhouse/Clubhouse/blob/0be97bb677cb57d5e428b3b8a383c0785ff3f304/docs/qa-transfer/2026-11-21/reports/3613-consumer-r1-715678845-independent-review.md)
and original BLOCK/failure history remain unchanged. This candidate still needs
independent exact delta review before updating the **same** PR and obtaining
ordinary new-head automatic CI. No failed-run rerun, timeout increase, waiver,
merge, full-duplex acceptance or release is claimed.
