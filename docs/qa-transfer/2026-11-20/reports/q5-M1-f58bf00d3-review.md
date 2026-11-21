# Independent QA: Q5 M1 two-phase bootstrap successor

Reviewer: qa-details-local-composition, November 21, 2026.

- **Source:** `f58bf00d37457f51e3393c9bd65558574d17e149` (tree `d2ab978bd2f7bec6c11286687c15b8960a8708a5`). Parent is `8142a812a`, the previously approved markers commit.
- **Evidence:** `320e350d82eb4830bfd89b31ddb52a72c8f194eb`, file `docs/evidence/q5-foundation/M1-f58bf00d3.md`.

Method: I read the source and artifacts and reran nothing.

## Evidence verification (executed by me: hashing only)

- **Receipts:** I checked the tests, types and lint receipts. Each has exit code 0 and the exact argv. Before and after both show head `f58bf00d3`, a clean status, and identical maps of 22 source hashes. I recomputed all 22 hashes from the `f58bf00d3` blobs and every one matches.
- **Tests:** `raw.txt` reports 1 file and 21 tests passed, run with `--maxWorkers=2`.
- **Manifest:** it has 26 receipts. My rawSha256 and receiptSha256 recomputations match for the 3 new ones. The diff against `03ec00dbf` removes no lines, so the 23 earlier entries are preserved.
- **Scope of credit:** the tests, root tsc and the two-file lint count as executed proof at exactly `f58bf00d3`, as reported. Nothing else does.

## Source review of `installation.ts`

### Correct as specified

- **Fresh install** proceeds in this order:
  1. write a schema1, minWriter2 `bootstrapping` marker;
  2. sync the marker, create the directory and sync it;
  3. write the minWriter2 `prepared` envelope;
  4. run a pristine check;
  5. `activateMarker` re-reads the marker with a digest, writes a temp file, re-reads and compares the digest, renames, and flushes.

  Usable ownership is returned only after the active marker exists.
- **Resume:** this runs only for a bootstrapping marker with the same UUID. `pristineBootstrap` streams directory entries through `opendir`. Any entry other than `installation.json` is refused. The envelope must have the same UUID and be minWriter2 `prepared`. Resume never mints a new UUID.
- **Active path:** applies to minWriter1 markers and to an active minWriter2 marker. A missing directory or envelope is fatal. The UUID and writer version must match. Nothing is rewritten.
- **Phase rules:** a minWriter1 marker with a `phase` field is refused as `version`. A minWriter2 marker must be `bootstrapping` or `active`, and a minWriter2 envelope must be `prepared`; anything else is refused as corrupt. minWriter3 or later is refused.
- **Optional fields** survive activation through `{...current, phase:'active'}`. A test covers this.
- **Premise:** the code comment and the design document both state the single-instance, single-flight premise and make no claim to an interprocess CAS.
- **Older 814 readers** refuse minWriter2. This is a source comparison only.

### M1-L (required, liveness): own temp left behind blocks bootstrap permanently

- `writeNewMetadata` creates `installation.json.<uuid>.tmp` **inside the ledger directory**. If the write, sync or rename then fails, nothing unlinks the temp file. Failures include ENOSPC, EIO and the `appeared during creation` refusal. A crash between `open('wx')` and `rename` leaves the same file.
- On every later launch, `pristineBootstrap` sees an entry other than `installation.json` and refuses with `notice_installation_incomplete`. So one transient IO error on first launch blocks the notice installation permanently, with no crash needed, until the user cleans up by hand.
- This contradicts the M1 goal of resuming pristine bootstrap. The design does say partial temp files refuse, but a temp the code just failed to write is not ambiguous retained data.
- **Fix:**
  - (a) best-effort unlink of the code's own temp in a `finally` on any failure before the rename, in both `writeNewMetadata` and `activateMarker`;
  - (b) for the crash window, either document the permanent refusal as an accepted limitation with a control, or recognize only the code's own exact pattern `installation.json.<uuidv4>.tmp` as removable during bootstrap. That pattern holds at most 8 KiB and is empty or a prefix of the exact prepared envelope for this UUID.
- **Controls:** fault injection with ENOSPC on the envelope write, followed by a successful reopen. Also an actual process cut after the temp is created and before the rename.
- Marker temp files land in `userData` and don't block bootstrap. They still leak and should get the same cleanup.

### Minor (test coverage)

Add explicit negative cases:
- a minWriter2 marker with phase `prepared`;
- a minWriter2 envelope with phase `bootstrapping` or `active`;
- an active minWriter2 marker with a minWriter1 envelope, and the reverse;
- a bootstrapping marker whose envelope has a different UUID;
- `installation.json` as a directory or symlink during bootstrap.

## Verdict

- **Algorithm, compatibility and evidence:** APPROVE the two-phase schema, resume rules, legacy-active handling and phase reservation as implemented. The five process cuts and the repeated envelope-to-active control are adequate for the stated cut points.
- **One required fix, M1-L.** It is narrow and touches only `installation.ts` plus tests.
- **No acceptance** for lazy index, R1 activation, migration, runtime, UI, native Windows, older-binary execution, or the gates for power loss and external rewrites.
