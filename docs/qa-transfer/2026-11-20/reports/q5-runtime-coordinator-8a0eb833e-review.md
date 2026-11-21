# Independent QA: Q5 runtime coordinator binding, corrected contract

Reviewer: qa-details-local-composition, November 21, 2026.

- **Target:** `8a0eb833e81956e3a0e2674fc276e028587d8c64`, tree `aa984103b154f67c31d8e2ce25e3c315459cad23`. It matches `origin/lane-3613-p2-routes/q5-runtime-contract`, and its parent is `4388d2085`.
- **Document:** `docs/design/q5-runtime-coordinator-binding.md`, 747 lines. I recomputed its sha256, `8c14df58…07d6`, and it matches.
- **Method:** a read-only design review. No code, test, schema or runtime credit.

## Required items from `2edfa73e`

- **I-1 forgeable tickets: RESOLVED.**
  - Handoffs and admissions have **distinct** `unique symbol` brands, **and** they are registered in the sole coordinator's private `WeakSet` registries when issued.
  - Ingress checks `isRegisteredHandoff` and `isRegisteredAdmission` **before** calling any method or driver. Fabricated, cloned, cross-coordinator or unregistered values are rejected through the explicit error boundary, never treated as untracked input.
  - Registration doesn't imply liveness, so generation and admission checks still apply.
  - Constructors aren't exported through IPC, tools, preload, renderer or plugins.
  - There's a fabrication control, with an unchecked-brand mutant that must fail.
- **I-2 single loss owner: RESOLVED.**
  - The coordinator alone invokes `hooks.onLoss`, at most once, through one retirement transition. All discard, failure and teardown paths and repeated `retireHandoff` calls converge on it.
  - `retireHandoff` returns informational `RuntimeRetirementInfo` only. `lossSettlement` reuses the same claimed promise, and is `undefined` only when the journal owns the outcome. It never returns a fake success.
  - A `journal_owned` entry triggers **zero** loss hooks.
- **I-3 journal hold: RESOLVED, as a dependency on a proposed Q5 API.**
  - `tryEnter` returns `entered`, `rejected` or `journal_owned`. Only the runtime's own pre-marker guard yields `rejected`.
  - The proposed atomic `tryMarkHandoffEntered` returns `entered` or `journal_owned`. Held, sibling-entered, consumed, uncertain, stale or unhealthy cases all return `journal_owned`, with no mark, no `onLoss` and no retry when a hold releases.
  - **Unexpected exceptions mean UNKNOWN**, not a blanket "not entered", and there's no catch-all and no string matching.
  - The proposed loss claim atomically owns the settling fence before any yield and schedules at most one producer. A declined claim appends nothing, and the actual committed outcome, including coercion, decides the result.
  - The capability is retained while a genuine bounded ACK source is outstanding.
  - This matches the Q5 assessment at `eb23ded25`, which the contract binds by sha256.
- **I-4 ACK: RESOLVED.**
  - **Every backend, including Codex, is UNKNOWN after entry.** No mapper is approved or wired, and a branch labelled `approved_handoff_ack` can't be promoted initially.
  - Raw or cast Codex responses are only candidates.
  - The distinction from `d031` (labelled weaker PTY handoff) is stated as a deferred subset, not a redefinition.
  - `71bd` has **no** durable receipt-strength schema, and none is authorized.

## Non-blocking items from `2edfa73e`

- **N-1 hold lifecycle:** RESOLVED. Scope holds have a finite monotonic deadline. Success, denial, a throw or abort, and expiry all terminate the hold with visible status. Expiry never restores old tokens. The production budget is deferred to P5.
- **N-2 tracked-only Copilot gating:** RESOLVED. The gates apply only with a registered tracked admission, covering `commands.invoke`, the mode and prompt effects and `setModel`. Untracked behaviour is unchanged.
- **N-3 ingress inventory:** RESOLVED. The construction and carry sites are listed exactly (delivery, wake, lifecycle, chat, group, MCP, dispatcher, actions, annex, plugin, preload). **No existing ingress constructs a handoff**, and Q5 delivery and wake are the only proposed callers. Future controls go through the plugin preload and IPC path.
- There are now **22 controls**. The new ones are brand fabrication, single loss owner, journal ownership and exceptions, and finite scope hold.

## P1 readiness: READY, with three precise dependencies

**P1 scope:** the unwired coordinator, the unique-symbol brands, the `WeakSet` registries, the issue, retirement and at-most-once loss latch, finite scope holds tested on a fake clock, and focused unit controls. **No consumers, no journal edits and no ACK mapper.**

- **D-1, interface fidelity:** before P1 merges, Q5 must confirm that the hook signatures P1 freezes match the `eb23` proposal exactly: `markEntered(): 'entered' | 'journal_owned'` and `onLoss(outcome): RuntimeLossClaim`, either `journal_owned` or `claimed` with a committed promise. The orchestrator says Q5 is checking this.
- **D-2, a clarification for P1 tests:** when `markEntered` throws unexpectedly, state that the coordinator records UNKNOWN **and** invokes the single loss hook with `'unknown'` exactly once, so the claim can commit uncertainty. It must not skip the hook or retry it. Also say what happens if `onLoss` itself throws synchronously. The contract specifies a failed settlement promise with the latch kept, which P1 should test directly.
- **D-3, no journal edits in P1:** P1 uses **fake** hook implementations. The real `tryMarkHandoffEntered` and loss-claim primitives are Q5-owned P5 work and need their own exact review against `71bd`.

## Dependencies outside P1, unchanged

- P2 and P3 need actual-ingress zero-call proofs.
- P5 needs the Q5 journal API, the production hold budget and status sink, and exact grant and store queue review.
- Any future ACK mapper needs explicit Q5 acceptance plus shape, provenance, timeout and late-response negatives.
- A durable weaker-receipt schema needs its own review.

## Verdict

- **The corrected contract is APPROVED, with I-1 to I-4 resolved.**
- **P1 is implementation-ready** under D-1 to D-3.
- No consumer, runtime, ACK, schema, phone or grant acceptance.
