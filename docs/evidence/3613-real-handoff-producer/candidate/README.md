# Real producer admission: exact candidate for independent review

**Unreviewed implementation/proof candidate, no PR or CI acceptance.** Frozen source
`ad104a538772156af463f3750783fbf4cd99c39c` descends from actual main/base
`50c474b48f57e0256661244bd29b9343ec112bc4`. Its entire `src` tree, including the
coupled tool fixture, is identical to `f05d72834653dbb1314c5083e3b6f82d8dd31f41`;
later commits change the complete desktop fixture and documentation only.
There is **no aggregate final-head runtime PASS claim**.

Published review ref: `refs/heads/lane-3613-p2-routes/handoff-usable-path`.
The earlier baseline on that ref was `d09d4a835608eee388c1a014f4c08953cfbf220b`.
The actual separately published boundary ref is
`refs/heads/lane-3613-p2-routes/handoff-producer-boundary=664effcd1d6d10858c0c7904983628a0393a0780`;
the historical boundary JSON's local branch label was not its publication ref.
The full independent design disposition is
[`2d363a2c592133155979ddd599d17453aa578404`](https://github.com/Agent-Clubhouse/Clubhouse/blob/2d363a2c592133155979ddd599d17453aa578404/docs/qa-transfer/2026-11-22/reports/producer-664eff-boundary-review.md),
blob `9e9c5ffbbea2934b3178fb8016b7ee2309bf2c05`. It approves the design, not this source.

## Exact surface and contract

Six existing private production files: `handoff-service`, `handoff-coordinator`,
`handoff-preparations`, `handoff-host`, `clubhouse-mcp/handoff-permissions`, and
`clubhouse-mcp/tools/handoff-tools`. Two complete related fixtures and
`docs/annex-reverse-routes.md` are included. Selected-source diff against the base:
**9 files, 1099 insertions, 52 deletions**. The manifest binds every full path,
base/source blob, source tree, and the complete selected Git patch.

The original arguments and consumed-approval version are captured before module
awaits; host/source ownership starts before implicit preparation. Actual history
queue admission is duplicate/capacity, full current positive original-call
authorization with canonical recipient correspondence, then final synchronous
original source/authority/exact preparation continuity before the first
offer-specific marker/catalog write. Ask needs its original exact consumed
context/version; fresh Allow does not depend on approval versions. General
gate/forget-only completion and durable sources without live runtimes remain.

Admission permits ensuing independent marker/catalog/history saves to finish
truthfully after retirement. Known partial IO and ambiguous after-rename IO remain
distinct; no rollback, absence, atomicity or automatic fresh-ID retry is promised.
Actual producer/POST references outlive waiter deadlines and block replacement.
Retained history cannot authorize fresh immediate POSTs from retired producers.
An independently admitted preparation finishes separately; its awaiting producer
then prepares its own original source/mode, or refuses its continuation on stop.

## Source-specific observed executions

All runs used `desktop-test-gate.sh lane-p2 4 -- npx vitest run`, one worker.
Full selectors, paths, options, timestamps and exits are in each original log;
all actual XML `name`, `classname`, status and failure nodes are in the manifest.
Numbers are **observations on these sources**, not unique/combined acceptance.

| Run | Source | PASS / FAIL / SKIP | Disposition |
|---|---|---|---|
| 84 | `e1f47fce8` | 6 / 0 / 15 | Four real producer controls and two coupled tool controls |
| 86 | `ff4ee53e1` | 16 / 1 / 4 | Consumed Ask version genuine red; other selected controls |
| 87 | `a20ba0cb2` | 4 / 0 / 19 | Matched Ask green, current, forget-only, wrong-context |
| 88 | `85b0f87b8` | 3 / 0 / 22 | Durable identity/cosmetic/runtime controls and actual retained marker failure |
| 89 | `e3140b4af` | 0 / 1 / 25 | Introduced cosmetic target-project capture window genuine red |
| 90 | `f05d72834` | 2 / 0 / 24 | Matched target window green and actual producer settlement after POST deadline |
| 93 | `83f91f824` | 0 / 1 / 25 | Negative/final producer continuity omitted |
| 94 | `c6184fdd5` | 0 / 2 / 24 | Actual queued full-positive authorization omitted |
| 95 | `ed90b31cc` | 0 / 1 / 25 | Canonical recipient correspondence omitted |
| 96 | `262b8ee28` | 0 / 1 / 25 | Exact preparation ID replaced by summary fallback |
| 97 | `19b992b72` | 0 / 1 / 25 | Producer POST reference omitted, existing reverse POST owner retained |
| 98 | `a8f0d3517` | 0 / 2 / 26 | Unsupported refusal fixture expectations; **not a production defect** |
| 99 | `5e497b1a6` | 0 / 1 / 27 | Valid branch fixture, still unsupported refusal expectation |
| 100 | `20243bb21` | 3 / 0 / 26 | Correct source/mode serial preparation and actual prior-read stop ownership |

Runs 98/99 wrongly demanded refusal even though the source already serializes a
new, originally captured preparation after the prior read. Their failures and
original fixture revisions remain immutable. Run 98's branch preparation was not
ready; run 99 made it valid. Source inspection and run 100 correct the assertions,
not production, and do not relabel those attempts as security/source findings.
The five semantic mutant commits are **local-only**, not remotely published
source refs: their exact changed files, full patches and original receipts are
archived. Their six failures are assertions, not selector errors/timeouts.

## Compiler, lint and archive integrity

Original compiler 79 at `eaf75907c` remains **FAIL exit 2, 146 diagnostics**
(misplaced declaration cascade); 81 at `365dea416` remains **FAIL exit 2, 2 diagnostics**.
83, 85, 91 and final 101 PASS with zero diagnostics on their own sources.
Final 101 on `ad104a538` uses gate **6**, `npx tsc --project
node_modules/.cache/native-handoff-ingress/79-producer-candidate-tsconfig.json --noEmit`.
Its **2467 roots = 2465 production + both complete changed fixtures**, not 2467
production roots or all repository fixtures. Final desktop fixture declares 29
cases; the complete coupled tool fixture is typed, not merely its two selectors.

Final 102 uses gate **4**, `npx eslint` on precisely the six production files and
two fixtures, JSON output: **8 files, 0 errors, 0 warnings**. 92 independently
records the same scoped result on `f05d72834`. These are not global lint claims;
historical native 166-diagnostic FAIL scoped nonregression and distinct server
71/legacy 247 warning baselines remain unchanged and separate.

`manifest.json` contains **61 SHA-256-bound gzip roundtrips, 14 raw XML runs,
357 actual XML rows**, original logs, compiler configuration, semantic mutant
files/patches and source identities. Proper XML attribute parsing is used.
Collector v1 wrongly assumed compiler failures exit 1; original script/failure
are preserved. Recovery reads actual exit 2 and verifies already-created gzip
bytes before resuming; no validation was rerun for packaging.

The original 50c baseline counterexample, its metadata/type corrections and full
design report remain in the unchanged published `baseline/` packet. Unchanged
lower/native/sync evidence is reused only by its established identities/limits,
not rerun or credited as an aggregate producer pass.

## Authority and deferred acceptance

This is an isolated real `callTool`, grant evaluator/store/context, registry,
Git/catalog/history/coordinator assembly. Caller registration and synthetic
exact-call approval input are fixtures. Remote member/public-key metadata and
held transport adapter are not TLS, bridge nonce, provider or live-human proof.
Existing standalone preparation/maintenance, retained notice semantics and
partial/ambiguous persistence behavior remain explicit.

No grants, generic registry/gate/store helpers, phone fields, route contract,
UI, protected Naming/Q5, worker/apply/wake or timeout were changed. Nonselected
phone fixtures and native server/control/protocol source remain base-identical.
Full native grant/preparation/content/apply/wake, two-host, whole-handoff and
duplex acceptance remain unfinished. Exact independent source/proof review,
ordinary new-head hosted gates and final fresh landing guards are still required.
