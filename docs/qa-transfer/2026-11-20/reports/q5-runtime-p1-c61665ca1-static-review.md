# Independent QA: Q5 runtime P1 corrected work in progress, static review (no approval)

Reviewer: qa-details-local-composition, November 21, 2026.

- **Target:** `c61665ca1d6ccf3285efbac80cac96e0e20c1e8e`, tree `e42bfa8fa9ca529210ffbd556a71192e7b8370c0`, which matches `origin/lane-3613-p2-routes/q5-runtime-p1`. Its parent is `9c85103c3`.
- **Source hashes, recomputed:** the coordinator is `34fac286…` and the test is `d58f04aa…`. `shared/chat/runtime.ts` is unchanged at `3d30b01c…`.
- **Execution credit: ZERO.** No tests, types, lint or mutants have run, and the original refusal is preserved.

## The fixes from `f337627d`

- **P1-a: RESOLVED.** `closeAdmission` is renamed `revokeScope`, documented as scope-wide permission or membership revocation and not ordinary completion. **There's no alias**: git grep finds no remaining `closeAdmission`. A new test checks that ordinary retirement of one attempt leaves concurrent work and admission in the same scope live.
- **P1-b: RESOLVED.** `tryEnter` is documented as live-resource only, and pre-spawn argv entry needs a separately reviewed extension.
- **P1-c: RESOLVED.** `resetForTests` throws `test_environment_required` **before any mutation** unless `VITEST === 'true'` and `NODE_ENV !== 'production'`. It is tested for both production and a missing runner, with no change to owners, tickets or timers.
- **P1-d: RESOLVED, with a new mechanism reviewed explicitly below.** `allowed()` now means `state.open && record exists && !retired && live(record)`. It is memory only and synchronous.
- **P1-e: RESOLVED.** `RuntimePreIntentRefusal` carries a reason of `scope_closed`, `scope_held`, `lease_not_current` or `admission_not_current`. It is thrown from `captureAdmission` and `createHandoff`, while unregistered inputs still raise generic errors. The documentation says it is never evidence about an already-persisted attempt.
- **D1:** the hook signatures are unchanged.

## The new WeakRef ticket reference, reviewed explicitly

- **The mechanism:** a ticket now holds `new WeakRef(record)` instead of a strong closure over the record, so a driver-held ticket doesn't keep the owner or journal hooks alive.
- **Lifetime is safe:**
  - A live record that isn't retired is held **strongly** by `frame.handoffs` and `admission.handoffs`, and by the `handoffs` WeakMap while the handoff object is reachable. It **can't** be collected while its ticket should still be valid.
  - Once a record is retired or abandoned, `deref()` may return `undefined`, and `allowed()` returns **false**, failing closed.
  - **No strong fallback:** if `WeakRef` isn't available, `transportAdmission` rejects with `weak_reference_unavailable`. That is tested, along with a stub whose `deref()` returns `undefined`.
- **Runtime support:** Electron's Node has had `WeakRef` since Node 14.6.
- **Typing:** a module-local `declare const WeakRef` avoids raising the target above ES2020, and it emits nothing.
  - **Watch item (unverified until lint and tsc run):** `@typescript-eslint/no-redeclare` with built-in globals, or a lib that already declares `WeakRef`, could flag that shadowing.
  - If so, prefer `globalThis.WeakRef` with a narrow local type over relaxing a lint rule.
- **`ticketAllowed` is a class method that isn't exported through either port.** Its closure calls the module singleton.

## Caveat that P5 must honour

- In the design, Q5 calls `createHandoff` **after** appending a durable intent.
- A `RuntimePreIntentRefusal` at that point happens **after the intent exists**. There's no handoff, so the coordinator can't invoke `onLoss`.
- Q5 must therefore route that case to its **own** loss claim, unsubmitted where the claim allows it, and must not treat the name "pre-intent" as proof that no intent exists.
- The README's existing-intent caveat covers this. The P5 consumer review must check it.

## Verdict

- The static source is consistent with the contract, and all five fixes are in.
- **The WeakRef design is ACCEPTED statically**, failing closed with no strong fallback.
- **Not approved for a PR.** Run tests, tsc, lint (including the `WeakRef` declaration) and the mutants on exact `c61665ca1` once the repaired gate admits a run. Then I'll do an exact-source re-review against those receipts.
