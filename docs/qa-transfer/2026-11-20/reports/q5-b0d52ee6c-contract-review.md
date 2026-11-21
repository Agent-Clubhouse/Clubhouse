# Independent QA: Q5 durable notice ledger contract

Reviewer: qa-details-local-composition. November 21, 2026.
Target: `b0d52ee6c384386ef46eba3028634d7fc9d60473` (`origin/auto-reset-policy-design/q5-durable-delivery-ledger`, remote verified), docs only on main `d8c7247a4`.
- `docs/design/q5-durable-notice-ledger.md`: SHA256 `adab3f13…c121ab` matches.
- `docs/design/q5-issue-publication-draft.json`.
- The canonical issue is now #3758. The draft's earlier "not created / blocked" text is historical.

Method: I read the contract and source only and ran nothing.

## Verdict

**CHANGES REQUESTED to the contract: 3 major items (C1–C3), then implementation may start.**
- The core model is sound: per-ID coverage, separate scan and confirmed frontiers, conservative unknown-after-entry, one-use retry, and no stored content.
- Each of C1–C3 can silently turn "keep notices flowing" into a **de facto persistent stop** for a recipient or group. That contradicts the user's decision and §Guarantees 4.

## Areas assessed with no blocker

- **Per-ID coverage against the frontier:** `baselineThrough` (the legacy cursor, explicitly not delivery), `scannedThrough` (the scan frontier, not an ACK) and per-post dispositions are distinct.
  - Coverage keys are `(recipient, seq, postId)`. A same-seq/different-ID pair is a conflict, and attempt keys use a coverage digest, so one key with different coverage is refused.
  - Confirmed later coverage never resolves an earlier hole.
- **Settlement ownership:**
  - Both the busy and the apparent-idle paths install receipt-aware ownership, with the returned mode governing.
  - Callbacks before return, after return and duplicated are safe on the serialized owner path.
  - The added `unknown` settlement is applied exhaustively, including the Actions consumer, with no fabricated cancel.
  - Once `session.send` is entered, the outcome is unknown.
  - A wake Boolean `false` stays uncertain, with no resend after wake.
- **Durable intent and crash windows:** intent is saved before handoff. An unsaved ACK stays uncertain. Commits use a temp file, flush, rename and directory flush where supported. The power-loss limit is stated honestly, and an ambiguous commit blocks handoffs.
- **Pre-entry revocation:** a typed owner admission hook runs at queue entry and is not serialized. Removal is by exact ID, and late callbacks are fenced to their generation.
- **Retry:**
  - Local-human IPC only, never an agent, Annex or timer.
  - The nonce is bound to recipient generation, batch, revision, single use and 5 minutes.
  - Consuming it and creating the child intent happen in one transaction before handoff.
  - Cancelling before confirmation writes nothing. A lost reply becomes a status lookup, never a re-send.
- **Content privacy:** no bodies, names, prompts or provider errors in the ledger or telemetry. Retry text is re-read from the board under current grants.
- **Old readers:** the `.required` marker with an installation UUID is honest about its limits. Older binaries are not ledger-aware, and downgrade needs the documented "notifications off" procedure. Concurrent cross-version writers are blocked by the single-instance lock (`requestSingleInstanceLock` exists in `protocol-service`).
- **Go #626 boundary:** the capability is advertised only after implementation. There is no remote route, `expectedState` clear/forget is not borrowed, and chat is preserved by default.

## Major findings

**C1: capacity under a long-lived uncertain hole halts a recipient.**
- Compaction can only go "below a floor with no … uncertain hole", and there is no waiver or mark-read in v1. So a single early uncertain hole forces every later confirmed post row for that recipient to be retained individually.
- At the proposed 10,000 rows per recipient (100,000 overall, 16 MiB), a busy group reaches the cap. The contract then refuses visibly, which **stops notices to that member**: a persistent pause by another name.
- The 16 MiB file is also fully rewritten and fsynced on every commit, which scales poorly.
- **Fix:** represent confirmed and excluded coverage as **sequence intervals** (a run-length or range set), keyed by `(seq, postId)` only where an ID is needed for a hole or an active attempt. Retention cost then depends on the number of holes and active attempts, not on later traffic.
- Bound the number of holes, not the number of posts.
- Optionally shard per recipient, or use small segment files, to keep each commit small.
- Define what happens when the **hole** count, not the row count, reaches its bound. That should be visible and must not block later notices.

**C2: an identity change is "held for inspection" with no resolution path.**
- A changed host identity or a regressed or conflicting board identity is "visible and held". After a legitimate re-pair or fingerprint change (compare #3645), every notice for that group stops indefinitely.
- **Fix:** specify an explicit **local-human adoption action** that retires the old generation as tombstones (its uncertain attempts stay recorded and unresolved) and starts a new generation from a fresh baseline. Use the same IPC trust rules as retry, with no automatic adoption.
- Specify what the UI shows meanwhile.

**C3: older, unsequenced board messages lead to silent indefinite deferral (mixed-version).**
- `BulletinMessage.seq` is optional, "Absent on older messages" (`src/shared/group-project-types.ts:253-254`, #3356).
- The contract says a post without a valid sequence or stable identity "cannot form a guessed coverage key; defer … pending authoritative board data". For groups whose host predates sequencing, or posts written before it, notices would be **deferred forever**, with no visible state.
- **Fix:** state the minimum host or board version for ledger coverage, and specify the behaviour below it. Options:
  - (a) keep legacy notify semantics for unsequenced groups, with a visible "older host: delivery not ledgered" status;
  - (b) a postId-only coverage mode with explicit ordering limits.
- It must never be a silent stop. Add a mixed-version control.

## Implementation controls (beyond the contract's proof table)

1. **Retry IPC trust:** the retry handler must check the sender frame or window, as other privileged IPC does, so plugin webviews and non-main renderers can't call it. The nonce should be minted by main and persisted on consumption.
2. **Legacy cursor on downgrade (suggestion):**
   - Freezing `notified` at the migration baseline means an un-procedured downgrade replays everything since migration.
   - Consider advancing the legacy cursor only to the **contiguous confirmed-or-excluded floor**, the lowest hole minus 1. That is truthful in the old semantics, never skips an uncertain ID, and bounds downgrade replay to the region above the first hole.
   - This doesn't change the documented procedure or the "unsupported" status.
3. **Admission hook:** it must be synchronous at the provider-entry point, must not await while holding the queue, must not retain owner references after settlement, and must never be reachable by drivers.
4. **Wake:** the wake budget is still consumed on an uncertain wake attempt, as stated. Test that a refused budget pre-check creates no intent.
5. **Excluded classification:** relevance (subscription or mention) is decided at scan time. Document that a later subscription change does not re-notify previously excluded posts, matching current behaviour.
6. **Per-commit cost:** measure commit latency at the C1-revised bounds in a temporary-directory test, and seal the result.
7. **Mixed-version control** for C3: a sequenced and an unsequenced group side by side, with notices to the sequenced one unaffected.

## Not claimed

No exactly-once execution, end-to-end delivery, provider idempotency or power-loss durability, consistent with the contract. Contract approval and hunk coordination must precede any product edits.
