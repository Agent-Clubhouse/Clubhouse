Navi queue investigation — PRESERVED, UNFINISHED, NOT APPROVED TO LAND
Prepared 2026-11-20. Preservation only; Q5 product decision remains pending.

Repository: https://github.com/Agent-Clubhouse/Clubhouse.git
Notes branch/upstream: diagnose-navi-queue/mini-preservation
                      origin/diagnose-navi-queue/mini-preservation
The sender supplies the exact containing notes commit SHA to the parent.
All source/test commits below are ancestors of this notes branch.
Issue/PR: none created for this assignment. No deployment/release authorized.
Assignment: diagnose-navi-queue, parent Clubhouse-Orchestrator, task t_mwoaz83p.

Ownership and deadline
----------------------
Sender still owns preservation. Mini identity/link verification and receiver
readiness are being coordinated by Navi/parent. NO VERIFIED RECEIVER ACCEPTANCE
has been received. A sent message or successful Git push is not a takeover.
Do not create a duplicate implementation owner or invent a Mini access route.

Latest deadline: begin wrap/preserve/transfer by Nov20 05:00 Pacific/13:00Z;
hard cutoff Nov20 06:15 Pacific/14:15Z. Earlier 03:30 snapshot and 04:30 verify
are useful early targets, not hard delivery gates. Prepare now.

Frozen remote heads
-------------------
diagnose-navi-queue/pending-token-cleanup
  298f292f4da6e6b5b301bb1e3ba8e6e5ff8cf400 — rejected: Q1/Q2 review findings.
diagnose-navi-queue/dispatch-ownership
  ccd51f5076efc068ea13314e4890e47e7cb50d8a — rejected: Q3; Q4 qualifications.
diagnose-navi-queue/session-drain-ownership
  0bb43aba9db9504bd5141f1387a512cf97a9b8ba — WITHHELD: Q5 missed consumer.
  tree 4afc5313dd0f4a2236a4ee98f667aa0ccddb3311
diagnose-navi-queue/group-unknown-baseline
  edce1d072a674bc4d3673296a13b18ad54f535e5 — TEST-ONLY EXPECTED-FAIL baseline.
  tree 2b9a22e58819be378f83720fceab563fcab3a6de
Source base: ae56577af786b0db79f21d137d0b334a5f7847dc.
Do not replace these heads or infer acceptance from a passing subset.

Outcome and current scope
-------------------------
User-performed Stop/Resume recovered Navi; parent separately log-confirmed it.
This helper performed no live recovery or live delivery action. The historical
triggering exception is unproven. Controller restart and visible-chat lifecycle
are distinct. No session/config/data reset is authorized.

The implementation history addresses failed pre-send token cleanup, serialized
unidentified starts, queued rollback cleanup, session-owned drain/wait state,
late success publication/provenance fences, and honest unconfirmed Actions
receipts. Independent review found bounded positives for Q1–Q4, not blanket
delivery/persistence/cancellation guarantees. Aggregate Actions expiry/outcome
policies were not exhaustively proven by single-step controls.

Q5 BLOCKER: actionQueue.onSettled has TWO production owners:
  * actions/engine.ts deliveryChanged, forwarded by actions/steps.ts and
    clubhouse-mcp/tools/dispatcher-delivery.ts.
  * group-project-delivery.ts deliver callback, previously omitted from audit.
ChatAgentRuntime.settleQueued invokes callbacks. PTY has no client queue hook.
The old sole-Actions-consumer claim is explicitly withdrawn; historical
artifacts are retained without rewriting their claims or hashes.

Group unknown settlement currently clears its queued notice without retaining
or acknowledging it. A later post can advance the cursor past that uncertainty;
reconnect can instead replay it. The store has only a monotonic notified cursor,
not uncertain gaps. The idle send branch also ignores a returned queued result
and acknowledges immediately without a callback (SOURCE-ONLY, not executed).

Policy decision — do not implement before the parent relays authorization
------------------------------------------------------------------------
Recommended smaller scope: durable quarantine per group/member. Persist intent
before runtime handoff; retain a success-cursor barrier; hold later automatic
handoffs while a batch is unresolved; recover incomplete/unknown intent as a
visible paused state across restart. Board/manual reading remains available.
Only the local human could explicitly Retry once with a duplicate warning,
subject to existing access/awake gates. No automatic replay, agent resolution,
silent waiver, or new wake authority. No provider exactly-once claim.

Alternative: per-notice/range ledger if later automatic notices must continue
despite an earlier uncertainty. This needs more ordering, batching, retention,
migration, UI and lifecycle design. Both require explicit durable policy.

Concrete compatibility boundary: current receipt readers discard unrecognized
fields, then old writers rewrite their narrowed object. A new optional field
alone is NOT downgrade-safe. Compatible writer versions/rollback behavior and
failure-closed persistence must be decided and reviewed before landing. Do not
imply an older binary honors a new uncertainty field. Existing corrupt-store
baseline-to-latest recovery must not silently erase an uncertain gap.

Narrowing the runtime enum alone cannot honestly map unknown into delivered,
dropped, expired or replaced. Ignoring it is Q5; mapping it back preserves false
acknowledgment or blind replay. Deferral is an explicit scope choice, not a fix
or approval of 0bb. See evidence/Q5-policy-proposal.json for the complete choice.

Exact observed checks and failures
---------------------------------
0bb exact clean head: seven files / 516 PASSED, tsc --noEmit exit0, lint exit0
with 0 errors / 5 existing warnings. Recorded 02:13:46–02:14:04Z. These checks
exclude group-project delivery. QA independently inspected the saved proof;
they do NOT establish Q5 compatibility or authorize landing.

edce exact clean test-only head: one file / 3 FAILED / 36 SKIPPED, exit1,
02:20:52Z. Three final assertions reached their failures:
  * later delivered notice advances cursor to2 past uncertain seq1;
  * reconnect issues a second send with retained delivery memory;
  * reconnect issues a second send after delivery watcher/member reset.
Runtime/host/board/grants/receipt Map are modeled. Unknown is manually supplied
to the real owner callback. Reset is NOT a real process/disk restart. No actual
provider processing, live notice loss/replay, or incident cause is proven.

Earlier atomic red baselines: 15afe8c33 Q3 1FAIL/145SKIP; e264b0b2f Q4
7FAIL/1PASS/146SKIP (12 assertions, not12 tests); 6eebd1544 unknown callback
4FAIL/2PASS/314SKIP. Their first-hard-failure limits are in the review reports.
Q1/Q2 initial baseline files lack atomic launch linkage; original 298 assertion
stdout was never saved and remains unavailable. Do not reconstruct it.
2938697b9 passed the subset but failed typecheck on a telemetry enum extension;
54b85f5cb passed tests/typecheck but failed lint on new test formatting. Both
failures are historical, not acceptance. 0bb uses existing step_failed telemetry
and existing public/persisted failed Action fields; no public enum/version bump.

Portable evidence
-----------------
evidence/INDEX.json lists copied records, original hashes, portable hashes and
path-only redactions. These are explicitly labeled derivatives of saved files,
not new executions or reconstructed missing output. Source blobs are immutable
Git objects at the named commits; no need for laptop source snapshots.
Only synthetic test output, launch records, bounded QA reports and policy audit
are included. No live telemetry/transcript, installed app/ASAR, dependency cache,
credentials or live identifiers are included. Original large laptop packages
remain preserved; their essential continuation content is in this remote subset.

Next steps and dependencies
--------------------------
1. Parent/Navi relays the user's quarantine/ledger/deferral decision. Until then:
   PRESERVATION ONLY. No production/schema/retry-policy or live delivery work.
2. If quarantine chosen, make compatible-writer/rollback policy and human-only
   resolution concrete; obtain exact independent review before landing.
3. Under an authorized scope, handle actual queued returns in both idle/busy
   owner paths and make both callback consumers exhaustively cover statuses.
4. Use an isolated Mini task branch and its existing resource/test gates. No
   installs/restarts or broad reruns now; 516 is not a future-head pass. The Q5
   baseline intentionally fails. No Clubhouse worktree-Handoff APIs.
5. Keep parent informed of preservation milestones/concrete blockers only.

Receiver acceptance (required before source ownership is released)
-----------------------------------------------------------------
After parent verifies the Mini receiver/link, the receiver must fetch the exact
notes SHA supplied by the sender and verify source0bb and baselineedce above,
then read this note, the policy proposal and Q5 evidence. Use normal Git only.
Report an explicit acceptance identifying receiver, fetched notes/source/test
SHAs and preservation-only scope with Q5 decision pending. Parent verifies it.
Until that exact fetch+acceptance arrives, the sender retains responsibility.
