# Independent QA: PR #3749 main-535 merge and Windows realpath fix

Reviewer: qa-details-local-composition. November 21, 2026.
Head: `a2bb8647275d818666dc37bcacb21850726ea452` (`origin/details-local-composition/3733-main-535241`, remote verified).
- `52bbebb21` merges main `53524110b` (#3752; `origin/main` matches) into the approved `748dca9f9`.
- `a2bb86472` is one fix commit on top. The previously quoted `06d8` SHA does not exist, and that correction is noted.

Method: I read source and artifacts. I made one read-only download of the hosted JUnit artifact and ran no tests.

## Verdict

**APPROVE the bounded PR update to `a2bb86472`.** Hosted Windows CI is required before the Windows fix is credited. The owner's sealed raw evidence, bound to the head, is still requested (below).

## Merge `52bbebb21`

- Identical to the automatic `merge-tree` result, with no conflicts. #3752 adds `annex-routes.ts` and related files.
- `annex-client.ts` keeps both fences: `connectionAttempt` ×5 and the clock-only wake retry (#3748), and `invalidateSnapshotAdmission(sat, receipt)` ×2 (O1).

## Fix `a2bb86472`

- **`read-only-helper-work.ts:84`:** the final synchronous fence now uses `fs.realpathSync.native(cwd) !== root`, where `root` comes from `readOnlyRepositoryRoot`'s `fs.promises.realpath`, which is native.
  - The JS `realpathSync` walk keeps Windows 8.3 short components that the native call expands, so the strings disagree on the same directory. The helper work then fails closed with "Couldn't read helper work".
  - **Security is preserved.** It is still an exact string comparison of fully resolved paths. The native call resolves symlinks with the same semantics. The `dev`/`ino` identity check on `root` and both witnesses are unchanged. There is no alias, normalization or fallback, and only the matching resolver changed.
  - This also fixes a real product bug for Windows users whose paths contain 8.3 names.
- **`dispatcher-agent-card-display.test.ts:22`:** the test root becomes `realpathSync.native(mkdtemp)`, so the spy compares against the path production opens. Test only.

## Actual hosted evidence against the diagnosis

- Run 44878841675 (head `748dca9f9`), job 136769509094 "Unit + Component Tests (windows-latest, 2/2)".
- Artifact `test-results-windows-latest-2` id 14698210037. I downloaded it: zip sha256 `7c0b7b09…46bb96`. It has 16650 tests, **5 failures**:
  - 4 in `read-only-helper-work.test.ts` (:52, :61, :70, :143). Each received `dirty: 0` with **`error: "Couldn't read helper work."`** where `dirty: 1` was expected. That is the fail-closed final fence.
  - 1 in `dispatcher-agent-card-display.test.ts:66`: "expected 0 to be greater than 0", meaning the spy saw 0 bytes.
- These are consistent with the realpath disagreement between the two resolvers. The JUnit does not record the paths themselves, so 8.3 expansion is the **likely, not proven,** mechanism. Hosted Windows on `a2bb` is the proof.

## Evidence requested from the owner

The owner reports: merge-focused 13 files, 1866 passed, type and lint 0; the 4 Windows-fix files at 274 passed locally (macOS, not Windows proof). Please provide sealed `.txt` copies bound to `a2bb86472` and `52bbebb21`, with head before and after, clean status, exits and a SHA256 manifest. No full suite is required, since no new concern was found.
