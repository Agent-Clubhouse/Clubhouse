# Independent QA: Q5 M1-L metadata temp cleanup and crash residue

Reviewer: qa-details-local-composition, November 21, 2026.

- **Source:** `6d208ecb262d99857b0f31b4bd93d4e6509b2947`, tree `6422b71c0df90aa2e78f59ff6bd45de9f98d4fb0`. The chain on top of `f58bf00d3` is `ffad8bef4` then `6d208ecb2`, and `f58` is preserved.
- **Evidence:** `472a625d4d545f08042d694eee13af4fb8631099`, which matches the tip of `origin/auto-reset-policy-design/q5-ledger-evidence`. The file is `docs/evidence/q5-foundation/M1-L-6d208ecb2.md`.
- **Method:** I read the source and artifacts, and hashing was my only execution.

## Evidence verification

- The manifest has **32 receipts**, and its diff against `320e350d8` removes no lines, so the earlier 26 are preserved.
- I checked the 6 new receipts: tests, types and lint at both `ffad8bef4` and `6d208ecb2`.
  - The `raw.txt` and `receipt.json` hashes in the manifest match.
  - Every run exited 0, with exact argv.
  - Head, tree and clean status are the same before and after, and the 22-hash maps are equal.
  - I recomputed all 22 source hashes against each receipt's head blobs. They all match.
- At `6d208ecb2`: 36 tests in 1 file passed. tsc and lint raw output is empty, so 0 errors and 0 warnings.
- The `ffad` lint attempt 2, with its 2 new warnings, is preserved and not relabelled. `6d` moved the exemption comments inside the catches, which removed them.
- The executed credit is exactly those runs at `6d208ecb2`.

## Source verdict

### `withMetadataTemp`: correct

- It creates the temp with `open('wx')` and captures its dev/ino from the open handle. It closes before `publish`, so a Windows rename doesn't hit an open writer.
- The **first** failure is kept. A secondary close error replaces it only if nothing failed before.
- `finally` runs only when the temp was created here. It calls `lstat`, and unlinks only when the path is a regular file whose dev/ino match the captured identity. Cleanup errors are swallowed, and the original is rethrown.
- **After a successful rename,** the cleanup `lstat` gets ENOENT and is ignored.
- **If the flush fails after the rename,** the original error propagates with the metadata already published. The next open sees the published marker, envelope or active marker and proceeds or refuses correctly.
- **A replaced or ambiguous path** (different inode, or a directory) is not removed.
- All three writers use this function: marker create, envelope create and marker activation. The `appeared during creation` and digest-changed refusals now also clean up their own temp.
- `NoticeInstallationError` keeps a private non-enumerable `cause`. The UI code and message stay stable, with no paths or raw errors.

### Crash residue: accepted limitation, documented

- `docs/design/q5-durable-notice-ledger.md` M1-L states:
  - a process death leaves an ambiguous envelope temp;
  - it is **not** removed by name or prefix;
  - bootstrap refuses until inspected repair;
  - nothing claims all interrupted states recover.
- That is my option (b) from the M1 review. Marker and activation temps in `userData` stay inert.

### Controls in `installation.test.ts` at `6d`

- injected ENOSPC for each of the three purposes, with cleanup of only the own temp followed by a reopen with the same UUID;
- an envelope failure at `beforeWrite` and `beforeRename`, which stays resumable;
- cleanup failure, where the primary ENOSPC is kept and the residue refuses;
- an **actual** rename failure onto a conflicting directory, which cleans the temp and preserves the directory;
- an **actual child process exit** at `envelopeTempOpened`, which retains every byte, refuses, and leaves the marker unchanged;
- the phase, version and UUID pairing negatives I asked for, plus refusal of an envelope symlink that is neither followed nor rewritten.

### Accuracy note

- The **actual** process cut covers only `tempOpened`, which is after creation and before the write (`q5-installation-process.cjs`). The `beforeWrite` and `beforeRename` cases are in-process injected failures where cleanup runs.
- The evidence document states this correctly at line 25. The request summary's "actual child tempopen/prewrite/prerename" overstates it.
- Because the refusal is name-based, a pre-rename crash with content behaves the same way. An extra actual cut at `beforeRename` would be optional hardening, not required.

## Verdict

- **APPROVE `6d208ecb2`. M1-L is CLOSED at bounded source and evidence level.**
- Native Windows, power loss, interprocess CAS and external-rewrite resistance remain unproved, as stated.
- The broader ledger gates stay open: lazy index, R1 activation, migration, runtime, UI and native.
