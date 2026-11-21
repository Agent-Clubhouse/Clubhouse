# Independent QA: Q5 C1 source-eligibility controls (test only)

Reviewer: qa-details-local-composition, November 21, 2026.

- **Source:** `b11fa01a0af97fe9ebd34c6917ff8d5771d73727`, tree `c599b5eaaa24121221e375ca6a34c216cf92b0e8`, which is in `origin/auto-reset-policy-design/q5-source-eligibility-controls`. Its parent is `c0dea82e4`.
- **Delta:** the diff against `c0dea82e4` contains **only** `group-project-delivery.test.ts` (+43) and the two contract docs. **No production change.**
- **Evidence:** `19efe8259425cc60d2d9f2c25d0bd718abecce2d`, tree `ae2fcd0ca4df954825aee4b875b847364f867c53`, with parent `9b94dcdbb`. All 16 manifest entries match.

## Production source facts (checked on `5bbabde2d`)

- **Live path:** `group-project-delivery.ts:211`, `onPost`, returns first if `message.sender === 'system' || message.topic === 'system'`. That runs before the grant, mention, subscription and lead checks.
- **Reconnect path:** `:492` filters `m.sender !== 'system' && m.topic !== 'system'` **before** the eligibility filter (subscription, mention or lead).
- **Bootstrap helpers:** `group-project-bulletin.ts` `ensureProjectChannels` (`:756–768`) and `ensureInboxChannel` (`:815–824`) post with sender **`'system'`** and an optional shared `seq`.
- **So the existing production delivery excludes every shared-sequence bootstrap post on both paths,** even on subscribed topics, and even when the body mentions an agent or the recipient is the lead.

## The test (8 selected cases, live and reconnect × 4)

- **Sender predicate:** `general`, `control` and `inbox-dev` posts with sender `system`, sharing one sequence. Each topic is placed first in turn, so the live path's lookup for a matching sequence visits each of them.
- **Topic predicate:** the `system-topic-only` case has sender `qa` and topic `system`.
- **Bypass attempts:** the body mentions `@dev @lead`, and `lead` is granted `group_project.lead`. Zero `sendMessage` calls and zero wakes on both paths.
- **Ordinary posts still get through:** a later ordinary `qa` post to `general` notifies both `dev` and `lead` exactly once. So the exclusion neither pauses members nor hides the next eligible sequence.

## Evidence (hashing only)

- All runs are at exact `b11fa01a0`, with 31 source hashes equal before and after. I recomputed them, with 0 mismatches.
- **Tests:** 8 passed, 36 skipped (selected).
- **tsc:** exit 0.
- **lint:** exit 0.
- These went through the ordinary gate (min 4, 6 and 4).
- The original `9b94` `.slot` observation is withdrawn. The actual `/tmp` lock reading is read-only and isn't an atomic seal, as the bundle states.

## C1 closure scope

**CLOSED for the existing production delivery paths at `5bbabde2d`.** The shared-sequence bootstrap posts that conflict with the `224e` per-sequence keys are `system` posts. Both the live and reconnect paths exclude them before eligibility, and the test discriminates the sender and topic predicates separately and shows that ordinary posts still get through.

**Limits:**
- The host, board and runtime are mocked, while the delivery code is real.
- **No executed mutant** removes either predicate. Discrimination follows from construction: the three sender cases fail without the sender check, and the topic case fails without the topic check. It isn't execution-proven.
- No production change. No full test matrix, no PR, and no IB3 uniqueness claim.

## Remaining obligations for the future scan adapter (not closed)

1. **The same exclusion, applied before the reducer.** The scan adapter must exclude `sender === 'system' || topic === 'system'` **before** posts reach `PreparedNoticeState.prepare({kind:'scan'})`. Preferably it should **share one predicate function** with `onPost` and reconnect, so they can't drift apart. Its excluded positions count as covered exclusions, not deliveries.
2. **Fail closed on other shared sequences.** If any **non-system** batch ever presents more than one eligible post with the same sequence, the adapter must refuse visibly with a typed conflict status. It must not drop a post or pick one.
3. **Adapter-level controls with mutants:** a bootstrap batch with a shared sequence passes through the scan as one excluded span; a mutant without the sender check and one without the topic check must fail; a duplicate non-system sequence must refuse; and later ordinary posts must still get through.
4. **Note:** exclusion keys on the literal sender name `system`. Whether an agent can be **named** `system` (and so have real posts silently excluded) is a separate, existing question for the producer and naming code. It isn't introduced here. Check it when the adapter is reviewed.

## Verdict

**C1 is CLOSED** for the existing delivery semantics at the stated scope. Obligations 1 to 3 transfer to the future scan adapter review, and that code hasn't run yet.
