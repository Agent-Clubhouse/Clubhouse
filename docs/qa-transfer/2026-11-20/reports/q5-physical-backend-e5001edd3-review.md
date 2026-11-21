# Independent QA: Q5 private physical backend extraction contract (docs only)

Reviewer: qa-details-local-composition, November 21, 2026.

- **Target:** `e5001edd3b405371522db938db923d5d7024a01c`, tree `f3ffbd6870a6f1419feb57036d21ad9762cf976c`, which matches `origin/auto-reset-policy-design/q5-physical-backend-contract`. Its parent is `c0dea82e4`. The C1 successor isn't copied in.
- **Document:** `docs/design/q5-physical-backend-extraction.md`, sha256 `44e3b62d…aa8b6` (recomputed), 200 lines.
- **Method:** read only. I spot-checked `71bd` `journal.ts:280–293`. The claim holds: `this.revision`, `this.digest` and `this.state` are assigned at 289 **before** `await this.readCurrent()` updates `currentFileHash` at 292.

## Verdict

**APPROVE the extraction boundary as implementation-ready for one unwired private candidate,** subject to the corrections below. It is source and design only, with no execution credit, no producer, runtime or catalog activation, and no IB3 closure.

## Accepted elements

- **The split, by ownership:**
  - `framed-journal.ts`, the sole file-set owner and **only queue**, with no runtime, receipt, UI, nonce, board or network concerns;
  - `legacy-codec.ts`, which preserves bytes, extras, namespace and unbounded legacy cold state, honestly;
  - `root-codec.ts`, a closed, versioned, fixed-recipient profile with no catalog or activation;
  - `journal.ts`, the single receipt and settlement owner above codec selection.

  There's no wrapper with a second `.work` chain, no configurable engine, and nothing in it is serialized or reached through IPC.
- **The queue protocol:**
  - an exact authenticated expectation, rechecked inside the queue;
  - candidates are inert until barriers on every new reference succeed, with no plain `flush()` Boolean accepted;
  - a recheck after awaits;
  - root frames of at most 64 KiB, with no truncation or pretend multi-record atomicity;
  - rotation inside the same queue;
  - append, sync and directory barriers, then final file-hash bookkeeping, **then** one non-yielding publication;
  - a publication exception poisons the owner;
  - the actual committed result is returned, and reopen reconciliation never resends.
  - **The reordering of bookkeeping before publication is correctly declared as deliberate hardening,** with a held or failing control.
- **Legacy preservation:** field order and framing, bounds, chain, extras and namespace, with no conversion, no new field on old records and no reinterpretation of old installation markers.
- **Checkpoint ordering:** pages sync, then the manifest commit, then publication, then GC of retired files.
- **Corruption:** a partial last frame is preserved, then trimmed. Complete damage is preserved and fails closed.
- **Withholding root GC** is stated explicitly as **unbounded obsolete-page retention that does not meet product acceptance.**
- **Own-temp cleanup** follows M1-L and is tested separately.
- **The sealed barrier API** is a new change to the landed `pages.ts` (#3768) with its own exact review and platform proof. This matches my `c0dea82e` dependency note.
- **Ownership:** one shared receipt manager for both profiles, synchronous registration before queueing, and claims never rebuilt from disk. Anchors are minted only after durable intent. ACK first and loss first are defined, recovered attempts never mint an ACK, and the frozen hooks and the post-intent caveat carry forward.
- **Recovery:** it is internal, behind closed storage admission, and **repeatedly selects the first 50 or fewer active entries from the newly committed root.** That avoids a stale-cursor skip. A failure refuses sends.

## Corrections required in the implementation candidate

1. **PB-1, recovery progress guard:**
   - "Repeat first 50" only terminates if every batch makes progress. The `224e` `prepare({kind:'recover'})` returns `this` (no change) when the selected attempts aren't recoverable.
   - Corrupt or unexpected active entries that don't shrink would loop forever.
   - **Require:** if a committed batch leaves the active set unchanged, or selects the same IDs again with no state change, then **poison or refuse with a typed reconciliation status, never spin.** Add a control.
2. **PB-2, claim release on validation versus IO failure:**
   - "Failed claimed producer keeps visible failed ownership rather than removing its fence in a generic `finally`" is a **deliberate change** from `71bd`, which releases the settle hold in `.finally` on any rejection.
   - Make the distinction explicit:
     - (a) a deterministic validation refusal with no effect may release the claim, because otherwise one benign refusal blocks an attempt forever;
     - (b) an IO or ambiguous failure poisons the owner, which makes all claims moot until reopen reconciliation.
   - Add controls for both.
3. **PB-3, duplicate open inside one process:**
   - "Opening a second instance is not a CAS claim" is honest.
   - Still add a cheap per-process path registry, like the installation `opening` map, that **refuses** a second backend instance for the same file set. That turns an accidental second writer in one process into a typed error.
4. **PB-4, anchor bound:** capability anchors are kept in memory **for each active attempt**. State the bound explicitly: it is proportional to active, non-recovered attempts, and invalidated on recovery or settlement. Prove release on settle, recover and retire. Don't cite the index cache as the bound.
5. **PB-5, publication phase contents:** list exactly what the non-yielding phase sets: revision, digest, state, segment bytes, current file hash and anchor invalidation. Include a mutant that moves any of them before sync or before the bookkeeping await. The held-bookkeeping control must show **no** new state **and** no new capability while held.

## Implementation-ready private boundary

- **One unwired candidate**, as the document proposes, containing:
  - the four-module extraction;
  - the root codec, commit and reopen;
  - the shared typed ownership registry;
  - repeated-first-50 recovery.

  It should include the legacy read bridge, single-queue discrimination, root and barrier discrimination, recovery of 51 or more entries, and typed ownership controls and mutants, plus PB-1 to PB-5.
- **The `pages.ts` sealed barrier API** may land in the same batch, but needs its own exact source review and Windows and POSIX proof.
- **Not unblocked:** production binding, catalog partition, R1 activation, migration, UI, root GC and compaction, IB3, the C1 scan adapter, or bounded combined memory.
