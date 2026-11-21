# Bounded immutable-page reads before decoding

Exact source `0826faa448f83738d3b4cd3b030c5c5eb665f49a`, tree
`9a1e718b1c78abd0d52c6dd048ff6d3b66a8e7da`, pushed on
`auto-reset-policy-design/q5-durable-delivery-ledger`. Prior accepted prepared
reader a3b/ce425 and approved journal71 remain preserved. Corrected independent
a3b report is8097a82fc689313f684a71f6f250d90b833ece5e (not146f9a7).
Only reader verification and targeted index read dependency had been assessed;
this supplement does not relabel prior index writes/eviction as approved.

## Source finding and correction

Previously page load and existing-page reuse called readFile before the size
check, so a damaged oversized file could allocate unbounded input memory before
refusal. This is a source finding, not a measured provider/app incident.
Both paths now use a private capped reader. It lstat-checks a regular final
file and size before allocation, opens it, compares descriptor identity and
size/mtime/ctime, reads into a fixed256KiB+1 buffer, then checks read length,
descriptor and final path again. Oversized/changed inputs refuse before decode;
existing damaged pages are never replaced to keep work moving. Final-path
directories and symlinks refuse. Fixed-shape diagnostics record actual bytes,
without IDs or notice content.

This is not interprocess CAS or protection against hostile parent-directory
replacement; the existing single-main/owned-path premise remains. The cap
does not bound total process heap or all transient parsed object copies.
Legacy array-journal checkpoint reads are unchanged and retain their separate
memory gap. No native Windows or physical power-loss proof is claimed.

## Exact observed proof

| Command inside admission | Result |
| --- | --- |
| Vitest main pages.test.ts + sparse-reader.test.ts, maxWorkers2 | exit0;30passed/2files;17.52s elapsed,20.55s summed tests |
| full root ES2020 `tsc --noEmit -p tsconfig.json` | exit0 |
| changed pages source/test + sparse-reader test ESLint | exit0;0errors/0warnings |

Oversized-file controls execute both cold load and existing-content reuse,
observing zero page content bytes read and preserving exact damaged bytes.
Directory and symlink replacements refuse without following/removing them.
The symlink fixture executed on this Darwin host, no skips; only an actual
Windows EPERM/ENOTSUP/EACCES fixture-creation refusal would explicitly skip.
No new permissions are requested. Supported unchanged functional index/reader
controls also execute, including cross-index validation and pagination.

Two relevant reader-review follow-ups now execute: two pending sequence rows
with the same post ID refuse because one exact reverse mapping cannot cover
both; a modified attempt digest refuses with unchanged post coverage. Top-level
header-key strictness is still deferred before catalog integration; currently
prepared headers remain unauthenticated/uncommitted and confer no authority.

The prior 17-test reader timing is a different suite/head. No matched performance
baseline was measured, so this30-test duration is not a regression/savings claim
or a product latency guarantee. Root tsc excludes tests; Vitest transpilation is
not a test typecheck. Vite advisory remains in raw output.

All three commands were admitted sequentially min4 tests/lint,min6 compiler;
no refusals/retries/cancellations or unrelated broad runs. Receipts bind clean
equal exact before/after head/tree and24 hashes, argv/time/exit/raw. New source
hashes were matched to exact Git blobs; all44 receipt/raw hashes verified,
prior41 index entries unchanged. Intermediate d31/4ee source-only commits in
ancestry were not separately executed and inherit no proof. Original local
dependencies restored; matched reversible cache linkage only, no installs.

Independent review is required for this changed read/reuse path. Immutable
build/put publication, flush/eviction and combined-memory assessment still
need appropriate acceptance before authoritative writer/catalog integration.
Root activation/R1, incremental writer/GC, migration, runtime/phone, local-human
UI and platform/product gates remain open. No app import, live settings write,
grant, activation, release or production routing change occurred.
