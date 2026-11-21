# Q5 root/backend state batch — unintegrated work in progress

Canonical issue3758. This task branch starts from actual fetched main
5bbabde2d9f6dcb4db248d0976681fc331f5611e after isolated index PR3768.
No app caller, runtime/type/recovery/driver hunk, settings or permission changes.
The five landed index/durability/fixture files remain unchanged. Prior research
refs and accepted receipts remain frozen; source copying transfers NO test run
or whole-branch acceptance to this branch.

First dependency is incremental root state. PreparedNoticeState applies bounded
scan/intent/queued/settlement/recovery selections to six immutable indexes,
retaining prior roots and selected input ownership. Recovery is explicit
at-most50 attempt IDs; the future owner must walk the active index and commit
all necessary recovery batches before sending. Uncertain holes never become
ready; later selected work stays independent. Header/recipient unknown fields
refuse before verification; there is no best-effort schema stripping.

These are PREPARED root transitions, not committed state. An accepted-shaped
delta is reducer data, NOT a live ACK capability. The future one physical journal
queue must enforce the reviewed71bd receipt/entry/settlement arbitration, bind
full identity/expected revision, validate every newly authoritative reference,
earn page/file/directory barriers, append/sync one bounded root transaction, and
publish only its committed root. Preparation or flush alone cannot activate,
consume a nonce, authorize a handoff or establish a generation. No second
receipt manager, runtime coordinator or independent catalog commit queue.

The array state reducer/intervals/prepared reader are copied from frozen
cacbb88f4d69b58a45e80a4781e72bb904e669b8 only as private dependencies/oracle.
Their historical review scope stays separate; sparse-reader header key
strictness and sparse-state are new. Imported-source-bridge.json identifies
exact bytes. Journal extraction, authoritative incremental codec, catalog/R1,
migration, UI/revocation/runtime binding and combined memory proof remain
unimplemented. No PR is proposed for this small slice; combine coherent
dependencies and exact proof/review before any future integration PR.

Tests use a bounded independent full-array oracle, >256 old uncertain details,
new-work liveness, cold prepared reopen, old-root preservation, recovery batches,
cap50 completeness, MAX_SAFE_INTEGER arithmetic, unknown fields and failed
preparation. They do not prove hardware crash/powerloss, committed activation,
whole-process heap or real provider delivery. The directory/cache bookkeeping
retains the previously stated per-index cache bound only.

Status at initial commit: UNVALIDATED; no earlier test counts transferred.
