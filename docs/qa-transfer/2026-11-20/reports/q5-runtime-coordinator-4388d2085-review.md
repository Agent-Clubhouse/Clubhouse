# Independent QA: Q5 runtime coordinator binding, interface and hunk design

Reviewer: qa-details-local-composition, November 21, 2026.

- **Target:** `4388d20855664230441648c5923351e32af92df0`, tree `8d9357a2990ba39244ff7105297273213c3ee0fc`, now pushed. The remote `origin/lane-3613-p2-routes/q5-runtime-contract` resolves to `4388d2085`.
- **Base:** `5bbabde2d`.
- **Document:** `docs/design/q5-runtime-coordinator-binding.md`, sha256 `82b321ab…c4ae6`, 551 lines. I recomputed the hash and it matches.
- **Method:** I read the design and spot-checked source on `5bbabde2d` and on the accepted `71bd` journal. I ran nothing. **No runtime, test or phone credit.**

## Source claims spot-checked: ACCURATE

- **`chat-runtime.ts:1002–1010`:** `this.pendingDispatch = undefined` runs **before** `await activateLocalCausalInput` and `await session.send`. So the queue slot isn't the dispatch lifecycle.
- **`codex-chat-driver.ts:520–538`:** after the `turnSteer` catch, the driver falls through to `turnStart` when no active turn exists. That is the automatic second leg.
- **`codex-app-server-client.ts:171–173`:** "no active turn" is a plain `Error`. At `:217–222` a timeout deletes the pending entry, so a late response has no callback.
- **`pty-manager.ts`:** the interactive spawn uses `['-il']` or `['/v:off']`. The mission lives in `pendingCommand`, written by `flushPendingCommand` (`:216–228`).
- **Claude `driver.ts:1062–1064`:** `user_message` echoes are ignored.
- **Journal `71bd` `markHandoffEntered`:** **every** refusal throws **before** `proof.entered = true` and before `enteredAttempts.add`. Wrapping it so a throw becomes `false` is therefore a sound "not entered" result for that primitive. Q5 should still confirm this.

## Accepted design elements

- **One coordinator:** a single generation, start and resource allocator. The notice port can only capture and create tickets, never allocate, attach or revive.
- **Drivers:** they see only a Boolean, memory-only `allowed()` ticket with opaque IDs, and no journal or ledger callbacks.
- **Early-entry contract:** after `tryEnter` succeeds, any loss is UNKNOWN. There's no automatic Codex `turnStart` for tracked attempts, no exception-string matching, and no queue-slot reasoning about non-entry.
- **Receipt honesty:** a local handoff, a queue push, an SDK yield, a delivery mode or a spawn is never an ACK. **Journal `accepted` isn't broadened.** Claude and Copilot stay UNKNOWN after entry until proven otherwise.
- **The historical ACK sink** is separate from the replacement UI and publication. It is released when its source terminates, and a reopen can't mint a capability.
- **Wake:** entry is marked at the earliest point the mission is exposed (before argv spawn, or before the original pending-command write), with no ACK on spawn success and no refund.
- **Admission-first recovery** for `dispatcher-clear-chat`, with the work and chat split preserved.
- **Scoped revocation** composed over the real writer queues, instead of a fictional common queue.
- **Editing boundaries:** the host is the only editor of shared runtime files and Q5 edits only its own files. There are no generic `async-queue` edits and no phone, renderer or Annex lifecycle edits.
- **The 18 controls with negative mutants** are the right acceptance set.

## Blockers (interface clarifications, required before the coordinator and types are implemented)

1. **I-1, forgeable structural tickets.**
   - `RuntimeTransportAdmission` and `RuntimeHandoff` are structural types in `shared/chat/runtime.ts`. Any main-process module can fabricate `{ dispatchId, resource, allowed: () => true }`, and "opaque" isn't enforced.
   - **Required:** brand them (a unique symbol property), have the coordinator register issued tickets and handoffs in a `WeakSet`, and have the host entry points (`chat-runtime`, `pty-runtime`) reject an unregistered handoff or admission before passing it to a driver.
   - Drivers can stay coordinator-free. Add a control: a fabricated ticket gets zero provider calls.
2. **I-2, a single loss owner.**
   - Both `RuntimeHandoff.lost()`, which is async, and `RuntimeNoticePort.retireHandoff()`, which synchronously returns a `RuntimeLoss`, exist. That leaves it unclear who persists the loss.
   - **Specify:** the coordinator alone invokes `hooks.onLoss` **at most once** for each handoff. `retireHandoff`'s return value is informational. A second report from another path is a no-op.
   - The "duplicate loss harmless" control must cover both paths.
3. **I-3, a journal hold versus a runtime "not entered" result.**
   - Under `71bd`, `markHandoffEntered` throws while a settle or recover for that attempt is queued, through `entryIsHeld`.
   - If `tryEnter` then returns false and the runtime reports `lost('unsubmitted')`, an `unsubmitted` settle would race the journal's own in-flight `uncertain` or `recover` transition.
   - **Specify:** when a refusal comes from a journal hold or recovery (or more generally, whenever Q5 already owns a pending settlement for that attempt), the runtime records "not entered" but **must not** report a loss itself. The journal's settlement owns it. Q5 needs to concur on how holds are signalled, for example `tryEnter` returning `false | 'held'` internally.
4. **I-4, ACK mapping (Q5 concurrence, a deferred acceptance).**
   - Whether a successful Codex `turn/steer` or `turn/start` response counts as the journal's "genuine original same-process ACK" is a **Q5 contract decision**, not a runtime one.
   - Until Q5 accepts it explicitly, **every** backend is UNKNOWN after entry. The design allows that, and it must be stated as the default for the first slice.

## Non-blocking clarifications

- **N-1:** a conservative scoped hold for asynchronous membership drafts needs a bounded release and a visible status. An unresolved draft must not hold notices forever without anyone seeing it.
- **N-2:** gating Copilot `runCommand` must apply **only to tracked attempts**. Untracked command behaviour stays unchanged.
- **N-3:** the `RuntimeSendOptions.handoff` field must never be filled from IPC, tool or plugin payloads. Add an explicit construction-site inventory alongside the "main-only compatibility" control.

## Implementation-ready bounded portions, in proposed order (each needs its own exact review)

- **P1, ready after I-1 to I-3:** the coordinator module, the branded shared structural types and coordinator unit tests, with **no consumers wired.**
- **P2:** the chat-runtime independent dispatch record, the final synchronous gate after every await, and publication binding. Codex is the only driver, with no second leg for tracked attempts. That maps to controls 1 to 4 and 12.
- **P3:** PTY exact native witness, chunk and Enter tickets, and the wake pending-command boundary, with no change to argv policy. Controls 8 to 10.
- **P4:** transport tickets for Claude stream, Claude SDK (private guarded iterable) and Copilot, all UNKNOWN only. Controls 5 to 7.
- **P5:** Q5 delivery and wake consumers plus grant, store and host scoped bracketing, after exact writer-queue hunk review. Controls 14 and 15.
- **P6:** admission-first `dispatcher-clear-chat` recovery. Control 16.
- The ledger binding can't be declared complete until every admitted backend's receipt limits are accepted explicitly.

## Verdict

- **Design APPROVED in principle**, with **I-1 to I-3 required** and **I-4 needing Q5 concurrence** before P1.
- Only P1 is implementation-ready, and only after those clarifications.
- No feature, runtime or phone approval. No spending, restart or grant authority.
