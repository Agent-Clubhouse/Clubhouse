# Independent QA: Q5 page reuse barriers and concurrent flush versions

Reviewer: qa-details-local-composition, November 21, 2026.

- **Source:** `28348cc4a3859cf4dec5766df77418a7405b7f03`, tree `fd68a189b602079d8842a263b8cee7abbbdbde16`. The chain over `0826faa44` is `4b06ebcfe` then `28348cc4a`.
- **Evidence:** `3b816a50b4724daca6adc19e7fc09fa818b1aa71`, which is in `q5-ledger-evidence`.
- **Method:** source read plus hashing. I ran no tests.

## Evidence (verified; my only execution was hashing)

- The manifest has **48 receipts**, and its diff against `78e3d1b46` removes nothing, so the earlier 44 are preserved.
- **4 new receipts.** For each, the raw and receipt sha256 values match, head and clean status are the same before and after, and the 25-hash maps are equal. I recomputed every hash against the head blobs, and all match.
  - Tests: 41 of 41 passed across 2 files.
  - tsc: exit 0.
  - Lint on 3 files: exit 0.
  - Direct matrix, runner exit 0:
    - `reuse-guarded`: exit 0. The preparation child exited 77 after the rename and before any directory flush. On reopen and reuse, the pending set holds 3 entries, the reused file sync comes before the prefix flush, and the pending set is 0 after the flush.
    - `skip-reuse-dirty`: exit 2. It removes only the `markPageDirectories` call on reuse, in memory, with a unique target. The safety assertion fails.
    - `temp-opened`: an actual exit 77.
    - `fifo-swap`: exit 0. It was refused within the 3 s blocking watchdog.
- **Synthetic versus actual:**
  - Actual process exits: the unflushed preparation and the temp-opened case.
  - Actual filesystem swaps: the FIFO, the directory used for a rename conflict, and the symlink.
  - Synthetic in-process `testFailure` seams: EIO and ENOSPC before write, sync, rename, cleanup, reuse sync and flush. They are labelled as such.
- The 4b admission attempt earns no execution credit.

## Source verdict

### APPROVE as implemented

- **Non-blocking read:** `O_RDONLY | O_NONBLOCK | O_NOFOLLOW`, where those constants exist. It keeps the `lstat`/handle identity check. The digest is now checked inside `readPage`, against the same descriptor.
- **Reuse barrier:** `readPage(location, hash, true)` validates bytes and digest, then calls `handle.sync()` on **that same descriptor**. It re-checks the identity, then marks the prefix and index directories dirty. The set of dirty directories is bounded: at most 256 two-hex-digit prefixes plus the index directory and its parent.
- **`writePage` own-temp cleanup:** the same pattern as M1-L. Exclusive create, a dev/ino-checked unlink of only the current temp, the first error preserved, and residue from earlier processes kept.

### Concurrency addition, assessed explicitly: CORRECT

- `dirtyDirectories` now maps each directory to a fresh `Symbol` set on every mark. `flush()` takes a snapshot, flushes each directory longest path first, and deletes an entry **only if its version is unchanged**. At the end it throws "retry" if any entry remains.
- **A mark during an older awaited flush** (for example, a reuse or rename in prefix d while d's fsync is in flight) changes the version, so d survives. The older flush then throws "retry" instead of falsely succeeding. That is the property 0826 lacked, and it is tested.
- **Overlapping flushes A and B:**
  - If B's snapshot includes the newer mark and B completes, then B's fsync started after that mark and covers it, and A's delete is a harmless no-op. If A then finds the map empty, A's own snapshot was covered by its own fsyncs, so success is truthful.
  - If either flush's fsync throws, that flush rejects and its entry stays for retry. Another flush that did complete may remove it legitimately.
  - No interleaving lets a flush succeed while a mark made before it began is unflushed.
- **Ownership:** failed or partial flushes leave entries in place. The "retry" error is bounded and states the condition, with no automatic loop. The caller must retry before activation, which is an integration obligation.

## W1 (required before Windows or hosted CI reliance): `fsync` on a read-only handle on Windows

- The reuse sync calls `handle.sync()` on a descriptor opened `O_RDONLY`. On Windows, libuv implements `fsync` with `FlushFileBuffers`, which **requires GENERIC_WRITE access**. A read-only handle is expected to fail with EPERM.
- So on native Windows, **every reuse of an existing page would make `put` throw**. That would also fail the reuse tests (`pages.test.ts:143`, `:152`, `:180`), which aren't skipped on win32, in any windows-latest run.
- The evidence claims no native Windows proof, and the existing `NoticeDirectoryFlusher` already treats Windows EPERM, EINVAL and similar as `file-sync-only` for directories.
- **Fix (pick one):**
  - for the reuse sync only, open a separate `r+` handle (`O_RDWR | O_NOFOLLOW`, no `O_TRUNC`) after validation, and confirm the same dev/ino before calling `sync`;
  - or, on win32 only, classify EPERM from a read-only sync as an explicit `file-sync-only` observation instead of an error.
- Either way, run the reuse tests on hosted windows-latest before relying on them.
- **POSIX behaviour is unaffected:** `fsync` on a read-only descriptor is valid on Linux and macOS.

## Verdict

- **APPROVE `28348cc4a` source on POSIX:** reuse sync and barrier, non-blocking and no-follow read, own-temp cleanup, and the versioned concurrent flush barrier.
- **W1 is required** before Windows or hosted-CI reliance.
- Not accepted: build, flush ordering in activation, eviction, combined heap, catalog, R1, runtime or platform.
