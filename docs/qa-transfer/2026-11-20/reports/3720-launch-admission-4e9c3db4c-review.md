# Independent QA: #3720 piece 1, captured launch admission (exact source)

Reviewer: qa-details-local-composition, the assigned shared-lifecycle reviewer. November 21, 2026.

- **Candidate:** `4e9c3db4cbc98d2ac8513d42cbe87a96dedebf4b`, tree `aeb1b31cf…`, matching the remote `annex-wake-readiness/3720-launch-admission`. Base is `be0091d16`, and the test-only red commit is `c2746d574`.
- **Proof:** `0ebdc14199f177a0f688f72c2673e239e2acbefa`, matching the remote `annex-wake-readiness/3720-launch-proof`. The archive commit is `377b70c62`.
- **Method:** source read plus hash verification. My only execution was one `git diff --check be0091d16 4e9c3db4c`, which passed. I ran no tests.

## Verdict: APPROVE for standalone delivery, as the utility only

### Production source

- The change is `launch-gate.ts` only, 10 additive lines.
- It is **semantically identical** to the approved r2 `launch-gate.review.patch` (`49591297…`); only the comments differ.
- `admissionGeneration = Symbol()` is reassigned at the start of every `closeLaunches`. `reopenLaunches` is untouched.
- `captureLaunchAdmission` latches `wasOpen` and the generation, and its predicate is `wasOpen && generation unchanged && launchesOpen()`.
- `closedFor`, `assertLaunchesOpen`, `launchesOpen`, the work gate, the waiters, `runAgentWork` and every caller are unchanged. There are no timers, persistence or authority.

### Lifecycle preservation (my assigned scope)

- **Real shutdown coordinator** (`app-shutdown.test.ts`): `runAppShutdown('quit')` invalidates an old capture **before** the begin hook, which observes open false and admitted false and commits nothing. Neither `cancelAppShutdown` nor anything later revives it.
- **Guarded update failure:** the capture is already false inside the guard. `killAll` and `restoreAll` are not called. Cancel reopens launches, but late success and failure effects are refused, while a fresh capture admits exactly one explicit request.
- **`launch-gate.test.ts` covers:**
  - an open capture surviving an already-open reopen;
  - close then reopen with no revival;
  - a capture taken while closed never admitting, even after reopen;
  - repeated closes and reopens invalidating every earlier capture;
  - held success and failure callbacks across close and reopen;
  - observation without cancelling in-flight `runAgentWork`;
  - the separate agent-work gate and its reopen waiters unchanged, with the capture still true when only the agent-work gate is closed.
- **Honest limit, stated in the README:** rotation on an already-closed gate is visible in source but not observable through the predicate, because the `wasOpen` latch already makes that case false.
- **No policy change** to shutdown, update, restart, the coordinator or agent work.

### Evidence verification

- `SHA256SUMS.txt` SHA256 is `5499fe6a…a624`, matching, and all 38 entries are ok. The proof branch adds only `docs/implementation-notes/3720-launch-admission/**`.
- `manifest.json`: source head `4e9c3db4c`. The three `sourceSHA256` entries match the candidate blobs.
- **11 receipts,** each checked for receipt sha256, exit equal to expected, and inputs before equal to inputs after:
  - 01 preflight;
  - 02 baseline red at `c2746d574`, exit 1, because the new API is absent. This is a test-only red, **not** a reproduction of an existing Annex bug;
  - 03 source green and 07 restored green: 20 of 20 tests in 2 files;
  - 04 no-close-rotation: 6 failures, 14 passes;
  - 05 reset-on-reopen: 6 failures, 14 passes;
  - 06 missing open latch: 1 failure, 19 passes;
  - 08 admission check;
  - 09 full tsc, exit 0;
  - 10 lint on 3 files, exit 0, 0 warnings;
  - 11 `git diff --check be0091d16..4e9c3db4c`, exit 0, which I reproduced.
- **Inputs:** clean runs match the head blobs. The mutants differ only in `launch-gate.ts`, and the recorded `sourceDiff` shows each mutation. The task-local vitest config hash is the same in every run and equals `vitest.proof.config.ts.txt` (`b91a80c6…`).
- **Packaging carriers:**
  - For receipts 02 and 04 to 06, the committed `.txt` files are no longer the raw bytes.
  - The `.raw.json` carriers' `originalText`, re-encoded as UTF-8, matches each receipt's `rawSHA256` (I checked 02 and 04). The original files at `377b70c62` match all four `rawSHA256` values.
  - The `.display.txt` files are labelled derivatives.
  - The original archive `git diff --check` failure (exit 2, a new blank line at end of file) and the first `verify-evidence.py` KeyError are preserved as packaging failures. They are not product failures and aren't relabelled.

## Not accepted

- No Annex consumer.
- No runtime-readiness seam: void `applyNetworkSettings` is not evidence of success, and that seam needs its own review before any integration.
- No real Annex start/stop teardown. The drivers are mocked, and the effect callbacks are stubs.
- No naming compatibility, release or live acceptance.
- Hosted CI on the PR head is still required.
- N1 to N4 are recorded for later pieces.
