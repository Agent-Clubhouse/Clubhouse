# Framebriar SDK drop: v0.8.0 (2026-11-04)

This note replaces the v0.7.0 drop note, `docs/framebriar-sdk-drop-20261102.md`. Part of #2787.

## Provenance

- Upstream repository: https://github.com/masra91/framebriar
- Source: signed annotated tag `v0.8.0` (tag object `36338a329f29d87d29de38e6b72b3cbf65fd3335`), commit `2cfe5abbe7965a690b9e22a1db13925b1744f003`, tree `8737803edb6997cdb43996161830a252030b47fd`.
- Previous Clubhouse pin: `f57b75fe5d38d7e2c3d221d246c9e01445da41dc` (v0.7.0).
- Distribution is still source vendoring. Clubhouse doesn't install the npm package.

`VENDORED.json` records SHA-256 hashes for the eleven runtime files. Clubhouse-owned `adapters/node/index.d.mts` stays outside the manifest. Reproduce and verify against a Framebriar checkout:

```sh
git -C /path/to/framebriar fetch --tags
npm run framebriar:vendor -- /path/to/framebriar --commit v0.8.0
npm run framebriar:check -- --from /path/to/framebriar
```

`src/main/services/framebriar/fixtures/held-reports-v1.json` is an unchanged copy of the tag's `tests/fixtures/held-reports-v1.json`.

## What changed in the vendored files

Two of the eleven files differ from the previous pin, and the runtime files grow from 138,471 to 139,843 bytes (+1,372). `outbox.mjs` and `feedback.mjs` are unchanged, so the queue's format and rules are too.

| File | Change |
|---|---|
| `adapters/node/access.mjs` | Enrollment deadlines up to 365 days. Five minutes of clock skew on token and enrollment upper bounds. A 2xx JSON redeem reply that fails validation sets the `enrollment-response-rejected` state and notice, with `noticeReason`. The view gains `noticeReason`. |
| `adapters/node/secure-store.mjs` | Accepts and validates the new notice, which has a fourth key, `reason`. |

## What Clubhouse does with it

- **Long enrollments work.** Don't issue invitations over 30 days to a build older than this one. The old SDK refuses the reply after the service has spent the use.
- **The new state is in every closed list:** `feedback-types.ts`, `ACCESS_PROBLEMS` and the connect failure classes, the diagnostics words and the telemetry enums.
- **`noticeReason` is a fixed code in the local log.** It isn't in `FeedbackStatus`, so the renderer never has it, and the diagnostics catalog doesn't carry it.
- **A rejected replacement costs the working enrollment.** The session is gone and the old ref stays, inactive. Capture stays on, and reports saved now bind to the old ref. They show only in `pending`, with `heldForEnrollment` 0 and no release token. Copy says so, and never says they go by themselves.
- **There are two ways out, both explained in Settings.** A new clean invitation turns them into held reports, and Send or Clear there finishes it. Disconnect does the same with no connection, so Clear works.
- **A lingering release token is hidden.** The SDK's outbox doesn't refresh on this notice, so `toFeedbackStatus` returns a null token during it. A token shown earlier can't release anyway: the SDK answers `not-enrolled`.
- **SDK wording is mapped by code in main,** since Electron passes only the message over IPC. The original stays in the local log. The consent prompt keeps its real host name.
- **Anyone already stuck on `connection-uncertain` stays there.** Nothing redeems by itself. Retrying a spent single-use invitation returns `access-required`, and the copy for both says to ask for a new one.

## Rollback: no safe downgrade claim

Don't describe a downgrade from this SDK as safe. The v0.7.0 limits still apply, in [Rollback to an older SDK](https://github.com/masra91/framebriar/blob/v0.8.0/docs/general-feedback-v2.md#rollback-to-an-older-sdk). New in this release: with the rejected notice stored, older Node reports `storage-unavailable` until an explicit connect or Disconnect replaces the record.

## Report diagnostics stay off

`FeedbackServiceDeps.reportDiagnosticsField` is off, nothing in the app sets it, and Clubhouse doesn't pass the SDK a `diagnosticsProvider`. Reports use the excerpt path as before. Tests pin all of this.

Turning it on needs an authorized, labeled report from the maintainer's phone that verifies storage and readback, then a separate PR.

**Release constraint.** Once apps send `report.diagnostics`, rolling the API back to the old version makes reports over 16 KiB fail with a permanent 413 in the device outbox, and smaller reports silently lose their diagnostics. After it's on, a rollback needs a compatible ingestion path or coordinated recovery, not a plain redeploy of the old API.

## Checked against the SDK

The SDK ships no types for the Node adapter, so `index.d.mts` stays Clubhouse's. `normalizeDiagnostics` is the real contract, and `feedback-diagnostics.test.ts` runs `toDiagnosticsV1` output through it. These were wrong and are fixed, none reachable while the field is off:

- `v: 1` was missing, so the SDK would have turned every value into `unavailable`/`invalid`.
- `submit(prepared, { includeDiagnostics: false })` would have rewritten every field to `left_out`.
- Top-level reasons used Clubhouse words. `no_lines` is now `empty`, `collection_failed` is `provider-failed`, and `left_out` has no reason.
- A `delivery` needs a valid `queued`, and a missing `lastResult` is stored as `unknown`.
- `attached` with no usable entry is `unavailable`/`invalid`.

Open before the field can go on:

- The approved first live report, and the release constraint above.

Settled in the service, behind the same gate: with the field on, reviewed entries are `attached` whatever the SDK access state, so `not_connected` can't reach the contract, and no telemetry excerpt is sent, so the lines don't go twice.

## Tested, and not tested

Everything here ran against the real vendored SDK with a fake network and a fake keychain. Nothing was exercised against a live server, and no real invitation, enrollment or report was used.

## Desktop editor gaps

Not changed here. The screenshot editor in this release is Swift only. Compared with the shared requirement, the desktop review dialog has no zoom, no opaque rectangle redaction, and no include-screenshot checkbox, though "Send without screenshot" does the last one's job.
