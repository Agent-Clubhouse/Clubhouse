# Independent QA: Annex resume readiness fix

Reviewer: qa-details-local-composition. November 20, 2026.
Review target: `a31e81dbf640bf92b7313d3060b1be87d5da6bd8` (= `origin/annex-wake-readiness/resume-freshness`). Base: main `69ef383ce`.

| Commit | Content |
| --- | --- |
| `b9fbe1b71` | Tests and baseline |
| `2cbdad6f9` | Fix |
| `92ad84430` | Review-regression fix |
| `a31e81dbf` | Documentation only |

Method: I read source and artifacts only. I ran no tests and made no edits, live probes or power changes.

## Verdict

**CHANGES REQUESTED (small).** The core correction is sound. One concrete cross-generation defect remains (W1), the final-pass evidence is missing from the repository (E1), and there is one product decision (W2).

## What is correct

- `resumeAllConnections` now does the following:
  - skips `halt` and `needsPairing` records;
  - retires any connected, connecting or disconnected record with `disconnectSatellite`, which stops the heartbeat, clears the reconnect timer, sets `sat.ws` to null before `close()`, and calls `setState('disconnected')`, which clears the receipt and bumps the epoch from connected;
  - resets backoff and the candidate, then dials once through the existing pinned path.
  Readiness stays false until the new `open`. This removes the stale positive readiness reproduced in baseline cases 1 and 2.
- Heartbeat ownership:
  - `startHeartbeat` captures `ws`. The interval and deadline callbacks return when `sat.ws !== ws`. The whole `pong` handler is fenced. `stopHeartbeat` also clears `pingSentAt`.
  - The close and error handlers of the current socket now call `stopHeartbeat` first. This fixes the leak the first review found (`review-regression.txt`: 2 failures before `92ad84430`).
  - The pong-timeout path nulls `sat.ws` before `terminate`. The close handler then returns early, and the timeout path itself does `setState`, `stopHeartbeat` and `scheduleReconnect`, which matches the earlier behaviour.
- Discriminating baseline (`baseline.txt`): 9 fail and 2 pass (controls) on the unchanged source, scoped to the `resume freshness` block. `review-regression.txt` shows 2 fail before `92ad84430`. These are the original failure artifacts and stay as recorded.
- The fake clock and captured callbacks model callbacks that have already been dispatched. As the README says, they do not prove how often the OS queues them or that the 34 s delay after wake is explained.

## Findings

**W1: the upgrade-refusal body callback crosses generations (concrete, narrow).**
- In `ws.on('unexpected-response')`, `sat.ws` is set to null synchronously. The deferred `readSmallBody(res).then(...)` then checks only `satellites.get(sat.fingerprint) === sat`.
- If resume starts a new attempt while that body is pending, the old callback later does one of two things:
  - runs `setState(sat, 'disconnected', 'Unexpected server response …')` on top of the new connecting or connected attempt, and schedules a reconnect because resume cleared the timer;
  - or calls `markNeedsPairing`.
- When the scheduled reconnect fires, `connectToSatellite` → `attemptConnection` assigns a fresh `sat.ws` without closing the previous one. If the post-resume socket had opened, it is left open but ignored, because every handler checks `sat.ws !== ws`. That leaks an open pinned socket and its membership and control channels.
- The README's reason for leaving this unchanged ("being worked on for #3733") does not hold. The #3733 successor changes `requestAgentDetails` and `requestDispatcherDetails` denial handling (`42331c3b5`). `git diff 69ef383ce 5e3e21cfe -- annex-client.ts` does not touch `unexpected-response` or `readSmallBody`. There is no hunk overlap.
- Fix: capture a per-attempt token, or compare `connectionEpochs` or the attempt's own identity, before acting in that callback. Treat a stale callback as terminate-only. A `needs_pairing` refusal can arguably still apply, because it is final for the peer. Add a fake-clock case that resolves the body after resume.

**W2: resume no longer retries halted certificate or clock stops (product decision).**
- The baseline redialed every disconnected record, including `halt` stops. The new `if (sat.halt || sat.needsPairing) continue;` keeps `CERT_NOT_YET_VALID` (`clock`) and `CERT_HAS_EXPIRED` stopped across wake.
- For pin mismatch and removed pairing that is clearly right.
- For a clock stop, waking is a plausible moment for the system clock to resync. Confirm this is intended, and that a manual retry still exists.

**E1: the final-pass result is not in the repository.**
- The README claims 311 tests passing across three files, including 13 new freshness cases, plus typecheck, ESLint (0 errors, 158 warnings) and `diff --check`.
- Only `baseline.txt` and `review-regression.txt` are committed. There is no validated-head file and no SHA256 manifest.
- Commit the final runner output bound to `92ad84430` (the source head; `a31e81dbf` adds docs only), using `.txt` names because `*.log` is gitignored. Until then the green result is an unverified claim.

## Observations

- Resume now always replaces a healthy connected socket. That means one reconnect per wake, the receipt is re-minted and remote buffers are re-seeded. This is consistent with the stated goal. Load is modest because it only runs on system resume.
- Resume from `connecting` closes a `CONNECTING` ws. The `error`/`close` events it emits are ignored, because `sat.ws` is already null.

## Limits

These are mocked sockets, TLS, discovery and fake timers. Nothing here proves real device sleep or the mobile path. The 34 s residual remains UNKNOWN, as the README says.
