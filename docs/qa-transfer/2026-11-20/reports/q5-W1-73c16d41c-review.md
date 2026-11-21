# Independent QA: Q5 W1, Windows reuse sync

Reviewer: qa-details-local-composition, November 21, 2026.

- **Source:** `73c16d41c8fde03aa42f6e045f2d54d593650549`, tree `efdae84744c475a80057017edfb1cb15230540ee`. Its parent is `28348cc4a`.
- **Evidence:** `1686e85e19200be3d9173f70c7c025effe731fd1`, which is in `q5-ledger-evidence`.
- **Method:** source read plus hashing. I ran no tests.

## Evidence (my only execution was hashing)

- The manifest has **52 receipts**, and its diff against `3b816a50b` removes nothing, so the earlier 48 are preserved.
- **4 new receipts.** For each, the sha256 values match, head and clean status are the same before and after, and the 25-hash maps are equal. I recomputed every hash against the head blobs, and all match.
  - `pages.test.ts`: 31 passed and 1 skipped, the native-Windows-only test.
  - tsc: exit 0.
  - Lint: exit 0.
  - Direct W1 controls on Darwin and simulated win32: exit 0.
- **Native `FlushFileBuffers` was not executed.** The simulated-win32 runs exercise the branch and the shared descriptor only.

## Source verdict: APPROVE the portable logic. Native Windows stays gated.

- **Write-capable descriptor on Windows only:**
  - When `syncValidated` is set on win32, the file opens `O_RDWR`, which doesn't truncate. That happens **before** validation, so the identity check, the bounded read and digest, `sync`, and the final identity and `lstat` checks all use **one** descriptor, with no second open.
  - Nothing is written through it.
  - Ordinary reads, and all reuse on POSIX, stay `O_RDONLY | O_NONBLOCK | O_NOFOLLOW`.
- **Only absence at the first lookup permits creating a page:**
  - The initial `lstat` ENOENT becomes the private `NoticePageAbsentError`. `put` treats only that as permission to write.
  - An ENOENT from `open` or later (file removed after the `lstat`), or any EACCES, EPERM or EIO, propagates, so `put` fails. It **never replaces** the page and **never downgrades** durability.
  - This is correct fail-closed behaviour. The caller may retry.
- **Identity:** a replacement with identical content but a different inode is refused, both before open and before sync, because the dev/ino comparison fails.
- **Unchanged guarantees:**
  - The bytes of a refused file are left unchanged, as tests check.
  - Own-temp cleanup and the versioned flush barrier are the same as in `28348cc4a`.
  - The `testPlatform` and `testOpenPage` seams are optional fixture hooks that production callers omit.

### Portable-proof notes, non-blocking

- **Symlink control on a simulated platform:** the test runs on Darwin, where `O_NOFOLLOW` is defined, so the swap is refused at `open` with ELOOP. On native Windows, `O_NOFOLLOW` is undefined (`?? 0`), so `open` **follows** the link. There, refusal depends on the final `lstat(location)` check, which sees a symlink rather than a regular file. That path is correct in source but not exercised by the portable control.
  - **Recommend:** have the simulated-win32 `testOpenPage` clear `O_NOFOLLOW` (`mode & ~O_NOFOLLOW`), and assert the specific "changed while reading" refusal.
- **Windows identity caveat:** dev/ino are reliable on NTFS, which gives a volume serial and a file index. On filesystems that report `ino` as 0, such as some FAT or network mounts, the identity check is weaker. Document this, or treat `ino === 0` as unproven identity.
- **Windows liveness:** opening `O_RDWR` fails closed with EPERM or EBUSY on read-only attribute files, or where another process holds a deny-write share (for example antivirus). Hosted execution should report whether this shows up.

## Gates kept explicit

- **Native Windows reuse:** the `skipIf(!win32)` test "native Windows reuse sync succeeds without overrides" must run and pass on hosted windows-latest before relying on Windows durability.
- Not accepted: catalog, build, heap, R1, runtime.

## Verdict

**APPROVE `73c16d41c` source.** W1 is resolved in source. The hosted native-Windows reuse execution is still pending, plus the optional strengthening of the simulated symlink control.
