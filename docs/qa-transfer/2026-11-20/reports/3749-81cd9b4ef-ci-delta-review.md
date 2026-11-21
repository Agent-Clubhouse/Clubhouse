# Independent QA: PR #3749 CI delta

Reviewer: qa-details-local-composition. November 21, 2026.
Head: `81cd9b4ef605fc7d99106e828c18684751284990` (`origin/details-local-composition/3733-ci-agent-system`, remote verified), from the approved `ead945230`:
- `d1a2171c6`: agent-system mkdir
- `b9be7e779`: Windows fixtures
- `81cd9b4ef`: evidence

Method: I read source and artifacts only. I ran no tests. I did one throwaway trial merge with main, then removed it.

## Verdict

**APPROVE the delta.** It changes only tests.
- Production source is unchanged against `ead945230`; I checked `git diff -- src` excluding tests myself.
- Windows correctness is **not credited** until the hosted run passes.
- The PR update must merge current main; see the composition section.

## Source

- **`agent-system.test.ts`:** a `beforeAll` runs `mkdirSync(app.getPath('userData'), { recursive: true })`.
  - The cause is correct and in the evidence. With a fresh TMPDIR, the 6 quick tests from `dab72fdbf` (the bisect's first bad commit) leave local work behind, and later persists hit ENOENT.
  - **Observation:** this creates a fixed directory shared across files and workers that outlives the run. It also leaves the quick tests' leftover async work in place, hidden rather than fixed. The full fresh-TMPDIR run shows no interference. A follow-up could use a per-suite `mkdtemp` (by mocking `getPath` per file) and await or clean up the quick tests' persistence. Not blocking.
- **Windows fixtures** (all are test-environment contracts; no assertion is weakened):
  - **Empty gitconfig file instead of `os.devNull`:** Git for Windows can't open `\\.\nul` as a config file. It is semantically identical: no global config.
  - **Claude folder name:** `path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-')`. This matches production `resolveEncodedPathDir`'s `claudeEncoded` (`orchestrators/shared.ts:586`), so the test expectation now matches the real encoding on every platform. It is drive-prefixed on Windows.
  - **Same-file comparison:** `path.relative(resolve(a), resolve(b)) === ''`. It is case- and separator-tolerant on Windows and unchanged on POSIX.
  - **Executable-mode test:** `it.skipIf(win32)` is legitimate. There is no executable bit on Windows, Git for Windows defaults `core.fileMode` to false, and coverage stays on the POSIX jobs. **Observation:** the "honors core.fileMode without updating it" half could still run on Windows with an explicit setting.

## Evidence (`evidence/3733-ci-3749-run44868309476/`)

- **Seals:** all 12 committed copies match `SHA256SUMS`. The CI excerpts record raw log sizes and hashes.
- **agent-system with a fresh TMPDIR:** 219 failed of 315 on `ead945230`, and **315 passed** on the fix.
- **Bisect:** first bad commit `dab72fdbf`.
- **Full suite with a fresh TMPDIR on `d1a2171c6`** (validated head, clean before and after): **35525 passed, 2 failed**. Both failures are in `handoff-git-receive` root220/root300 (`RangeError: Invalid count value` from path padding under a short `/tmp`). Per the README they fail the same way on main 69ef, so this is a temp-dir artefact, not a regression.
- **Gaps, declared as terminal output only and not logged:**
  - the 309-passed controls;
  - handoff plus agent-system at default depth (333 passed);
  - **the 7-file 703-passed macOS run at `b9be7e779`.**

  So the Windows fixture commit has no sealed local run. Hosted CI is its proof.

## Composition with current main `6130b2966` (#3750 + #3748)

A trial merge of `81cd9b4ef` with `origin/main` shows two **adjacency conflicts**:
- **`agent-config.ts`:** #3733's connection-display cache tokens and #3750's `readDurableRegistrationLease` were both appended at the same location. These are independent additions, so take the union. #3750 reads the primary and does not change cache eviction, so it does not interact with the display tokens' `WeakMap<CacheEntry>`.
- **`annex-client.test.ts`:** the #3733 positive-receipt test block and #3748's wake tests are adjacent. Take the union.

`annex-client.ts` auto-merges with **both fences present**: #3748's `connectionAttempt` token (5 references) and clock-only wake retry, plus #3733 O1's `invalidateSnapshotAdmission(sat, receipt)` (2 calls).

The merged head needs a short composition check:
- conflict hunks resolved as unions;
- the fences retained;
- a focused run over annex-client, agent-config and the importers of both;
- then hosted CI.
