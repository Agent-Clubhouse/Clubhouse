# Exact8a0 ledger interface concurrence

Reviewed8a0eb833e81956e3a0e2674fc276e028587d8c64,
`docs/design/q5-runtime-coordinator-binding.md`, independently recomputed SHA256
`8c14df58a7ba2dc08db1fff3a6f074073ee00b3cea98b3901fd4d68e65f507d6`.
Comparison input is the preserved ledger assessmenteb23ded2540148236ad1540a259103d71922de9b,
`docs/evidence/q5-foundation/runtime-4388-ledger-compatibility.md`.

Verdict: ledger INTERFACE/HUNK CONCURRENCE for the corrected contract and
unwired coordinator P1, subject to independent host/security review. No remaining
contradiction in the corrected host-facing mapping was found. This is not
acceptance of executable Q5 binding, consumers, schema, ACK sources or whole Q5.
No shared source edit, resource-gate retry or test was performed by this review.

## Fidelity and exact D1 signatures

Frozen lines72/129–132 define precisely:

```ts
type RuntimeJournalEntryDecision = 'entered' | 'journal_owned';
interface RuntimeAttemptHooks {
  markEntered(): RuntimeJournalEntryDecision;
  onLoss(outcome: RuntimeLoss): RuntimeLossClaim;
  onReceipt(receipt: RuntimeHandoffReceipt): Promise<void>;
}
```

`RuntimeLossClaim` is a discriminated `journal_owned` or `claimed` with ONE
already-started committed promise returning actual unsubmitted/uncertain outcome.
This matches eb23. It is not the original Boolean marker/async-void loss hook.
The runtime-facing tryEnter result remains a separate discriminated object:
entered/rejected/journal_owned. Drivers' allowed() stays Boolean and ledger-free.

The corrected freeze retains zero loss hook/append for journal_owned; runtime-only
pre-marker rejected; sole at-most-once loss invocation; actual persisted disposition
rather than requested loss; unexpected exceptions UNKNOWN with visible failure;
no hold-release retry/recapture; original bounded historical capability lifetime;
all-backend UNKNOWN including Codex and fabricated approved-ACK shapes; and the
d031 weaker-PTY definition/absent durable-strength-schema distinction. Authority
and hunk split is unchanged and compatible: host owns shared runtime/types/drivers/
lifecycle, Q5 owns journal/root and later reviewed consumer adapters.

## D2 failure compatibility

An unexpected marker throw is UNKNOWN and invokes the sole loss hook once with
unknown. It is not treated as typed journal_owned or a rejected/unsubmitted
candidate. The Q5 loss CLAIM can nevertheless decline an existing journal owner;
that is zero new producer, not a second fallback settlement. A synchronous loss
hook exception creates/reuses a visible FAILED settlement promise, retaining the
at-most-once latch. Never return undefined as a success substitute, retry the
hook/producer, or append an invented disposition. P1 fake hooks must exercise this;
they do not prove the real journal APIs.

## Required Q5 successors before binding

The accepted71bd journal exposes NONE of the proposed typed entry/loss-claim API.
Q5 must implement and independently prove one atomic typed marker; one exact-
capability loss claim with synchronous shared settlement fencing and actual
commit/failure result; bounded historical capability lifetime; and actual durable
intent/lease/admission/queue consumer integration. Retain the single physical
journal queue, receipt manager, irreversible entry and current regression controls.
Prepared root-state224e supplies none of this authority and remains unvalidated.

A concrete arbitration dependency is ACK-FIRST ownership: accepted71bd
acknowledgeLiveHandoff134–143 queues its ACK without installing append's synchronous
settling fence. Wrapping that API cannot prove the new loss claim. If ACK is
already queued first, a subsequent loss can see a missing attempt after ACK commits
and no-op; reporting committed uncertain/unsubmitted would be false. The successor
must make ALL competing settlement ownership, including dedicated ACK, synchronously
visible to the same claim guard (or decline before claiming). No second queue or
receipt manager. Prove ACK-first declines/no new loss producer; loss-first returns
its actual committed outcome; genuine later ACK affects only original history;
and duplicate handles, release, held/recovery and producer-failure boundaries.

No backend ACK mapper is approved here. A future one requires exact native
correlation/runtime shape/semantics and negative-source proof plus independent
review. Existing local observations may yield uncertainty; no durable weaker-
receipt field is introduced. No provider processing or SDK drain claim follows.
