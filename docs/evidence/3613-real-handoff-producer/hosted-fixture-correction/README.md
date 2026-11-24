# Producer hosted-fixture correction: source-specific delta

**Independent delta review pending. PR #3779 stays at 7d244; landing remains held.**

Candidate source `c1659088c68bd665fc1da0c61873729fcb9a85ee`, tree
`7ef23b3be3767f3c41227190be819295e41e4671`, src tree
`505ff0699b01779e52338e06a239d7cc15a6d2b1`.
Publish this source and packet on the separate
`refs/heads/lane-3613-p2-routes/handoff-producer-hosted-correction`.
The publication commit descends from c165; its exact published identity is
reported separately after push/readback, not inferred before publication.

Against reviewed PR source `7d244fcd153df00668ecac3d0709cece054801e3`:
**two fixture files, 117 insertions /25 deletions**. No production file,
existing assertion, existing test deadline, phone fixture, grant policy,
generic MCP gate, shared registration lease, or product stop/drain changed.
Original production approval remains source-specific:
[FULL454](https://github.com/Agent-Clubhouse/Clubhouse/blob/45495858a176a5971494cef2cfc5ae67ffbf9b18/docs/qa-transfer/2026-11-22/reports/producer-recipient-e90-independent-review.md).
The preceding immutable 90fa/b6/2d363 reviews and ef/f1/7d244 evidence are
unchanged; this packet neither repeats their execution nor transfers counts.

## Genuine fixture defects and bounded corrections

`prepare-handoff-skill.test.ts` originally omitted lifecycle ports, supplied
fake registry/config/grant exports, and bypassed the original agreement
scope while mocking a positive result. Diagnostic source3e82 forwarded the
actual host call, logged/rethrew its original exception, and retained all
assertions. Run132 first demonstrated missing `bindingManager.onChange`.
Source71b929 supplied valid real primary records, original caller
registrations, isolated Allow inputs, actual registration/arg-target/grant
implementations, and passive modeled lifecycle subscriptions, retaining
only the agreement bypass. Run135 then demonstrated real
`HandoffAuthorizationChanged` at recipient binding: no original scope.

Sourcea0 removed that bypass and fake successful permission predicate.
The scripted skill still calls its registered real handlers in the
existing manner; this is not a new generic callTool/human-grant test.
The real agreement wrapper, fresh evaluation, and final continuity run
against isolated fixture authority. Original five cases remain unchanged.
One added no-scope negative uses the same prepared offer and verifies
error, empty actual history, and byte-identical catalog. Run136 passed all
six cases at a0. The diagnostic logging spy is absent from the candidate.

The producer fixture previously tracked only explicitly held operations;
ordinary real `prepare_handoff` calls could outlive teardown. Source330ff
extracted the existing cleanup and added one real-callback-held preparation
control. Run139 demonstrated three actual AssertionErrors in one case:
cleanup settled early, fixture storage disappeared while the real source
callback remained held, and subsequent real preparation returned an error.
It was not a timeout-only failure. The 25ms observation lets teardown take
a turn; the original 5000ms test deadline was not increased.

Sourcedd508 forwards actual caller callTool arguments, result and rejection,
tracks those promises, refuses new fixture caller work during retirement,
releases fixture barriers, and drains tracked work before existing host
stop/cache cleanup/storage removal. Existing explicitly tracked promises
may be duplicate references; awaiting them does not repeat execution.
An early real offer settlement now fails the fixture's history-queue
barrier explicitly instead of waiting forever for a callback it cannot
reach. Windows-only pending-tool/age diagnostics identify actual caller
work at teardown; they do not change runtime deadlines or authority.
Run140 passed the new held preparation case and the existing real
current-sender/history-queue case at dd508.

This is fixture caller-work ownership, **not** cancellation of arbitrary
timed-out test continuations, a new generic MCP running-call rule, or a
product drain for standalone local maintenance/preparation. Existing
producer stop/owned-continuation semantics and truthful partial saves
remain unchanged.

## Exact original command ledger

Full commands and sixteen relevant source/config/collector hashes are in
each original before/after receipt and manifest. All nine commands have
matching clean head/tree/src and hash receipts before/after execution.
All originals, including every compiler failure, remain immutable here.

| Run | Executed source | Original result |
| --- | --- | --- |
| 132 | 3e82ffa1c08ea058776e4782b8046f83f3daf148 | 1 FAIL /4 SKIP /5 declarations; missing binding listener; 1 failure node |
| 135 | 71b929176e5fa67d952398d919e9f429d2ea1e0b | 1 FAIL /4 SKIP /5; actual original-scope refusal; 1 failure node |
| 136 | a0b564ed499acc9dff2121c12849ee237401f20b | 6 PASS /6; complete skill fixture |
| 139 | 330ff895484a86e899bfc86ae9454be77044134f | 1 FAIL /51 SKIP /52; premature cleanup; 3 AssertionError nodes |
| 140 | dd508e39270d6d55bfd2c62eee5d3a974d5ea220 | 2 PASS /50 SKIP /52; held preparation and current history queue |
| 141 | dd508e39270d6d55bfd2c62eee5d3a974d5ea220 | compiler exit2; 4 actual fixture type diagnostics; 3959 listFiles rows |
| 142 | a923690f3c3a649a35ec32f23d2bc597c9327907 | compiler exit2; 1 actual no-satellite return diagnostic; 3959 rows |
| 143 | c1659088c68bd665fc1da0c61873729fcb9a85ee | compiler exit0; zero diagnostics; 3959 rows |
| 144 | c1659088c68bd665fc1da0c61873729fcb9a85ee | ESLint exit0; exactly2 fixtures /0 errors /0 warnings |

Vitest commands use `desktop-test-gate.sh lane-p2 4`, one worker, original
JUnit/default reporters. Run140's combined selector is:
`keeps actual fixture preparation alive until teardown settles it|keeps current sender authority, source bytes and durable binding through a held history queue`.
No full producer/full local suite, local E2E, unchanged native/lower proof,
extra observer, package install, manual CI dispatch, or blind rerun occurred.

Compiler commands use gate6:
`npx tsc --project node_modules/.cache/native-handoff-ingress/133-producer-hosted-correction-tsconfig.json --noEmit --listFiles --pretty false`.
That archived config extends the actual production tsconfig, includes its
full src graph, and explicitly includes the three complete producer,
coupled handoff-tools and prepare-skill fixtures. No lib/target/exclusion
was weakened. The ordered3959-input inventory was captured **after**
execution:2471 tracked file bytes verified to current Git and1488 dependency
hash observations. It is not a pre/atomic/full dynamic-runtime seal.

Lint uses gate4:
`npx eslint src/main/services/prepare-handoff-skill.test.ts test/annex-v2/handoff-producer-admission.test.ts --format json --output-file node_modules/.cache/native-handoff-ingress/144-hosted-correction-lint-original.json`.

## Source bridges, not transferred runtime execution

Final c165 differs from dd508 only by erased type declarations/import in
the skill fixture. Producer fixture bytes are exactly those tested at
dd508. TypeScript5.9.3 emits identical15874-byte skill JavaScript for
a0 versus c165, SHA256
`fb4c0ed5fb859f2786acf487cf67c700630aeefafc0a926239892fdde2dc52c9`.
The bridge script/receipt and exact source/delta archives are included.
This verifies unchanged emitted value code, **not** a Vitest-transform
identity claim or an aggregate final-c165 runtime execution.
Run136's six cases belong only to a0; run140's two cases belong only to
dd508. There was no aggregate final52-case execution.

The packet has77 verified gzip archives and five original XMLs totaling
120 testcase rows across their own executions. Parsed rows retain full
name/classname/failure nodes; rows, declarations and failure nodes are
distinct measures, not a final test count.

## Hosted Windows boundary remains unresolved

Original automatic Validate45068217103 attempt1 remains FAILURE:
31 successful jobs /4 skipped /2 failed. Its untouched full logs, actual
checkout/tree capture and four unit JUnits are separately published at
[ab853](https://github.com/Agent-Clubhouse/Clubhouse/blob/ab853c28ab03472425279bf159c370e16c27cc57/docs/evidence/3613-real-handoff-producer/hosted-failure-45068217103/README.md).
Original #3779 head remains7d244; actual capture main remains50c474.

The archived original Windows log lines63510-63565 are bound to full-log
SHA256 `0e8e92dc8af0a2ea2ea2b73cacf35ca9b102e169ab16a07ec81a7563c7f54272`.
They retain the concrete late catalog ENOENT after fixture storage removal
and the first reported producer current-history-queue timeout. Test duration
includes teardown. These observations support the executed cleanup control
but **do not establish the first5000ms body timeout phase**, slow-Git/path
cause, or closure of the36 Windows producer failures/EBUSY nodes.
The original step-name checkout collector also omitted `UNKNOWN STEP`
unit witnesses; its eleven extracted checkout matches are not a claim
that every failed unit checkout was separately extracted.

Existing independent delta review is required before any same-PR update.
Only a subsequently authorized automatic exact-new-head run can determine
hosted correction acceptance. No current CI waiver, update, landing,
whole-handoff/duplex, bridge/provider/apply/wake, native TLS, live-human,
or two-host acceptance is claimed.
