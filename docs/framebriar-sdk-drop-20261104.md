# Framebriar SDK drop: v0.9.0 (2026-11-04)

This note replaces the v0.8.0 drop note, which had the same file name. Refs #2805.

## Provenance

- Upstream repository: https://github.com/masra91/framebriar
- Source: annotated tag `v0.9.0` (tag object `82342ea0ef2c6d36b3d59ee2292b8bdd3c7a16d0`), commit `b2976ce33ea1df57c24a72eb501e07a989e95b37`, tree `cb41fcd91530d4d8c07a24108a6366097d240894`. The tag carries an SSH signature, which wasn't verified here.
- Previous Clubhouse pin: `2cfe5abbe7965a690b9e22a1db13925b1744f003` (v0.8.0).
- Distribution is still source vendoring. Clubhouse doesn't install the npm package.

`VENDORED.json` records SHA-256 hashes for the eleven runtime files. Clubhouse-owned `adapters/node/index.d.mts` stays outside the manifest. Reproduce and verify against a Framebriar checkout:

```sh
git -C /path/to/framebriar fetch --tags
npm run framebriar:vendor -- /path/to/framebriar --commit v0.9.0
npm run framebriar:check -- --from /path/to/framebriar
```

`src/main/services/framebriar/fixtures/held-reports-v1.json` is an unchanged copy of the tag's `tests/fixtures/held-reports-v1.json`.

## What changed in the vendored files

Two of the eleven files differ from the previous pin, and the runtime files grow from 139,843 to 150,404 bytes (+10,561). `access.mjs`, `feedback.mjs`, `secure-store.mjs`, `transport.mjs`, `telemetry.mjs`, `index.mjs`, `protocol.mjs` and both browser helpers are unchanged, so there are no new access states, report fields or wire changes.

| File | Change |
|---|---|
| `adapters/node/files.mjs` | On Windows, a rename or delete refused with `EPERM`, `EBUSY` or `EACCES` retries for up to about 1 s. All retries on one lock in a process share 2 s of waiting. Other platforms make one attempt, as before. |
| `adapters/node/outbox.mjs` | `clearHeldReports({clearToken})`, and `clearToken` in status. See below for the rest. |

Runtime changes in `outbox.mjs` that reach Clubhouse:

- **A clear needs the token the user saw.** A stale or missing one removes nothing and returns `stale-release`. The check and the removal share the file lock.
- **A `state.json` that can't be read holds the report, unsent.** It counts in `heldForEnrollment`, with tokens. The outbox looks again after 5 s and then up to every 60 s, and a read that succeeds restores the real state. A transient error can briefly show a report as held that isn't.
- **`failed` on a release now means still held.** A written binding with no fence counts as `released`, even if the `state.json` write afterwards was refused.
- **A removal that took effect counts as removed,** even if deleting its files was refused. They wait in a `.trash-` directory for the next start.
- **A delivered report whose removal is stuck isn't POSTed again by this process,** isn't offered for release or clear, and fires its receipt once gone. A restart POSTs it once more, and the service answers that ID idempotently while it has the record, for 7 days.
- **Only the latest status run publishes,** so an older one can't overwrite a newer one. Listeners get fewer emits and always the final state.
- **A result waits at most 1 s for status.** `releaseHeldReports`, `clearHeldReports`, `clear()` and `start()` can return before status catches up, when an enrollment read stalls.
- **A delayed pass can't fence a report saved since.** Fencing re-reads the enrollment inside the lock.
- **Status refreshes on `connection-uncertain` and `enrollment-response-rejected`.**
- **Backoff holds in memory when `state.json` refuses it,** and `blocked` and `list()` show a terminal result that couldn't be saved.
- **`clear()` carries on past a stuck report,** then rejects if any is left. Clubhouse doesn't call it.
- **A leftover staging or trash directory no longer stops the queue,** and start only deletes staging directories older than the lock's 60 s stale limit.

New upstream and not used: the browser screenshot editor and copy modules (`adapters/browser/screenshot-editor`, `adapters/browser/feedback-copy`), `createOutbox`'s `files` seam, and everything for Godot and Swift. The manifest doesn't list the browser modules and nothing forces them in, so they are neither vendored nor imported.

## What Clubhouse does with it

- **Clear carries the token.** `clearHeld(clearToken)` goes from the dialog through IPC to the SDK, and IPC refuses a missing one. The dialog keeps the token from when it opened, as Send does.
- **A stale clear asks again.** It deletes nothing, then shows the new count and token with "The held reports changed. Check the count and confirm again." With nothing left, or before status has caught up, it says "The held reports changed. Nothing was cleared."
- **Send's stale path has the same catch-up check,** so it never asks again with the token that was just refused.
- **The clear token stays visible during `enrollment-response-rejected`.** `toFeedbackStatus` still hides `releaseToken` there, because the SDK's refresh lands after the notice. A rejection moves neither the ref nor the held set, so a token shown before it still clears, and a report saved during it isn't held and stays.
- **After Disconnect the token changes,** because it binds the enrollment. One shown before is stale, and the dialog asks again with the new one.
- **With the enrollment unreadable, Clear is off and says so.** The SDK keeps the count and has no token, and a test pins this.
- **A failed release says "Try Send again."** `released: 0, failed: 1` reads "0 reports queued to send. 1 still held. Try Send again." The state is rarer now and still possible: a Windows refusal that outlasts the retries, or a `state.json` that can't be replaced. In that last case retrying won't help, and Clear still removes the report.
- **Held copy says the reports are waiting for your choice,** and that they may be from an earlier connection or have a saved state that can't be read right now, since the SDK doesn't say which is which.
- **Clear can delete a report that wasn't really held.** If `state.json` can't be read both when the prompt is built and when Clear runs, the report counts as held both times, the token matches, and a confirmed Clear removes it, though Send would have sent it. If the read recovers first, the held set changes and Clear deletes nothing. Tests pin both. Upstream keeps this on purpose: Clear only removes the exact reports its token names. So Clear's confirmation says a held report may be one that could still be sent, and offers Send first when it's available.

No closed list changes. There are no new access states, held codes or queue codes, so `feedback-types.ts`, `ACCESS_PROBLEMS`, the diagnostics words and the telemetry enums stay as they are.

## Windows: what this resolves in #2805

| Finding in #2805 | Status at this SDK |
|---|---|
| Rename over an existing file has no Windows retry | Fixed. Upstream ran the retry on real Windows in plain Node, not Electron. Hosted Windows CI will be the first run here |
| A false `failed` when the binding lands unfenced | Fixed |
| A removal failure after a good POST counts as a delivery failure | Fixed within a process. A restart POSTs once more |
| `changed()` is last-finisher-wins | Fixed |
| `all()` reads without the lock during a release | Not changed. The retry works around it |
| `catch{failed++}` drops the errno | Not changed, so CI still can't show one |

Still open:

- **A lock can reject with `EPERM`** (upstream #76), which isn't in this release. Clubhouse shows `storage-unavailable`: "Couldn't read saved feedback on this computer. Nothing was queued. Try Send again. If it keeps happening, restart Clubhouse." Clear says the same in its own words. Upstream reports that a report survived in every injected case, and that a caller can retry.
- **Raw writes under a continuous reader still failed 4-6% of the time after retries** in the upstream Windows run. Forced-reader release flows went from 54 of 120 failing to 0 of 120. Antivirus and backup tools weren't run.
- **The original timeout failure's cause was never established.**

Not assessed here: the Linux `ENOTEMPTY` in the same test file's cleanup is being diagnosed separately.

## Rollback: no safe downgrade claim

Don't describe a downgrade from this SDK as safe. The earlier limits still apply, in [Rollback to an older SDK](https://github.com/masra91/framebriar/blob/v0.9.0/docs/general-feedback-v2.md#rollback-to-an-older-sdk). New in this release: an older SDK's clear takes no token, so it deletes whatever is held at the call.

## Report diagnostics stay off

`FeedbackServiceDeps.reportDiagnosticsField` is off, nothing in the app sets it, and Clubhouse doesn't pass the SDK a `diagnosticsProvider`. Reports use the excerpt path as before. Tests pin all of this.

Turning it on needs an authorized, labeled report from the maintainer's phone that verifies storage and readback, then a separate PR.

**Release constraint.** Once apps send `report.diagnostics`, rolling the API back to the old version makes reports over 16 KiB fail with a permanent 413 in the device outbox, and smaller reports silently lose their diagnostics. After it's on, a rollback needs a compatible ingestion path or coordinated recovery, not a plain redeploy of the old API.

## Reviewed bytes

The byte rules from #2794 hold with no test changes, including reopen provenance and report identity. `feedback.mjs` and `protocol.mjs` are unchanged, and identity still follows the whole report body. The contract's new statement that `revision` never forces a new ID is about the editor, which Clubhouse doesn't use here.

## Tested, and not tested

Everything here ran against the real vendored SDK with a fake network and a fake keychain. Nothing was exercised against a live server, and no real invitation, enrollment or report was used. Clubhouse hasn't run the Windows retry. Local runs are on macOS, and hosted Windows CI will be the first run here.

## Desktop editor gaps

Not changed here. This release adds a browser screenshot editor, which waits for 0.42.1. Compared with the shared requirement, the desktop review dialog has no zoom, no opaque rectangle redaction, and no include-screenshot checkbox, though "Send without screenshot" does the last one's job.
