# Framebriar SDK drop: v0.7.0 (2026-11-02)

This note replaces the v0.6.0 drop note, which replaced `docs/framebriar-sdk-drop-20261031.md`. Part of #2658.

## Provenance

- Upstream repository: https://github.com/masra91/framebriar
- Source: annotated tag `v0.7.0` (tag object `4005928be6718a76ac78aaef9bd77b6399cdb622`), commit `f57b75fe5d38d7e2c3d221d246c9e01445da41dc`, tree `5dec8ad99041b6d4122b4a82d1b73df54094315b`.
- Previous Clubhouse pin: `dd63bc661ca3fc9c69abc36c885685ab523492b4` (v0.6.0).
- Distribution is still source vendoring. Clubhouse doesn't install the npm package.

`VENDORED.json` records SHA-256 hashes for the eleven runtime files. Clubhouse-owned `adapters/node/index.d.mts` stays outside the manifest. Reproduce and verify against a Framebriar checkout:

```sh
git -C /path/to/framebriar fetch --tags
npm run framebriar:vendor -- /path/to/framebriar --commit v0.7.0
npm run framebriar:check -- --from /path/to/framebriar
```

`src/main/services/framebriar/fixtures/held-reports-v1.json` is an unchanged copy of the tag's `tests/fixtures/held-reports-v1.json`.

## What changed in the vendored files

Four of the eleven files differ from the previous pin, and the runtime files grow from 124,993 to 138,471 bytes (+13,478).

| File | Change |
|---|---|
| `adapters/node/access.mjs` | Mints a local `enrollmentRef` on each redemption. Adds `enrollmentState()`, `getTokenFor(ref)` and `onEnrollmentChange(fn)`. |
| `adapters/node/feedback.mjs` | `open()` returns the ref. `prepare()` needs it with anything supplied, or fails with `invalid-input`. `submit()` rejects with `enrollment-changed`, saving nothing, under another enrollment. |
| `adapters/node/outbox.mjs` | `createOutbox` requires `access`. Sends only reports bound to the current ref and holds the rest. Adds `heldForEnrollment`, `heldBytes` and `releaseToken` to status, and `releaseHeldReports` and `clearHeldReports`. |
| `adapters/node/secure-store.mjs` | Stores the ref in the enrollment record. |

Clubhouse only reaches `createOutbox` through `createFramebriar`, which already passes `access`.

## What Clubhouse does with it

- **The ref stays in draft memory.** It goes from `open()` to `prepare()` in the draft's snapshot. It isn't in the review hash, the report bytes, the logs or anything the renderer gets. The SDK stores it beside the report in `binding.json`.
- **A report needs a draft.** `draftId` is required in the service and the IPC validator, and the no-draft branch is gone. `no_review` stays a contract word, but nothing produces it now.
- **`enrollment-changed` reopens the report.** The cached prepared report and outcome are dropped, and `send` resolves with a new draft instead of throwing: new id, capture time, trace references and diagnostics. Only the note, the image reviewed for that Send and the user's opt-outs carry over, and the user has to Send again. Tracing references or diagnostics the user turned off stay off in the new report. A Send that left the screenshot out carries no image.
- **A failed save under the same enrollment retries unchanged,** with the same report id and bytes.
- **Held reports are in Settings, Feedback,** with Send and Clear, each behind a confirmation. Send passes the token shown when its confirmation opened, never one read at action time. A stale token refreshes the status and asks again. Copy says queued, because delivery comes later. Clear works unenrolled. Held reports aren't counted as waiting to send, and a full queue's error points at them.

## Rollback: no safe downgrade claim

Don't describe a downgrade from this SDK as safe. An older SDK can send queued reports under a new identity. Upstream's results from running real v0.6.0 code against this storage are in [Rollback to an older SDK](https://github.com/masra91/framebriar/blob/v0.7.0/docs/general-feedback-v2.md#rollback-to-an-older-sdk), and the full contract is in [Reports and enrollment changes](https://github.com/masra91/framebriar/blob/v0.7.0/docs/general-feedback-v2.md#reports-and-enrollment-changes). For Node:

- A report bound to the current enrollment at downgrade isn't fenced. If the enrollment then changes on the old SDK, it's sent under the new enrollment.
- A report already held and fenced at downgrade isn't sent. It's kept and shows as blocked, and the old clear discards it.
- The fence has a window. An enrollment change made by another process is only fenced on the next status or delivery pass, and a downgrade inside that window could send the report.
- Upgrading again mints a new ref, so reports still bound to the old one become held.

Before a planned downgrade, release or clear held reports and let bound reports deliver.

## Report diagnostics stay off

`FeedbackServiceDeps.reportDiagnosticsField` is off, nothing in the app sets it, and Clubhouse doesn't pass the SDK a `diagnosticsProvider`. Reports use the excerpt path as before. Tests pin all of this.

Turning it on needs this adoption and an authorized, labeled report from the maintainer's phone that verifies storage and readback, then a separate PR.

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
