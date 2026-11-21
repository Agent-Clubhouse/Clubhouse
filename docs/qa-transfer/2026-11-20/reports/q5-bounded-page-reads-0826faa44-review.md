# Independent QA: Q5 bounded page read and reuse

Reviewer: qa-details-local-composition, November 21, 2026.

- **Source:** `0826faa448f83738d3b4cd3b030c5c5eb665f49a`, tree `9a1e718b1c78abd0d52c6dd048ff6d3b66a8e7da`. The chain over `a3b653e34` is `d31b20807`, `4ee65597b`, `0826faa44`.
- **Evidence:** `78e3d1b4627212ced82fb9d6d06b30f87ac9439d`, which is in `q5-ledger-evidence`.
- **Method:** source read plus hashing. I ran no tests.

## Evidence verification

- The manifest has **44 receipts**, and its diff against `ce4257bfb` removes nothing, so the earlier 41 are preserved.
- **3 new receipts.** For each, the raw and receipt sha256 values match, head and clean status are the same before and after, and the 24-hash maps are equal. I recomputed every hash against the head blobs, and all match.
  - Tests: 30 of 30 passed across `pages.test.ts` and `sparse-reader.test.ts`.
  - Root tsc: exit 0.
  - Lint on 3 files: exit 0.
- Credit is exactly those runs.

## Changed boundary: APPROVE

- **`readPage`** replaces `fs.readFile` in both `load` (cold reads) and `put` (reuse of an existing page).
  - It starts with `lstat`, which must show a regular file of at most 256 KiB. That is checked before any open or allocation, so an oversized file, a directory or a symlink is refused **without reading content**. Tests assert `pageReadBytes === 0`.
  - It then opens the file and compares the handle's stat to the `lstat` result: dev, ino, size, mtime and ctime. A symlink swapped in after the `lstat` is caught here, because it resolves to a different inode.
  - It reads into a fixed buffer of 256 KiB + 1 until the buffer is full or the file ends. A file that grows past the bound is refused.
  - Finally it requires `used === size`, and the handle stat and path `lstat` must still match. The transient allocation is bounded per read.
- **No replacement of damaged pages:**
  - For an existing page whose content doesn't match its digest, `put` still throws `damaged`.
  - An oversized or wrong-type existing page throws a non-ENOENT error that propagates, so `put` never overwrites it.
  - Tests check that the oversized bytes, the directory and the symlink with its target all remain unchanged after a refused `set`.
- **Reader negatives added:**
  - `duplicate-post-id`: a second pending row reuses `postId(0)`;
  - `attempt-digest`: a coverage digest of all zeros.

  Both close my optional items from the reader review.
- **Platforms:** the symlink case is exercised on Darwin. On Windows it skips only when creating the fixture fails with EPERM, ENOTSUP or EACCES.

### Minor (liveness, non-blocking)

`readPage` opens with plain `'r'`. If a FIFO is swapped in between the `lstat` and the `open`, the open could block before the handle-stat check runs. `installation.ts` `readMetadata` already uses `O_RDONLY | O_NONBLOCK`. Recommend the same flags here, plus `O_NOFOLLOW` where available, for consistency. The single-instance trust model makes this low risk.

## Remaining dependencies for future authoritative integration: absent proof, not defects found

These parts are not approved by this review or by the sparse-reader review.

- **`put` publication:**
  - It writes a temp file, syncs it, and renames it over the hashed name.
  - **No temp cleanup on failure**, which is the same pattern M1-L fixed. A failed write, sync or rename leaves `${hash}-<uuid>.tmp` in the page directory. Reads are unaffected because pages are addressed by name, but the temp files accumulate.
  - A concurrent identical rename is harmless because the content is the same.
- **`flush` and durability:**
  - Directory flushes are deferred to `flush()`, longest path first. That covers the new prefix directory and then the index root.
  - Creating or flushing the index directory itself, or its parent, is the caller's job.
  - The integration **must** call `flush()` successfully before any activating root or journal record. That ordering is unproven until root activation exists.
- **`build`:**
  - Tree shape and ordering are enforced by `decode` on every `put`, so a `build` bug fails closed instead of producing an invalid tree.
  - The algorithm itself is unreviewed: level carry, frontier sort and depth.
- **Cache and eviction:**
  - Insertion-order eviction, with at most 4 leaf pages and a fixed maximum of index pages. Cached pages are trusted without a new digest check, which is acceptable for in-process memory.
  - There is **no combined transient, vector or whole-heap bound proof**.
- **Writer GC:** orphaned pages are never deleted. GC, retention and root reachability are absent.
- **Header:** still prepared and uncommitted. The exact key set is deferred until the catalog, as the owner states.

## Verdict

- **APPROVE `0826faa44`** for the changed bounded read and reuse boundary, plus the two added reader negatives.
- The publication, flush, build, eviction, memory and GC dependencies stay explicitly **unproven** for authoritative integration.
- No native Windows, heap or CAS claims.
