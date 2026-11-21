# Independent QA: Q5 no-follow test bridge, and the isolated index delivery dependencies

Reviewer: qa-details-local-composition, November 21, 2026.

- **Source:** `8dcbf42455123014b2bba4a03973afb786a153b5`, tree `3cdf3fb0607d2e99099ac4e3ebe23d2a2eee2513`. Its parent is `73c16d41c`.
- **Evidence:** `2224920769771c0e537985ec2d166246dbdf1ce6`.
- **Method:** source read plus hashing. I ran no tests.

## A. Test and docs bridge: APPROVE

- **Production code is byte-identical to the approved `73c16d41c`:** the diff touches only `pages.test.ts` and `docs/design/q5-native-index-validation.md`. `pages.ts` and `durability.ts` don't change.
- **The new discriminator:**
  - It runs as simulated win32. `testOpenPage` **clears `O_NOFOLLOW`** on the real `open`, and the test asserts the effective flags lack it.
  - At `beforePageOpen` it moves the whole prefix directory aside. That keeps the original file's inode, mtime and ctime intact, without fabricating stat results. It then recreates the prefix directory and plants a symlink at the final path, pointing to the original file.
  - The open follows the link to the **unchanged original inode**. The identity check at open passes, and the content is actually read: `pageReadBytes === before.length`.
  - It is then refused with **"changed while reading"**, from the final path `lstat`, which sees a symlink. **Zero syncs** happen.
  - The original's identity and bytes are unchanged afterwards.
  - This exercises exactly the native-Windows path I said was untested. It is still not a hostile parent-directory or CAS guarantee, as the docs say.
- **Evidence:**
  - The manifest has **54 receipts**, and its diff against `1686e85e1` removes nothing, so the earlier 52 are preserved.
  - Both new receipts have matching sha256 values, a clean status, and 25 equal hashes, which I recomputed against the head blobs.
  - The targeted run gave 1 pass with 32 skipped, using `-t`. Lint on the changed test gave exit 0.
  - No credit is claimed for a broad suite run or for tsc. That's correct, since production code is unchanged.

## B. Dependencies for the proposed five-file isolated delivery

The five files are `pages.ts`, `pages.test.ts`, `durability.ts`, `durability.test.ts` and `test/research/q5-index-process.cjs`, plus docs.

**Closure:**
- `pages.ts` imports only Node built-ins and `./durability`.
- `pages.test.ts` imports only vitest, Node, `./pages` and the fixture, which it spawns with `process.execPath` and cwd set to the repository root.
- `durability.test.ts` imports only vitest and `./durability`.
- The fixture requires `typescript`, which is an existing devDependency, and `pages.ts`. It calls `mkfifo` only in its FIFO mode, and that test is `skipIf(win32)`.

So the import closure really is those five files.

**Already reviewed and approved:**
- the read path and its bounds (`0826`);
- reuse barriers, `writePage` own-temp cleanup, and the versioned concurrent flush (`28348`);
- the Windows descriptor handling (`73c16`);
- this test bridge;
- `NoticeDirectoryFlusher`, which uses the narrow Windows `file-sync-only` classification. That was reviewed in the earlier markers work.

**Assessed now, not reviewed before:**

1. **D1 (recommended before the PR): unknown page keys are copied forward.**
   - `decode` checks the schema and writer versions, but tolerates unknown top-level page keys: `LeafPage` and `IndexPage` declare `[extra: string]: unknown`.
   - `insert` and `delete` rebuild pages with `{ ...page, entries }` or `{ ...page, children }`, so any unknown fields on a loaded page are **copied verbatim into newly written pages**. A future writer that kept `minWriterVersion: 1` but added semantics through new fields would have those fields silently carried into pages this writer authored.
   - **Fix:** either have `decode` reject unknown keys, or build new pages from explicit keys only (`schemaVersion`, `minWriterVersion`, `kind`, `entries`/`children`). Add a control.
2. **`set`, `insert` and `delete`: correct as copy-on-write.**
   - Leaves are filtered, sorted and either replaced or split by count and bytes. Index children are spliced in and split in half when there are more than 64.
   - The insertion slot is the first child whose `last` is at or above the key, with the last child as fallback, which preserves ordering.
   - A single value too large for a page fails closed at `decode`.
   - Depth is at most 32 by `rootValid`.
   - `delete` collapses a node left with one child, and doesn't rebalance. Underfull pages are acceptable.
   - Concurrent `set` calls on the same root produce divergent roots, and choosing between them belongs to the caller or catalog.
   - **Performance note:** the byte-split loop re-serializes the growing batch for every item. That is quadratic, but bounded by fanout (at most 65 × 256 KiB of serialization). It's acceptable, and worth a comment.
3. **`build`:** leaves are pushed in strictly sorted order and promoted one level at a time. The flattened frontier is sorted by `first`. That gives ordered, disjoint ranges, possibly unbalanced, and `decode` on every `put` enforces child ordering, so a `build` bug fails closed.
4. **Cache and accounting:**
   - The cache is LRU-on-load, holding at most 4 leaf pages and 16 index pages, each at most 256 KiB. That bounds the **per-index** cache at about 5 MiB, plus one transient 256 KiB + 1 read buffer and the split serialization transients.
   - `peakLeafEntries` and `pageReadBytes` are diagnostics only.
   - This is **not** a process-wide or combined heap budget. Keep that wording.
5. **Flush:** ownership was approved in `28348`. The "flush before activation" ordering stays a caller obligation, and an isolated PR has no caller, so it's correctly out of scope.

**Delivery gates (unresolved, explicit):**
- **G1:** D1 strict page keys, recommended before the PR.
- **G2:** the hosted native windows-latest test "native Windows reuse sync succeeds without overrides" must appear in the JUnit artifact as **present, passed and not skipped**, bound to the assembled source hashes on the PR merge ref, as the plan says.
- **G3:** the exact assembled-head bridge, with per-file sha256 equal to the reviewed blobs, plus risk-targeted checks and an independent review of that exact head before opening the PR. Re-check base `main` first; it is now at or after `e8e178c4b`.
- **G4:** the Windows CI tests that depend on fixtures, symlinks and directory renames. Symlink creation on win32 skips only on EPERM, ENOTSUP or EACCES. Check the JUnit artifact for unexpected skips or failures in the actual process-exit tests. Watch the POSIX-literal and junit-artifact pitfalls from earlier Windows CI.

**Not accepted:** whole-Q5, combined heap, catalog, activation, R1, runtime, or Windows filesystems other than the observed NTFS conditions.
