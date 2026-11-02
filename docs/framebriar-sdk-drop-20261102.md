# Framebriar SDK drop: v0.6.0 (2026-11-02)

This note replaces the v0.5.1 drop note (`docs/framebriar-sdk-drop-20261031.md`). Part of #2658.

## Provenance

- Upstream repository: https://github.com/masra91/framebriar
- Source: tag `v0.6.0`, commit `dd63bc661ca3fc9c69abc36c885685ab523492b4`, published as `@masra91/framebriar@0.6.0` on GitHub Packages.
- Previous Clubhouse pin: `7572776830a65688403c59806621154a2458099c` (v0.5.1).
- Distribution is still source vendoring. Clubhouse doesn't install the npm package.

`VENDORED.json` records SHA-256 hashes for the eleven runtime files. Clubhouse-owned `adapters/node/index.d.mts` stays outside the manifest. Reproduce and verify against a Framebriar checkout:

```sh
git -C /path/to/framebriar fetch --tags
npm run framebriar:vendor -- /path/to/framebriar --commit v0.6.0
npm run framebriar:check -- --from /path/to/framebriar
```

## What changed in the vendored files

Three of the eleven files differ from the previous pin, and the runtime files grow from 114,074 to 124,993 bytes (+10,919).

| File | Change |
|---|---|
| `src/protocol.mjs` | Adds diagnostics v1: `normalizeDiagnostics`, `captureDiagnostics`, `leaveOutDiagnostics`, `DIAGNOSTICS_LIMITS`, `DIAGNOSTICS_CONTRACT`. `normalizeReport` keeps `report.diagnostics`, outside the report's 16 KiB limit. |
| `adapters/node/feedback.mjs` | `diagnosticsProvider` and `diagnosticsLimits`. `prepare` carries `diagnostics`. `submit` returns `reportDiagnostics`, and `includeDiagnostics: false` now rewrites a carried field to `left_out`. |
| `adapters/node/index.mjs` | Forwards the provider options and re-exports the diagnostics functions. |

## Report diagnostics stay off

`FeedbackServiceDeps.reportDiagnosticsField` is off, nothing in the app sets it, and Clubhouse doesn't pass the SDK a `diagnosticsProvider`. Reports use the excerpt path as before. Tests pin all of this.

Turning it on needs an approved first live report that verifies storage and readback, then a separate PR.

**Release constraint.** Once apps send `report.diagnostics`, rolling the API back to the old version makes reports over 16 KiB fail with a permanent 413 in the device outbox, and smaller reports silently lose their diagnostics. After it's on, a rollback needs a compatible ingestion path or coordinated recovery, not a plain redeploy of the old API.

## Checked against the SDK

The SDK ships no types for the Node adapter, so `index.d.mts` stays Clubhouse's. `normalizeDiagnostics` is the real contract, and `feedback-diagnostics.test.ts` runs `toDiagnosticsV1` output through it. These were wrong and are fixed, none reachable while the field is off:

- `v: 1` was missing, so the SDK would have turned every value into `unavailable`/`invalid`.
- `submit(prepared, { includeDiagnostics: false })` would have rewritten every field to `left_out`.
- Top-level reasons used Clubhouse words. `no_lines` is now `empty`, `collection_failed` is `provider-failed`, and `left_out` has no reason.
- A `delivery` needs a valid `queued`, and a missing `lastResult` is stored as `unknown`.
- `attached` with no usable entry is `unavailable`/`invalid`.

Open before the field can go on:

- `not_connected` has no contract word and reads as `empty` ("nothing recorded") though lines exist. The contract says a report filed while the connection is down still attaches its entries.
- With the field on, the service still sends the telemetry excerpt too. Whether that continues is undecided.
