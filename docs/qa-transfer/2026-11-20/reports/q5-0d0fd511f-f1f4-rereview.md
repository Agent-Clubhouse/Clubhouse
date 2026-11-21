# Independent QA re-review: Q5 foundation F1–F4

Reviewer: qa-details-local-composition. November 21, 2026.
- **Source:** `0d0fd511f54c0055bfcfffbeeb139bb5c4d47f33`, tree `bdfd8e3f…`. One commit on the audited `36e66d2bc`, on both the ledger and evidence branches.
- **Evidence:** `583886de660c619a8b0e77089f35b63c37335f7f` (`origin/auto-reset-policy-design/q5-ledger-evidence`, remote verified).

Method: I read source and artifacts only and ran nothing. Foundation only, not runtime, phone or feature acceptance.

## Verdict

**F2, F3 and F4 are resolved. F1 is resolved for the acceptance path. One new narrow finding, G1, comes from the F1 design. CHANGES REQUESTED (narrow).**

## Resolved

- **F1, acceptance provenance:**
  - `append()` refuses a direct `settle accepted`. Acceptance only goes through `captureLiveHandoff`, then `markHandoffEntered` (synchronous, once), then `acknowledgeLiveHandoff`.
  - The handle is a frozen branded object held in a `WeakMap` and bound to `attemptId`, `coverageDigest` and the journal's per-open `handoffProcess` UUID, which is persisted on the intent.
  - The reducer requires the `same-process-exact-handoff` provenance to match the attempt's `handoffProcess` and digest. **A `recovered` attempt can never accept.**
  - A late exact ACK on a `handoff_unknown` uncertain attempt confirms it and increments `lateAcknowledgementCount`, so the anomaly is kept as an aggregate. A repeated acknowledge is idempotent.
  - Journal replay validates the persisted provenance, and a reopen mints a new process UUID, so old handles can't confirm recovered attempts.
- **F2:** the contract now keeps **fail-closed** behaviour for complete or checksum damage and zero-filled damage, documents the liveness cost explicitly, and adds no tail repair. That is acceptable as an explicit decision.
- **F3:** renamed to `excludedSequenceCount`, documented as counting sequence positions (including non-post changes), never messages. The checkpoint count check is updated.
- **F4:** a scan with 50 eligible posts must end exactly at the last eligible seq ("Capped notice scan cannot over-advance its frontier").
- **Also:** `boundedId` now rejects DEL (0x7f).

## G1: an entered handoff can still be settled `unsubmitted`

- `markHandoffEntered` records `entered` only inside the `WeakMap` record keyed by the handle (journal.ts:113-122). The `settle unsubmitted` path (`append`, then `enqueue`, then the reducer) never consults it.
- After actual provider entry, a buggy or late runtime report of "dropped before entry" therefore releases the attempt's posts back to **ready**, so an automatic re-dispatch could **duplicate** a notice that was entered.
- That contradicts the contract: once send is entered, failure is unknown and cleanup can't make it unsubmitted.
- **Fix:** keep an `enteredAttempts: Set<attemptId>` (or reverse map) in the journal. For an entered attempt, refuse `settle unsubmitted` or coerce it to `uncertain` with reason `handoff_unknown`.
- **Test:** capture, enter, then settle unsubmitted should be refused or end uncertain, with the posts not ready. Add a mutation that removes the guard and fails that test.

## Evidence (`583886de6`)

- The evidence commit differs from `0d0fd511f` only under `docs/evidence/q5-foundation/`.
- The manifest has 9 receipts, the earlier 6 preserved plus 3 new.
- The 3 new receipts (`0d0fd511f-{tests,types,lint}`): each receipt and raw-output SHA256 matches the manifest. The head is `0d0fd511f` before and after, status is clean, `sealEqual` is true, and **all 14 source SHA256s equal the blobs at `0d0fd511f`**.
- **Results:** tests **40 passed** across 3 files, exit 0. Types exit 0. Lint exit 0 with no problems.
- **Preserved:** the earlier `36e66d2bc` / `02cc25242` evidence and the `922542843` lint failure.

## Still out of scope

Runtime integration of `markHandoffEntered` at the real provider entry, the phone shared generation, memory-resident sparse rows (with the lazy-index successor in progress), the marker, post-ID mode, the UI, the platform, and product latency.
