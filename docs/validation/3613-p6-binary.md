# P6 validation record

Base: `aa193423d` (origin/main). Branch: `feat/3613-p6-binary`.
This is a PARTIAL slice of #3613; P2/P7 routing and P8 acceptance are separate.
No local E2E, Playwright, full suite or release was run. PR #3688 was opened
after independent approval, on the orchestrator's instruction.

All npm, TypeScript, eslint and Vitest commands used
`~/.clubhouse/orch/desktop-test-gate.sh lane-3613-p6 <tier> -- <command>`.
Vitest always used at most two workers. Initial npm/tsc attempts at tier 6 were
refused with exit 75 (`go_compiling_hold_heavy`), at intervals exceeding 60 s.
The orchestrator explicitly changed tsc/eslint to tier 4 during iOS compilation;
that override applies to the final static checks below. npm ci remained tier 6.
A root node_modules symlink was used only for iteration and removed before the
successful clean npm ci. Final evidence uses this branch's installed lockfile.
The urgent #3685 explicit gate hold was respected between regression and final
mutation passes, with refused attempts at least 60 s apart.

## Original failures, retained

These are historical runs, not discarded or replaced by later passing results.

| UTC start | Command after the gate | Original result and correction |
|---|---|---|
| 18:13:47 | `vitest run src/main/services/annex-control.test.ts --maxWorkers=2` | FAIL: worker reached its 4 GiB heap limit after 108 tests. Vitest's object matcher expanded a large Buffer. Changed large-buffer assertions to `Buffer.equals`; no heap limit was raised. |
| 18:14:44 | `vitest run --project main` (control, bulk, attachments, mobile-attachments; 2 workers) | FAIL: 4 failures / 150 passed. One close-code fixture expected authorization_revoked but received transport_unavailable; now real close code 4401 propagates. Three new real-I/O fence tests timed out because their call-through spies targeted fs.promises while the service imports fs/promises; fixed the module wrapper to call actual I/O. |
| 18:17:13 | `vitest run --project main` (annex-server, real binary fences; 2 workers) | FAIL: 1 failure / 524 passed. Existing handoff exact-argument assertion omitted the new beforeRead fence; updated it to require the function. |
| 18:22:07 | `vitest run --project main` (six binary/service files; 2 workers) | FAIL: 1 failure / 170 passed. New readdir fence case lacked its call-through wrapper; added the actual readdir wrapper. |
| 18:24:37 | `python3 scripts/qa/annex-p6-binary-controls.py` | FAIL: 22 mutants killed, capability mutation INVALID because its source marker omitted optional chaining. RETRY at 18:25:13 corrected the marker; capability mutant killed. |

The original negative-main and mutant assertion failures are intentional controls.
The script preserves each complete child stdout/stderr in the chosen `--logs`
directory and restores every source byte in finally, including on interruption.
A passing mutation script means assertions failed as expected, not that mutant
implementations passed. Import errors do not count as killed mutants.

## Successful fresh-dependency checks

| UTC start | Tier | Command after the gate | Result |
|---|---|---|---|
| 18:25:27 | 6 | `npm ci` | PASS, lockfile unchanged. Existing package warnings and audit findings reported; no dependency changes. |
| 18:27:xx | 4 (override) | `./node_modules/.bin/tsc --noEmit` | PASS. |
| 18:27:47 | 4 (override) | `npm run lint` | PASS, 0 errors / 3428 warnings across the repository. |
| 18:28:39 | 4 | `vitest run --project main --project shared` for annex-control, annex-control-bulk, chat-attachments, mobile-attachments, annex-binary-fences, handoff-transfer-source and annex-control-protocol, `--maxWorkers=2` | PASS, 210 tests. |
| 18:28:56 | 4 | `vitest run --project main` for annex-server, handoff-snapshot, handoff-host-transfer, handoff-transfer-transport and handoff-transfer-integration, `--maxWorkers=2` | PASS, 648 tests. |

## Negative controls and mutation coverage

`python3 scripts/qa/annex-p6-binary-controls.py` installs origin/main production
sources under the new tests, records their expected assertion failures, then
restores the working sources. It next removes guards one at a time, restoring
between runs. Every child uses `vitest run --project main ... --maxWorkers=1`.

The controls cover transfer count and metadata bounds; admission and byte limits;
sequence, token, length and SHA-256 integrity; subscription and request ownership;
negotiated features and sender direction; one credit per chunk and one write per
callback; reauthorization per frame and at a deferred actual socket send;
cancellation ownership at that send; required use of digest framing; attachment
write/publication fences; handoff read fences and slots held until actual work
settles. The initial negative-main run had 18 expected failures; the final run
includes additional content and concurrency regression controls.

The attachment tests wrap and await actual mkdir/readdir/writeFile/realpath;
the handoff test runs real snapshot verification/open/read and pauses the actual
pinned descriptor's stat. The service methods themselves are not mocked out.

Binary boundary cases include 0, 1, chunk−1, chunk, chunk+1, attachment cap and
cap+1, clipboard cap and cap+1, a 32 MiB full event, an encoded 8 MiB raw content
body, 72 KiB icon allowance, 3 MiB handoff allowance and uncapped text above
32 MiB. Tests also exercise cancellation, concurrent clipboard transfers,
queued control traffic during bulk, revocation and forged owners/directions.

## Final receipts

One tier-4 admission ran sequentially from **18:38:24Z to 18:39:34Z**, exit 0:

- `vitest run --project main --project shared` for control, bulk, staging,
  mobile-attachments, real binary fences, handoff-transfer-source,
  annex-control-protocol and annex-chat-content, `--maxWorkers=2`: **226 passed**.
- `vitest run --project main src/main/services/annex-server.test.ts -t P6 --maxWorkers=2`:
  **3 passed** (real attachment staging/chat.send, real large-file route, shared
  clipboard entry-point bound).
- `tsc --noEmit`: **PASS**.
- `npm run lint -- --quiet`: **PASS**. The earlier full, non-quiet lint run also
  passed (0 errors, 3428 warnings).
- `python3 scripts/qa/annex-p6-binary-controls.py`: **28/28 mutants killed**;
  negative-main produced **41 expected assertion failures**. Every child test
  uses `--maxWorkers=1`. Source bytes are restored in `finally` after each run.
- `node scripts/annex-mobile-fixtures.mjs --check`: **66 passed**; **102 fixture
  files** have identical SHA-256 before and after, and no fixture file changed.

Successful npm ci: tier 6, **18:25:27Z–18:25:37Z**, lockfile unchanged.
The preceding tier-4 server/handoff regression admission (18:28:56Z–18:30:45Z)
passed **648 tests** across annex-server, handoff-snapshot, handoff-host-transfer,
handoff-transfer-transport and real-I/O handoff-transfer-integration.

The mutation harness and the tests are committed and rerunnable. Full stage
logs from the final admission are at `/tmp/annex-p6-final/`; per-mutant and main
negative-control logs are at `/tmp/annex-p6-binary-controls-final/` in this
workspace. Earlier original failures remain in the session transcript and in
the history above, including the invalid capability marker and its successful
RETRY. These temporary logs are supplementary; no implementation or test exists
only there.

## Independent QA follow-up (c35580c5f)

QA rejected `c35580c5f` for two confirmed findings: stale handoff state/grant
at a real descriptor await, and UUID replay/rebinding after completion/cancel.
The fix adds synchronous agreement/acceptance and grant/policy generation
fences at filesystem acts, keeps peer/link checks, and reserves UUIDs in both
directions for the connection lifetime. History closes at 262,144 entries;
there is no eviction or TTL that could admit replay. Attachment staging also
rechecks its exact runtime, durable/quick registration and project generation.

The QA handoff test is preserved in `annex-binary-qa-regressions.test.ts`;
the QA transport tests are preserved in `annex-control.test.ts`. Running these
unchanged against production sources from `c35580c5f` yields **4 expected
failures**. The expanded origin/main negative control yields **53 expected
test failures** (new behavior and APIs absent). Logs are retained, not replaced.

Follow-up commands all ran through the same gate at **tier 4**, using the
fresh worktree-local npm ci already recorded above. No dependencies or
lockfile changed after that install. Every Vitest command used at most two
workers; mutant children used one.

- `vitest run --project main annex-control annex-control-bulk annex-binary-fences
  annex-binary-qa-regressions handoff-transfer-source --maxWorkers=2`
  (full paths under `src/main/services`, `.test.ts`): **192 passed**,
  19:00:14Z–19:00:16Z.
- `vitest run --project main handoff-host-transfer handoff-host annex-server
  -t 'P6|handoff' --maxWorkers=2`: **12 passed**, 19:00:27Z–19:00:32Z.
- `node_modules/.bin/tsc --noEmit`: **PASS**, 19:00:52Z–19:01:02Z.
- `python3 scripts/qa/annex-p6-binary-controls.py --logs
  /tmp/annex-p6-qa-controls-original`: **43/43 mutants killed**, both negative
  controls reproduced, 19:01:20Z–19:01:53Z. New mutants remove handoff state,
  immutable agreement, act authority, saved grant revision, agent policy
  generation, completed/cancelled UUID rejection, cancelled-byte cleanup,
  outgoing history, late/unknown cancel ownership, tombstone capacity, and
  attachment runtime/registration/project guards.
- `node_modules/.bin/eslint . --quiet`: **PASS**, 19:02:12Z–19:02:30Z.
- `vitest run --project main --project shared` with these 15 targeted files,
  `--maxWorkers=2`: **909 passed**, 19:02:43Z–19:04:34Z:
  `annex-control`, `annex-control-bulk`, `annex-binary-fences`,
  `annex-binary-qa-regressions`, `agent-runtime/chat-attachments`,
  `mobile-attachments`, `annex-chat-content`, `handoff-transfer-source`,
  `annex-server`, `handoff-snapshot`, `handoff-host-transfer`, `handoff-host`,
  `handoff-transfer-transport`, `handoff-transfer-integration` under
  `src/main/services/`, plus `src/shared/annex-control-protocol.test.ts`.
- Final single admission **19:05:05Z–19:05:51Z**, all **PASS**: the final
  `annex-binary-fences.test.ts` has **10 passing real-I/O cases**, including
  two added real-path-stat pauses that prevent an unauthorized verification
  open. `annex-p6-binary-controls.py --only handoff-inner-open` kills the extra
  open-fence mutant (**44/44 total**). Then `tsc --noEmit`, `eslint . --quiet`
  and `node scripts/annex-mobile-fixtures.mjs --check` pass; the fixture check
  executes **66 tests**, and all **102 fixture blobs** match `aa193423d`.

The original admission and RETRY 1–7 were refused by the explicit #3685 hold;
RETRY 8 was admitted. **Cadence deviation:** retries 2, 4, 5, 6 and 7 occurred
34, 39, 45, 33 and 58 seconds after the preceding refusal, below the required
60 seconds. None admitted any workload. Every refusal remains in
`/tmp/annex-p6-qa-fixes-{original,RETRY-N}.log`; the mistake was reported to the
orchestrator. Subsequent admitted commands above each released their slot.
Final logs are `/tmp/annex-p6-qa-*.log` and the two control directories named
above. No follow-up candidate test failed; expected negative/mutant failures
are labelled and retained. No full suite, local E2E, Playwright or PR creation.

## CI handoff regression at 0283ecb14

PR #3688's Annex E2E Ubuntu shard failed the existing selected-ignored-file
handoff case on its original run and retry #1. Both retained failures showed
`offered → accepted → failed`, with `verification/verification_failed`, before
the first `transferring` transition. The unrelated Windows telemetry failure
was left unchanged. No local E2E or Playwright was run.

**Reproduced contributor (not sufficient to fix the two-app CI failure):**
handoff acceptance/progress calls `notifyToolGateChange`, but
the sender's lease treated every generic tool-list notification as revocation.
Acceptance synchronization can overlap real initial-manifest verification.
That ordinary notification invalidated the unchanged authority, refused the
manifest, and surfaced as `verification_failed` during receiver resolution.
It was not a changed immutable binding or a disposed between-chunk lease.

**Proof before production edits:** the real-host regression pauses an actual
call-through prepared-file `lstat`, synchronizes acceptance through the real
sender coordinator, then completes the real receiver worker. With production
sources still at `0283ecb14`, the tier-4 admission **19:38:34Z–19:38:37Z**
failed exactly with `{state:"failed", failure:{step:"verification",
code:"verification_failed"}, history:["offered","accepted","failed"]}`.
The original gate attempt was refused (`slot held by qa-3686`); RETRY 1
executed after more than 60 seconds. Logs: `/tmp/annex-p6-ci-regression-*`.

**Fix:** every orchestration notification synchronously re-reads the authority
stamp and invalidates only if its captured values/revisions/generations changed.
The stamp now explicitly includes orchestration/cross-project enabled values,
control policy and effective caller grants, alongside the prior saved-grant
revision, normalized grants, agent config generation and Dispatcher identity.
Invalidation remains sticky, so off-and-restore cannot resurrect a pending
operation. Domain/acceptance, peer/link, secret-policy and actual-act fences
and UUID guards are unchanged.

The regression transfers a selected ignored **600 KiB** file through the real
preparation, source verification/descriptors, receiver and apply services. It
observes offsets **0, 262144, 524288**, exact published bytes and exclusion of
unselected data before the wake callback; the person's original worktree stays
unchanged. Receiver storage is isolated in memory; actual service/I/O awaits
are not skipped. Additional real descriptor-stat negatives cover orchestration
off, off-and-restore, cross-project off-and-restore and saved-grant revocation.

**Original fixed-run harness FAIL retained:** the first executed fixed run
(19:40:51Z–19:41:07Z) passed all six authority negatives and reached `applied`,
but its chunk assertion observed the HTTP adapter while production selected
the local-transfer fast path. The observer was corrected to a call-through
spy on the real source service. RETRY 2 **19:41:49Z–19:42:03Z** passed all
**7** selected cases. Before that, the original fixed-run admission was refused
for `idle=0%<40`; the next admission waited more than 60 seconds. Every FAIL,
refusal and RETRY is retained under `/tmp/annex-p6-ci-fix-*`.

`python3 scripts/qa/annex-p6-binary-controls.py --logs
/tmp/annex-p6-ci-controls-original` passed at tier 4,
**19:42:29Z–19:43:10Z**: **46/46 mutants killed**. This includes the new
**notification-ignored** mutant (both restored-policy negatives fail) and
**spurious-notification** mutant (the legitimate accepted transfer fails).
All previous security controls remain: origin/main **55 expected failures**,
rejected QA head `c35580c5f` **4 expected failures**, and the new CI baseline
`0283ecb14` **1 expected verification_failed failure**. Source bytes were
restored after every control/mutant. Logs: `/tmp/annex-p6-ci-controls-original/`.

Final CI-fix admission **19:43:44Z–19:46:26Z**, tier 4, exit 0:
`tsc --noEmit` **PASS**, `eslint . --quiet` **PASS**, the same 15-file
main/shared targeted command listed above **916 PASS** (`--maxWorkers=2`),
and `node scripts/annex-mobile-fixtures.mjs --check` **66 PASS**. All **102**
fixture blobs remain byte-identical to `aa193423d`. Worktree-local dependencies
remain the previously validated fresh install, with no package/lockfile changes.
Full commands and output are in `/tmp/annex-p6-ci-final-{tsc,lint,targeted,
phone-fixture}.log`, with gate START/END at `/tmp/annex-p6-ci-final-original.log`.
No follow-up E2E was run locally; the unchanged E2E spec will rerun in CI.


## CI diagnostic follow-up (run 44162315523)

The unchanged E2E still fails on both Ubuntu and Windows at `a8ab12294`.
The notification correction above reproduced a real independent refusal, but
was not sufficient to explain or fix the real TLS/two-desktop path. Downloaded
`gh run view 44162315523 --log-failed` and all `gh run download 44162315523`
artifacts into `/tmp/annex-p6-a8ab-ci-failed.log` and
`/tmp/annex-p6-a8ab-artifacts/`. Both original/retry traces contain only
`offered → accepted → failed`, `verification/verification_failed`; sender
route logging and HTTP responses discard the underlying guard reason. These
original CI failures remain evidence; no actual E2E root cause is claimed yet.

This follow-up changes diagnostics, not guard predicates: sender refusals
carry a fixed allowlisted label for record/binding, lease authority generation,
grant/policy, expiry, snapshot or peer/link checks. Error identity/classes,
status codes and failure step/code remain unchanged. The desktop HTTP error
and sanitized handoff history/CI attachment preserve that label; arbitrary
error text, paths and identifiers cannot become diagnostic labels. Snapshot
error wrapping preserves the original label. CI must supply the actual failing
label before any further guard change.

Windows negative-test holds now canonicalize fixture paths with the same async
`realpath` as production, compare with `path.relative` for Windows casing, fail
promptly if the service finishes before entering the real `lstat` hold, and
release the hold in `finally`. The cancelled/grant-generation cases still
assert no verification open after the real stat await. No timeout increase,
skip, local E2E or Playwright run was used.

Gated tier-4 focused run `/tmp/annex-p6-diagnostics-original.log`: 40 tests
passed (20:08:57Z). Gated tier-4 `tsc --noEmit` passed 20:10:39Z–20:10:48Z.
Gated tier-4 final batch 20:11:38Z–20:12:59Z passed lint, 51 targeted tests,
2 selected server tests, all 46 mutants and 66 phone fixtures. Commands and
outputs: `/tmp/annex-p6-diagnostic-final-{lint,targeted,server,mutants,fixture}.log`;
original-main/rejected-head/approved-head negative controls and every expected
FAIL are retained in `/tmp/annex-p6-diagnostic-controls/`. The fresh local
install remains unchanged. No new candidate FAIL or admission refusal occurred
in these diagnostic runs; Windows execution and the E2E result await CI.
Final label-refinement recheck at tier 4 **20:15:11Z–20:16:28Z** repeated
lint, 51 focused tests, 2 server tests, 46 mutants and 66 phone fixtures: all
PASS; receipt `/tmp/annex-p6-diagnostic-final-recheck.log`.
Final tier-4 TypeScript recheck **20:16:37Z–20:16:45Z** PASS; receipt
`/tmp/annex-p6-diagnostic-tsc-recheck.log`.

## Binding-notification diagnostic follow-up (run 44167686683)

Ubuntu job `134342656809` and Windows identify the exact invalidation listener:
`lease_binding_notification`. Downloaded the Ubuntu job log into
`/tmp/annex-p6-d61-linux.log` and its trace artifact into
`/tmp/annex-p6-d61-artifacts/`. This identifies the unconditional
`bindingManager.onChange` callback, not a differing captured stamp field. The
manager also notifies for label/instruction changes and unchanged tool writes.
The artifact still cannot say whether its event changed authority.

This follow-up retains unconditional invalidation and adds only allowlisted
sub-reasons: unrelated agent/target, unchanged binding, metadata, membership,
permissions, or the actual authority-stamp mismatch. Diagnostic snapshots
normalize tool ordering; private binding data stays local and is never emitted.
Tests use the real binding manager during the real pinned descriptor-stat await.
The first diagnostic run passed five cases (20:39:39Z–20:39:48Z), confirming
that unchanged tools, relabels and unrelated changes currently refuse just as
actual removal and permission changes do. A sixth unrelated-target case was
added for the final run. A CI sub-reason is still required before changing the
production invalidation predicate. No local E2E was run.

Final tier-4 admission **20:42:08Z–20:44:08Z**, RETRY 2, exit 0:
`tsc --noEmit`, `eslint . --quiet`, **13 host P6 cases** (including six actual
binding notifications during real descriptor stats), **51 focused tests**,
**2** selected server cases, **46/46 mutants killed** with all original
negative controls, and **66** mobile fixture tests PASS. Every command and
output is under `/tmp/annex-p6-binding-diagnostic-final-{tsc,host,lint,targeted,
server,mutants,fixture}.log`; controls under
`/tmp/annex-p6-binding-diagnostic-controls/`. Original and RETRY 1 admissions
were refused (`slot held by lane-3686`, 20:39:58Z and 20:40:59Z), retained in
`/tmp/annex-p6-binding-diagnostic-final-{original,RETRY1}.log`; retries waited
at least 60 seconds. No new candidate FAIL. Dependencies and phone fixtures
remain unchanged. The telemetry flake is untouched.

## Confirmed unrelated-binding refusal and correction (run 44172493203)

Both Annex E2E jobs (`134359661640`, `134359661885`) classify every refusal
as `lease_binding_unrelated_agent` (four occurrences per OS). Full failed-job
logs are retained at `/tmp/annex-p6-775-ci-failed.log`. Thus the actual two-app
failure was the unconditional binding listener rejecting an event for a
nonparticipant, with no captured authority-field mismatch. The earlier
orchestration notification fix addressed a separately reproduced contributor.

**Proof before guard changes:** with production still at `775d35add`, the
real 600 KiB preparation/worker regression injects a real binding-manager event
for another agent during the actual manifest `lstat`. It fails exactly
`offered → accepted → failed`, `verification/verification_failed`. Four
real pinned-stat cases (unchanged tool lists, metadata, unrelated agent, and
unrelated target) also fail. All **5 original FAILs** are retained at
`/tmp/annex-p6-binding-fix-negative-original.log`, gated tier 4,
**21:02:17Z–21:02:26Z**, exit 1 as expected.

**Correction:** binding notifications for nonparticipants return immediately.
For participant notifications, the lease compares only relevant target
membership and normalized enabled/disabled switches, plus the preexisting
captured effective caller grants and policy stamp. Labels, instructions,
unchanged lists and unrelated-target bindings do not invalidate unchanged
authority. A structural Dispatcher binding that changes effective grants
still revokes, even if its target is outside the transfer's participant pairs.
Actual membership, permission and effective-grant changes invalidate
permanently; restoring them before the pending real stat resumes cannot
resurrect the operation. The actual-act check also compares the captured
relevant binding projection after awaits. Existing domain/acceptance,
peer/link, policy-generation, saved-grant and secret-policy fences remain.
Diagnostics, direct `/ws`/phone shapes and all existing limits are retained.

The real-binding-manager/stat cases now require benign changes to read
successfully, relevant membership/permissions to refuse, and membership,
permissions or effective tool grants changed-and-restored to remain refused.
The 600 KiB regression injects the CI-confirmed unrelated event and still
requires three exact chunks and publication before wake. No local E2E or
Playwright is run; the unrelated telemetry flake remains unchanged.

Focused fixed-run admissions: original refused `idle=28%<40` at 21:03:06Z;
RETRY 1 refused `slot held by lane-3686` at 21:04:33Z; RETRY 2 admitted
**21:05:50Z–21:06:25Z**, tier 4, **17 P6 host tests PASS**. Every refusal and
RETRY is retained under `/tmp/annex-p6-binding-fix-{original,RETRY1,RETRY2}.log`;
admission retries waited at least 60 seconds.

Final single tier-4 admission **21:06:43Z–21:10:29Z**, exit 0:

- `node_modules/.bin/tsc --noEmit`: PASS.
- `node_modules/.bin/eslint . --quiet`: PASS.
- `node_modules/.bin/vitest run --project main src/main/services/handoff-host-transfer.test.ts --maxWorkers=2`: **44 PASS**.
- The 7-file main/shared/integration targeted command from the diagnostic round: **51 PASS**, `--maxWorkers=2`.
- `node_modules/.bin/vitest run --project main src/main/services/annex-server.test.ts -t handoff --maxWorkers=2`: **2 PASS**.
- `python3 scripts/qa/annex-p6-binary-controls.py --logs /tmp/annex-p6-binding-fix-controls`: **49/49 mutants killed**; original main **55 expected FAILs**, rejected `c35580c5f` **4**, approved CI baseline `0283ecb14` **1**, and binding CI baseline `775d35add` **5**. All production bytes restored after each run.
- `node scripts/annex-mobile-fixtures.mjs --check`: **66 PASS**, with all 102 fixture blobs unchanged.

The three new mutants remove the binding listener (restore negatives fail),
remove the relevant binding projection (membership/permission negatives fail),
and restore unconditional binding invalidation (benign positives and the
600 KiB transfer fail). All fail on real service awaits. Receipts and exact
child commands: `/tmp/annex-p6-binding-fix-final-{tsc,host,lint,targeted,server,
mutants,fixture}.log`; original gate receipt
`/tmp/annex-p6-binding-fix-final-original.log`. Fresh worktree-local
`node_modules` remains a directory from the validated branch install; no
package or lockfile changes. Apart from the intentional pre-fix negative
control, no candidate test failed in this correction round. Windows and the
real two-app E2E await CI and independent QA; no merge was performed.
