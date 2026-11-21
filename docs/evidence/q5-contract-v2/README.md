# Q5 contract successor: isolated IO evidence

This is contract research, not product implementation or a product test pass.
Canonical issue: [#3758](https://github.com/Agent-Clubhouse/Clubhouse/issues/3758).
Contract: `docs/design/q5-durable-notice-ledger.md` (revision 2).
Original reviewed draft `b0d52ee6c384386ef46eba3028634d7fc9d60473` remains preserved.
Independent C1–C3 review: `9d865f4e71ff95cb6581a29ad9fe074f6ece649e`,
`docs/qa-transfer/2026-11-20/reports/q5-b0d52ee6c-contract-review.md`.

## Exact observed execution

Source head: `f94421c47bda49e59319df1bb82ab9be0036de30`.
Tree: `c02340fd50264982e61088bb01e44b423f5ce513`.
2026-11-21T09:36:58.260839Z–09:36:58.690423Z, exit0.
The wrapper ran inside min4 gate admission, with identical clean before/after
head/tree and four source SHA256 values. Exact argv/raw output, hashes and
receipt are in `f94421c47/`. No refusal/retry occurred.

Command:

```text
/Users/masonallen/.clubhouse/orch/desktop-test-gate.sh q5-ledger-contract 4 -- python3 test/research/q5-seal-contract-io.py /Users/masonallen/.clubhouse/orch/evidence/q5-contract-v2/f94421c47-io-attempt1
```

Node24.22.1, Darwin25.5.0 arm64, default temporary filesystem (type unmeasured).
Directory fsync succeeded in this run. No cache or concurrent-load control.
Synthetic payloads only; no app userData, notices, provider calls or installs.

| Isolated operation | Samples | Median | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| 64KiB append + file sync | 32 | 4.190ms | 4.640ms | 5.024ms |
| 256KiB temp write/file sync/rename/directory sync | 12 | 9.731ms | 13.777ms | 13.777ms |
| 512KiB temp write/file sync/rename/directory sync | 12 | 10.444ms | 11.288ms | 11.288ms |

These sample distributions establish only the observed IO envelope on this host.
They are not a latency SLA, cross-platform/power-loss result, real ledger commit
cost, indexing/compaction benchmark, restart proof or failure proof. Actual
product-bound persistence/recovery/compaction measurements remain required after
contract approval and implementation. No tsc/lint/feature tests were run here.

The JSON representation example of one uncertain post plus one terminal interval
covering a million later posts encodes91 bytes; the illustrative257-hole split
retains256 hot and1 archived entry. Those are **illustrations**, not execution
of a real archive, interval algorithm, liveness assertion or disk restart.

## Physical synthetic artifacts

The run retained six files at the temporary path printed in `io.raw.txt`.
They contain only synthetic padding. Hashes observed after the admitted run:

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| checkpoint-262144.json | 262144 | 266e3d389c47b946b9d332ac378bba516df09c6e64200d837fe536bbaea3e3a5 |
| checkpoint-524288.json | 524288 | 9b7fd83ab5474c794db05f684cb76dc6ac13ab76b0e36eda748befcfa2396d3b |
| segment-0.jsonl | 524288 | 79844556dff98b91b8c79533bd3eb41c4099309cb1f85c6d45f7fb687d1c8cc5 |
| segment-1.jsonl | 524288 | 79844556dff98b91b8c79533bd3eb41c4099309cb1f85c6d45f7fb687d1c8cc5 |
| segment-2.jsonl | 524288 | 79844556dff98b91b8c79533bd3eb41c4099309cb1f85c6d45f7fb687d1c8cc5 |
| segment-3.jsonl | 524288 | 79844556dff98b91b8c79533bd3eb41c4099309cb1f85c6d45f7fb687d1c8cc5 |

Raw receipt is preserved unchanged, including its original absolute paths.
This evidence-only addition does not retro-seal a newer head. The contract and
research scripts remain byte-identical to the admitted source head.

## C1–C3 disposition for re-review

- C1: compact terminal intervals above and below holes; per-recipient bounded
  journal/checkpoint pages; hot-detail overflow archives rather than pauses;
  storage proportional to unresolved holes in sequenced mode. Physical disk
  failure remains an explicit operational limit. Product proof pending.
- C2: trusted local-human nonce-bound identity adoption retires old generation
  without resolving its uncertainty and establishes an explicit fresh baseline.
  No auto-adoption, re-pair operation, chat reset or send as part of adoption.
- C3: visible post-ID coverage mode with exact paged ID index and explicit lack
  of host ordering. Its O(distinct IDs) compatibility storage cost is stated;
  no guessed sequence, post-count cap or silent indefinite deferral.
- Required controls: trusted main-window/frame/app-document checks, main-minted
  persisted nonces, no-send cancellation, synchronous IO-free final entry hook
  released after settlement, precheck-refused wake creates no intent,
  scan-time exclusions not revived, truthful contiguous legacy cursor only.

All disposition statements are contract proposals awaiting independent re-review,
not implementation or acceptance claims. No product edits before that verdict
and hunk clearance. Controller/SAVE_SETTINGS/Details ownership remains separate.
