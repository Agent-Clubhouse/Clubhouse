# Independent QA: Q5 runtime P1 work in progress, static source review (no approval)

Reviewer: qa-details-local-composition, November 21, 2026.

- **Target:** `9c85103c3a6e50e55d272b3e147ca8106ff5b9bc`, tree `e8d62626833afc91eff2927f32661735c9f50453`, which matches `origin/lane-3613-p2-routes/q5-runtime-p1`. The base is `5bbabde2d`.
- **Bound to:** contract `8a0eb833e`, QA `002bc36d9`, and Q5 concurrence `b05c927a1`.
- **Source hashes:** the three sha256 values in the README match the committed blobs: `3d30b01c…`, `fa6d6562…` and `ade0c4fd…`.
- **Execution credit: ZERO.** The only gate attempt was refused with `swap_grew 1812→3929M` before any child ran, and later static corrections came after that. No tests, types, lint or mutants have run.

## Scope

- **5 files:**
  - `src/shared/chat/runtime.ts`: unused brands and types;
  - `runtime-coordinator.ts`;
  - `runtime-coordinator.test.ts`;
  - the evidence README;
  - the original refusal record.
- **Consumers are absent:** a git grep finds `runtimeOwnerPort`, `runtimeNoticePort` and `_resetRuntimeCoordinatorForTests` used nowhere outside the coordinator and its test.

## Static assessment against the contract

### Registry versus liveness: CORRECT

- `issuedHandoffs` and `issuedTickets` are private `WeakSet`s, and `handoff(value)` checks registration before reading the record.
- Registration alone doesn't grant entry. `tryEnter` requires `live(record)`: current frame, phase `live`, attached resource and open admission at the current scope revision. It also requires bound queue and publication.
- `transportAdmission` requires liveness plus an exact resource match.
- Tickets start closed and open only on `entered`.
- `_resetRuntimeCoordinatorForTests` swaps in new registries, so an old issued object fails.

### At-most-once loss: CORRECT

- `retire()` latches `retired` and clears `lossHook` **before** invoking it, so reentrancy is safe.
- `journal_owned` triggers zero hooks.
- `pending` maps to `unsubmitted`, and `entered` or `unknown` map to `unknown`.
- A claimed result keeps the single committed promise.
- A synchronous hook throw gives `failed` plus a rejected promise, with the latch kept.
- An asynchronous rejection makes `lossPhase` `failed` and logs reconciliation.
- `lossSettlement` returns `undefined` only for `journal_owned`.
- `retireHandoff` is informational on a second call.

### D2: CORRECT

On an unexpected marker throw or an invalid decision, the entry becomes `unknown`, `retire` invokes the single `onLoss('unknown')`, and then the original error is rethrown. It is never mapped to `rejected` or `journal_owned`.

### Scope closed before callbacks: CORRECT

- In `beginTransition`, `holdScope` and `closeAdmission`, all tickets are closed and the old frame or scope is revoked **before** any loss callback runs.
- Retire loops iterate over copied sets.

### Holds and fake clock: CORRECT

- Deadlines use monotonic `performance.now()`, and a deadline that is non-finite, not in the future or beyond 2³¹−1 ms is rejected before closing anything.
- The timer is re-armed until the deadline passes and is unref'd.
- `expireDue` runs on capture, status and finish.
- Expiry or failure is logged and never restores the old admission.
- `finishScopeHold` requires the same revision and an exact authorized scope key, then issues only a **new** admission.
- The tests fake `setTimeout`, `clearTimeout` and `performance`.

### Generation and resource: CORRECT

- `registerOwner` refuses duplicates. Equal-name replacement work is never adopted.
- A late start after replacement is `superseded`.
- A native instance can't be attached by another owner or agent, or while its prior frame is current.

### Receipts: CORRECT

- The observer requires the exact `dispatchId` object and bound resource, and refuses `approved_handoff_ack` with `ack_mapper_not_approved`.

## Defects and clarifications to fix before proof

1. **P1-a (clarify, API meaning): `closeAdmission` closes the whole scope** and leaves it closed until `holdScope` plus `finishScopeHold`, so every concurrent admission in that scope is revoked.
   - That matches "revoke scoped admission" in the contract and the test "revokes the entire original scope".
   - But the name suggests a per-attempt close. If a P5 consumer called it on normal completion, other in-flight attempts in the scope would be revoked.
   - **Fix:** rename it, for example `revokeScope(admission)`, or document it in the port, and add a guard test that normal completion doesn't call it.
2. **P1-b (doc limit): dormant entry is impossible.** `tryEnter` requires phase `live` with a resource, so a handoff on a dormant lease can't enter until the resource is attached.
   - That's correct for the currently permitted wake paths: chat send after session creation, and the PTY pending command after spawn.
   - But it makes the contract's "mark before argv spawn" path unimplementable as written.
   - **Fix:** state explicitly in the code and README that pre-spawn argv entry isn't supported by P1. Any future argv path needs a reviewed extension.
3. **P1-c (minor, hygiene): the test reset is exported unguarded** from a production module.
   - `_resetRuntimeCoordinatorForTests` drops all issuance state if any main-process code calls it.
   - **Fix:** gate it on a test environment, for example by throwing unless `process.env.VITEST`, or move it behind a test-only entry.
4. **P1-d (recommendation, defence in depth):** `allowed()` returns only `state.open`, so correctness depends on every revocation path calling `closeTickets`.
   - That holds today: transition, scope close, hold and retire all call it.
   - Have `allowed()` also check `!record.retired && live(record)`, which is still memory only and synchronous, so a future path that forgets to close tickets fails closed.
5. **P1-e (note):** `captureAdmission` and `createHandoff` **throw** on a closed or held scope, or a non-current lease, instead of returning typed refusals. That's consistent with the contract's signatures, but P5 must treat these as typed refusals before the intent exists, not as unexpected errors after it.

## Verdict

- **Not approved for a PR.** There is zero execution credit.
- The static design and implementation are **consistent with the contract** on registry and liveness, at-most-once loss, D2, close-before-callbacks, holds and generation ownership. Consumers are absent.
- **P1-a to P1-c should be fixed** before proof, and P1-d is recommended.
- **Required next:** after the repaired gate is approved, or normal admission becomes possible, run tests, tsc, lint and the mutants on the exact head, then an exact-source re-review.
- The original refusal and refs are preserved.
