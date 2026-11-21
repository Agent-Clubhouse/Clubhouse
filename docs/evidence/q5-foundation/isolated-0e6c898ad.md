# Exact five-file fresh-main assembly for independent review

Source `0e6c898ada85efefb80bc3aec61e07d3d15d2b19`, tree
`9d15165a116d7645f116ad2cc9e2a44a3108ced9`, pushed on
`auto-reset-policy-design/q5-isolated-index` (same origin upstream).
Parent/base is freshly fetched main e8e178c4bf462bcf443bfb1b91cbfbcd1f35d1c2.
This is the proposed isolated index delivery, not the whole Q5 task branch.
Independent exact assembled-head/D1 review is required **before PR**.

## Exact scope and bridge

Only these five files are added relative to base (1091 lines):

- src/main/services/group-project-notice-ledger/pages.ts
- src/main/services/group-project-notice-ledger/pages.test.ts
- src/main/services/group-project-notice-ledger/durability.ts
- src/main/services/group-project-notice-ledger/durability.test.ts
- test/research/q5-index-process.cjs

0e6c898ad-assembly-bridge.json binds every byte/SHA256 and Git blob to corrected
D1 source cacbb88f4d69b58a45e80a4781e72bb904e669b8. All five source/assembly
blobs are identical; actual changed paths are exactly these five. No application
caller/import, installation/ledger journal/state/catalog/migration, settings,
runtime/recovery, UI or capability advertisement is added. Main's other changes
were not copied back into the full research/evidence branches.

D1-cacbb88f4.md preserves the five-case executed failing baseline and strict
schema correction. Supported envelope/entry/reference field sets are exact;
arbitrary JSON payload values remain valid. Fanout64 bounds per-split row work,
including repeated quadratic JSON sizing. Cache ceiling is4 leaf+16 index pages,
each encoded <=256KiB (~5MiB encoded/index), plus decoded expansion/inputs/
transients. No whole-index/process heap or product latency guarantee.

## Actual checks on this assembled head

| Command inside admission | Result |
| --- | --- |
| Vitest main pages.test.ts + durability.test.ts, maxWorkers2 | exit0;49passed,1native-Windows-onlyskip/50;17.64s |
| full root ES2020 tsc | exit0 |
| four isolated TS source/test files ESLint | exit0;0errors/0warnings |

These execute on the fresh-main assembly; prior task-branch counts are not
transferred. The native no-override Windows case is skipped on this Darwin host;
no Windows FlushFileBuffers acceptance follows. Simulated Windows open/sync
policy, POSIX paths, actual process fixtures/FIFO, injected faults, schema,
immutable update/build and cache checks keep their stated limits. Root config
excludes tests; successful test transpilation is not a test typecheck. Vite
advisory is retained. No unrelated broad tests or installs were performed.

Each receipt is from portable q5-index-assembly-seal.py inside desktop-test-gate,
binding clean equal exact before/after head/tree,13 source/config/setup hashes
and the sealer's own SHA256 before/after. Its hash is
efad6b395bf775d316e303de372ef7999155079e959846560c8c47671614fedf, byte-identical
to the sealer preserved before these commands. It is external to the proposed
five-file PR; it adds no sixth source file. All new hashes matched Git blobs and
all61 receipt/raw hashes verified; prior58 index entries unchanged. Evidence
head is packaging, not the tested/assembled head. No assembly merge was made
into the evidence branch merely to package these files.

Tests/lint admitted min4,compiler min6,maxWorkers2total for Vitest, sequentially,
no refusals/retries/cancellations/bypass. Matched reversible worktree-only
dependency linkage was restored; original node_modules is back. Full task
cacbb, failing baseline6076, approved73/8d and older refs remain preserved.

## Gate after exact review, before native reliance

Normal PR Validate Windows unit jobs already provide the route, as inspected
in docs/design/q5-native-index-validation.md on the full task branch. No PR,
manual CI dispatch/rerun, workflow edit, merge/release or live activation has
occurred. Freeze this head while its normal validation runs; do not cancel or
supersede jobs. Inspect actual merge-checkout identity and JUnit, requiring
the no-override native Windows reuse case present/pass/not-skipped and examining
unexpected skips/failures in fixture-exit, symlink and rename cases.

O_NOFOLLOW can be absent on Windows; final lstat rejects followed final symlinks.
Read-only attributes/deny-write sharing must refuse, not downgrade permissions.
ino=0 FAT/network identities remain unproven. Directory file-sync-only is weaker
than observed directory sync. No power-loss or delivery guarantee. Native limits,
combined memory, all-root authority/barrier provenance, catalog/R1/migration,
runtime/local-human UI and whole-Q5 feature acceptance remain separate.
