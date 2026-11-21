# Independent QA: Q5 installation markers and directory durability

Reviewer: qa-details-local-composition. November 21, 2026.
- **Source:** `8142a812ad032b0c365001e5796d349b4ad92e50`, tree `9e1f4ad4…`. The marker commit `8142a812a` sits on lazy-page commits `f935d21af`, `77327b52a` and `181046cde`.
- **Evidence:** `61a4bf1f6128ffd89f84e58ee487d3dee2e3ba19` (`origin/auto-reset-policy-design/q5-ledger-evidence`, remote verified).

Method: I read source and artifacts only and ran nothing. This is separate from the accepted `c504cce7d` foundation, and not feature acceptance.

**Scope:** `installation.ts`, `durability.ts` and the journal's switch to the private flusher, all in `8142a812a`. **The lazy index (`pages.ts`, from `f935d21af` and `181046cde`) is not reviewed in this pass.** It belongs with the open lazy authoritative-state gate.

## Verdict

**APPROVE the marker and durability foundation (bounded),** with one liveness recommendation (M1) that the owner already acknowledges as pending, and two minor notes.

## Sound

- **Bootstrap order:**
  1. the marker (with the installation UUID v4 and schema and writer version 1) is written as a temp file, synced, renamed with **no overwrite of a discovered file**, then the userData directory is flushed;
  2. `mkdir` of the ledger directory (0700), then a userData flush;
  3. the envelope is written as a temp file, synced, renamed and the directory flushed.
  The marker is durable before the directory exists.
- **Open classification:**
  - marker plus directory plus matching envelope gives a successful open;
  - marker with no directory, or no envelope, gives `incomplete`;
  - an envelope UUID mismatch gives `changed`;
  - a directory with no marker gives `incomplete`;
  - future versions give `version`;
  - corrupt or symlinked files, or files over 8 KiB, give `corrupt`;
  - any other IO error gives `unavailable`, with stable codes and no paths.
  - **Nothing is ever rebaselined or overwritten**, and unrelated settings and legacy bytes are untouched.
- **Stable bounded reads:** lstat (not a symlink, a regular file, at most 8 KiB), an `O_NONBLOCK` open, a handle-stat equality check before and after the read, a full read loop, a final lstat equality check, and fatal UTF-8 decoding. Supported optional fields are kept without rewriting.
- **Single-flight:** one creation per resolved userData path, using an `opening` map. Cross-process safety relies on the existing single-instance lock.
- **Durability classification:**
  - `directory-synced` only after a real directory sync;
  - `file-sync-only` only for narrow known win32 results (EINVAL, ENOTSUP, EISDIR, EPERM);
  - all other errors propagate;
  - **a weaker observation is never promoted later**.
  - Windows is simulated only and isn't claimed as native, and no power-loss claim is made.
- **Journal:** all five `syncDirectory` calls are replaced by the private flusher, with `directoryDurability` exposed. There are no settings-store, `replaceFile`, `renameOver` or registry/bulletin/notification imports or edits, and no app startup or runtime import. The factory grants no migration, baseline, nonce or send authority.

## M1 (liveness, acknowledged as pending): make an interrupted first-run bootstrap completable without weakening loss detection

- Today a crash after `markerSynced` or `directoryCreated` leaves **marker plus no directory or envelope**. That is permanently `incomplete`, so the whole ledger is unavailable until a manual repair that hasn't been specified yet.
- A crashed bootstrap can't be told apart from a later loss of the ledger.
- **Suggestion:** a two-phase marker.
  - Write the marker first with `state: "bootstrapping"`, then create the directory and envelope. Finally, replace the marker atomically with `state: "active"` and flush the directory.
  - **`bootstrapping` with the directory missing or empty**, and no envelope, means no ledger record could have existed. Bootstrap can then be safely **completed** using the marker's own UUID. That isn't a rebaseline, because there's no data, migration or nonce involved.
  - **`active` with the directory or envelope missing** stays fatal (`incomplete`/loss), exactly as the contract requires.
- If the owner prefers an explicit local-human repair action instead, specify it, including its trust checks, before activation.
- The executed child-process cuts already cover the three stages. Add a cut between the envelope sync and the marker activation if adopted.

## Minor

- `writeNewMetadata` checks with `lstat` and then `rename`s. A file appearing in between would be overwritten. That's acceptable under the single-instance ownership and documented as such. A no-replace link-then-unlink would remove the window where supported.
- Classifying win32 `EPERM` from a directory open or sync as `file-sync-only` could mask a genuine permission fault. It is still honest (weak, never success), and the file contents were synced. Note it in the platform limits.

## Evidence (`docs/evidence/q5-foundation/`)

- The evidence commit differs from the source only under the evidence directory.
- The manifest has **23 receipts**, the earlier 20 preserved, and **every** receipt and raw-output digest matches.
- The 3 new `8142a812a-{tests,types,lint}` receipts: head `8142a812a` before and after, clean status, `sealEqual`, and **all 22 source SHA256s equal the blobs at `8142a812a`**.
- **Results:**

| Check | Result |
| --- | --- |
| tests | **4 files, 53 passed** (journal, pages, installation, durability) |
| root typecheck | exit 0 (tests excluded by the existing config) |
| scoped lint (6 files) | 0 errors, 0 warnings |

- The `181046cde` compiler refusal stays historical and is not counted as a pass.
