# Prepared sparse-root reader, not authoritative state

Exact source `a3b653e349bd89056a2b87ef5ba1308a7e43d0ef`, tree
`b578b09ea69b00ec5fb01a1e90819f722551a521`, pushed on
`auto-reset-policy-design/q5-durable-delivery-ledger`. Prior approved71 journal
and its mutation evidence remain unchanged; only new sparse-reader source/test
and progress documentation changed. Independent bounded reader review required.

## Scope and invariants

The internal `PreparedNoticeReader.openPrepared` accepts a prepared header,
metadata and six immutable page roots: terminal ranges, pending posts, ready
posts, attempts, active attempts, post-ID lookup. The distinct header profile
is sequenced-sparse-v1/schema1/minWriter2, capped16KiB. It rejects unknown root
kinds and unsupported versions. No current journal codec stores/activates this
header; no existing array checkpoint or legacy data is converted.

Opening verifies every referenced immutable page, then merges terminal ranges
and pending sequence rows to prove exact contiguous coverage from baseline to
scan. It merges spans instead of iterating each excluded sequence. Adjacent
terminal ranges must already be merged. Counter totals must match terminal
coverage, which includes accepted or scan-time-excluded positions. Pending
post-ID, ready, attempt and active references are checked in both directions;
attempt digests, exact bounded coverage and supported uncertainty reasons are
validated. Missing/malformed/damaged references refuse, never silently repair.

The reader retains a fixed metadata/root header, not a full sparse-state array.
Verification iterates16-row batches through the existing bounded page cache;
point lookups retain existing limits. Queries return at most50 ready posts or
attempts. Cursors are lexical keys intended for the same immutable reader/root,
not timestamps or a secure cross-root UI cursor. Future IPC must bind cursor
identity to the committed root and caller; this module supplies no IPC authority.
Legacy floor reflects only contiguous terminal coverage, not scan progress.

Successful verification is **not** proof of durable commitment, expected-recipient
authorization, a current member generation, nonce consumption, subscription/grant
or runtime admission. The future journal/catalog owner must authenticate the
header/recipient and atomically commit its root. This module neither enters nor
settles attempts, sends, recovers runtime work, migrates or activates baselines.

## Actual observed proof

| Exact head | Admitted command | Result |
| --- | --- | --- |
| a3b653e34 | Vitest main sparse-reader.test.ts, maxWorkers2 | exit0;17passed/1file;1.78s total,1.68s tests |
| same | full root `tsc --noEmit -p tsconfig.json` | exit0 |
| same | new reader source/test ESLint | exit0;0errors/0warnings |

Large synthetic fixture has513 pending posts,512 attempts (511 uncertain and
one queued),513 terminal single-position intervals, one ready post and one
active attempt. Cold opening and paginated reads execute against actual temp
files. Assertions observe no more than256 cached leaf entries/4 leaf pages,
16 reference pages, header under4KiB and at most50 returned attempts per call.
Every attempt is paged exactly once in the unchanged-root enumeration; later
ready/active work remains queryable while the earlier hole retains floor0.
No manifest is created. A separate large excluded range checks span handling.

Negative controls cover missing/orphan/owned ready rows, missing/orphan post-ID
rows, missing/extra attempt coverage, missing/uncertain active pointers,
coverage gap/overlap, genuinely adjacent terminal intervals without a pending
overlap, counters, key mismatch, noncanonical sequence keys, future headers,
unknown roots, invalid query bounds, uncertainty reason and missing page files.
Returned header/details are detached copies. Tests remain transpile-only;
the root ES2020 compiler excludes tests and is not claimed as their typecheck.
The Vite advisory is preserved in raw output.

These are read/cache functional checks, **not** full-process heap or combined
hot-detail proof: temporary batches, cloned rows and attempt post vectors also
occupy memory. No product latency/disk-size guarantee, physical power-loss or
native Windows proof follows from the synthetic fixture duration. The existing
old journal still loads full sparse arrays. Incremental authoritative updates,
shared journal codec, root activation, index GC, post-ID/R1 adoption, migration,
runtime/phone, local-human UI and integrated memory/performance remain open.

All three commands admitted sequentially inside desktop-test-gate, min4
tests/lint,min6 compiler; no refusals/retries/cancellations or broad reruns.
Each receipt binds exact clean equal before/after head/tree and24 source hashes,
exact argv/time/exit/raw. New hashes were matched against exact Git blobs and
all41 receipt/raw hashes verified; prior38 index entries remain unchanged.
Evidence packaging head is not the tested source. Worktree-only matched cache
linkage was reversed and original node_modules restored. No installs, shared
writes, app imports, settings changes, access changes or activation occurred.
