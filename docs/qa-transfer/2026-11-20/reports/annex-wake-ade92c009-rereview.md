# Independent QA re-review: Annex resume readiness successor

Reviewer: qa-details-local-composition. November 20, 2026.
Review target: `ade92c0099f3a398e3e97b0003da825360eaefb6` on `origin/annex-wake-readiness/resume-callback-successor`. I verified the remote ref. Validated source: `ad4edfd11d0b8c80853c95acbe8fabafe342bba1`. `ade92c009` adds only `evidence/successor-validation/*`.
Scope: W1, E1 and W2 from my review at `f693f556d`. I read source and artifacts only and ran nothing.

## Verdict

**APPROVE** `ade92c009`, with source `ad4edfd11`. This approval does not cover hosted CI or any live, real-sleep or mobile proof. The open questions about the 34 s residual and the callback model are unchanged.

## W1: resolved

- `connectToSatellite` creates a fresh `Symbol` attempt and stores it as `sat.connectionAttempt`. `disconnectSatellite` and `haltSatellite` clear it.
- The deferred `unexpected-response` body callback still destroys its request and terminates its own socket. It then returns unless both the record and the attempt are current. A stale body therefore never calls `setState`, `markNeedsPairing` or `scheduleReconnect` against a newer attempt or after a manual disconnect.
- The chosen behaviour is to ignore a refusal from an older attempt; the new attempt goes through its own pairing and authorization. The README states this.
- `attemptConnection` runs once per `connectToSatellite`, so one token covers one socket. Reconnects, resume and manual retry all go through `connectToSatellite` and get a new token.
- Tests (`delayed upgrade refusal`):
  - Old 503/busy, needs_pairing and peer_not_paired bodies arrive after resume, with the replacement both connecting and connected. In each case the record is unchanged. The replacement is not closed or terminated. The channel and control `closeFor` are not called. There is no new socket after 2 s. The replacement then accepts a snapshot and sends.
  - A current refusal of each kind still applies.
  - A manual disconnect followed by a stale body stays disconnected.
- Baseline on the a31 production code (`successor-baseline.txt`): 8 fail, 3 pass, and the 3 that pass are the current-refusal controls.

## W2: resolved without a new product choice

- Resume skips `needsPairing` and every halt except `clock`. A clock stop gets the single pinned retry it had at baseline and in beta7.
- `connectToSatellite` clears `halt` (:921). If `CERT_NOT_YET_VALID` recurs, the stop comes back through `haltForTlsError`, and `scheduleReconnect` does not loop while halted. Manual `retry()` is unchanged.
- `CERT_HAS_EXPIRED` (a `pairing` halt), pin mismatch and removed pairing still stay stopped. Each has its own test.
- The clock test checks:
  - no redial during 120 s while halted;
  - exactly one pinned attempt on wake, with `pinned: true` and a 10 s handshake;
  - not ready before the socket opens;
  - a recurring error stops it again with no loop;
  - a later wake that succeeds connects.

## E1: resolved

- `successor-validation/manifest.json`:
  - `validatedHead` and `endingHead` are both `ad4edfd11`, and `trackedContentUnchanged` is true;
  - `sourceTree` `e9c841d3` and `scriptsTree` `795d2e69` equal `ad4edfd11:src` and `ad4edfd11:scripts`;
  - the lockfile SHA matches;
  - every result has exit code 0 and no signal.
- All 7 SHA256SUMS entries match the committed blobs.
- `tests.txt`: 3 files, **321 passed**. Typecheck and `diff --check` produced empty output with exit 0. Lint: 0 errors, 158 warnings.
- The surviving historical `92ad84430` stdout is kept separately. Its missing diff and exit receipts are declared and not reconstructed.

## Minor (not blocking)

- `manifest.json` records absolute host paths: the home directory, the agent workspace config path and the dependency-store path. Earlier evidence redacted these as `<home>`. Consider redacting them in a later docs-only commit, keeping the hashes recomputed or noted.
