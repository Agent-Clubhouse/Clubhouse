# Reused-page barriers, nonblocking opens and owned-temp cleanup

Exact source `28348cc4a3859cf4dec5766df77418a7405b7f03`, tree
`fd68a189b602079d8842a263b8cee7abbbdbde16`, pushed on
`auto-reset-policy-design/q5-durable-delivery-ledger`. This succeeds approved
0826/78e read boundary (reviewce78cc43467e1b628b4b62ea89b3a4661cec3a58).
Prior44 receipts and separate root-journal planning2bf7 remain preserved.
Independent exact successor review is required before authoritative integration.

## Changed private index behavior

When an immutable page already exists, the capped read verifies digest and
descriptor/path metadata, syncs that same validated read-only descriptor and
rechecks it. Preparation then marks the hash-prefix and index directories dirty.
Reopening and reusing a page from an earlier unflushed preparation therefore
earns a file barrier and prefix-directory barrier in the new process; it does
not assume an earlier orphan's rename was directory-synced.

Dirty bookkeeping is keyed only by256 fixed hash prefixes plus index/parent,
not page count. Each mark carries a fresh version. A flush removes only the
version it actually observed, preserving newer marks created while it awaited
IO. If preparation changed and dirty entries remain, flush refuses and requires
another barrier. The concurrent same-page-reuse test observes two pending
entries after refusal, then zero after retry. This avoids claiming success
when an older flush would otherwise delete a newer prefix mark.

Page opens now use O_RDONLY|O_NONBLOCK and O_NOFOLLOW where available. File type,
identity, bounded length and metadata are still checked around the read. A
regular path swapped to a FIFO after lstat is rejected without blocking open.
This is no interprocess CAS or hostile parent-directory traversal guarantee.

New immutable writes close/sync before rename. Finally attempts cleanup only
for this call's exclusively created temp and only when its saved inode/device
still match. First write/sync/rename failure wins over secondary close/cleanup
failure. Unknown identity, foreign replacement, failed cleanup and prior-process
residue remain untouched. Residues are inert index orphans, not an activated
root/generation/nonce; no arbitrary prefix deletion or repair is performed.

## Actual exact-head proof

| Admitted check | Observed result |
| --- | --- |
| Vitest main pages.test.ts+sparse-reader.test.ts, maxWorkers2 | exit0;41passed/2files;18.61s elapsed,21.56s summed tests |
| Full root ES2020 `tsc --noEmit -p tsconfig.json` | exit0 |
| Changed page source/test ESLint | exit0;0errors/0warnings |
| Direct narrow index fixture matrix | runner0; guarded0,skip-dirty2,temp-opened77,FIFO0 |

The41 tests include reused-file/prefix ordering, failed barrier refusal/retry,
concurrent reuse while flush waits, before-write/before-sync/before-rename fault
cleanup, failed cleanup retaining the original error, preserving a foreign
replacement, actual rename refusal caused by a conflicting directory, actual
temp-opened process residue, FIFO swap and existing functional page/reader paths.
The1024-update control asserts dirty bookkeeping at most258 before flushing.

In-process fault seams throw synthetic EIO/ENOSPC **before** sync/flush/write
calls; they are not OS-reported native disk failures or process exits. Actual
rename refusal is a filesystem call against the conflicting directory.
Only prepare-unflushed and temp-opened modes actually exit fixture processes.
No app process or provider is started/restarted.

## Direct raw discriminator (same exact head)

Vitest suppresses console fixture diagnostics in this repository. A separate
min4 direct matrix captures all child output/statuses rather than reconstructing
them from passing assertions. Its Python source is the exact `-c` argv in its
sealed receipt; it sequentially invokes the versioned in-repository fixture.
This repeats only the new focused controls for raw evidence, no broad suite.

- Guarded: a separate preparation process exits77 after synced file rename but
  before directory flush. Reopened reuse emits file-synced before prefix flush,
  observes3 dirty directories before and0 after, and exits0.
- Skip-dirty mutant: removes only the reused-page mark call in memory. The same
  preparation still exits77; reused file sync still executes, but pending count
  is2 and prefix event is absent (-1). Specific missing-barrier assertion fails,
  child exits2. Syntax/load errors do not count as a killed semantic mutant.
- Temp-opened: actual exit77 after exclusive temp creation, before write/finally.
  The functional reopen control retains exact prior residue while independently
  preparing/reading a valid immutable root; no manifest is created.
- FIFO swap: actual regular file is renamed aside and mkfifo occupies its final
  path after lstat. Open returns and checked descriptor rejects it; fixture0.
  A3-second timer would exit78 if open blocked. This executed on Darwin, no skip;
  Unix FIFO mode is explicitly unsupported/skipped on native Windows.

Mutation compilation is transpile-only ES2020/CommonJS against the actual TS
modules. Original source files are never changed/restored by the mutant. The
fixture itself is now included in all25 embedded source hashes. Current root
tsconfig excludes tests; successful Vitest transpilation is not a test typecheck.
No native Windows or physical power-loss/delivery guarantee follows. Existing
directory-flush weak observations remain unchanged and never promote weaker
history to stronger durability. Combined cache/transient heap, full build/put
publication/eviction performance and authenticated root activation remain open.

## Admission, preservation and scope

An earlier admission at source4b06ebcfe refused75 other_test_running; wrapper
never ran and that head has no execution seal. Its actual refusal/command is
preserved separately. Observation anchor12:40:00Z preceded the successor's
admission12:41:14Z by74s (at least60s). Independent source work advanced the
concurrent-mark guard before admission. No cancellations, bypass, reservation
or busy polling. All four successor commands admitted sequentially with tests/
lint/direct4GiB,compiler6GiB,maxWorkers2total for Vitest.

All four receipts bind clean equal exact head/tree and25 sources, exact argv,
time, exit and raw output; every new source hash was matched to its Git blob.
All48 receipt/raw hashes verified, prior44 entries unchanged. Evidence head
is packaging, not the executed source. Matched worktree-only dependency linkage
was restored; original node_modules is back. No installs/shared dependency writes.

There is no app import, settings change, activation record, nonce consumption,
catalog/migration, send, shared lifecycle coordinator, runtime/phone/UI or
release change. Original0826/78e and planning2bf7 refs remain intact. Index
publication review, combined memory, root-backed writer/catalog/R1, migration,
runtime/local-human UI and platform/product acceptance are separate gates.
