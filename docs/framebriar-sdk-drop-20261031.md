# Framebriar SDK drop: v0.5.1 (2026-10-31)

This note replaces the 2026-10-17 drop note (`4bd2303`, v0.4.1 staging). It closes #2528 and the Framebriar half of #2521.

## Provenance

- Upstream repository: https://github.com/masra91/framebriar
- Source: tag `v0.5.1`, commit `7572776830a65688403c59806621154a2458099c`, published as `@masra91/framebriar@0.5.1` on GitHub Packages. It contains v0.5.0 (`4905102`).
- Previous Clubhouse pin: `25c05f76e8ae05e5ff4b13d2caaf71a7abcfd17e` (not a release).
- Distribution is still source vendoring. Clubhouse doesn't install the npm package.

`VENDORED.json` records SHA-256 hashes for the eleven runtime files. Clubhouse-owned `adapters/node/index.d.mts` stays outside the manifest. Reproduce and verify against a Framebriar checkout:

```sh
git -C /path/to/framebriar fetch --tags
npm run framebriar:vendor -- /path/to/framebriar --commit v0.5.1
npm run framebriar:check -- --from /path/to/framebriar
```

The vendor script now resolves `--commit <ref>^{commit}`, so an annotated tag pins the commit it points at, not the tag object.

## What changed in the vendored files

Six of the eleven files differ from the previous pin:

| File | Change |
|---|---|
| `adapters/node/secure-store.mjs` | Async safeStorage (`isAsyncEncryptionAvailable`, `encryptStringAsync`, `decryptStringAsync`) when all three exist, else the sync API. Adds `probeAsync()` and `secureStorageAvailabilityAsync()`. `shouldReEncrypt` rewraps the record. |
| `adapters/node/index.mjs` | Exports `secureStorageAvailabilityAsync` and `safeStorageApi`. |
| `adapters/node/feedback.mjs`, `adapters/node/telemetry.mjs`, `adapters/browser/telemetry.mjs` | The default session id is a UUID v4 instead of `s-<24 hex>`. Older ids stay valid. |
| `src/protocol.mjs` | Reports accept an optional `matchId` (multiplayer games). Clubhouse doesn't send one. |

The replay and auto-replay browser modules added in 0.5.0 aren't in the vendored set.

## Secure store (#2521)

Electron 46 removes `safeStorage.isEncryptionAvailable`, `encryptString` and `decryptString`. Clubhouse is on Electron 45.1.0, which has both APIs, so the store uses the async one.

- **Enrollment carries over.** `userData/framebriar/enrollment.json` keeps its format, and data written by `encryptString` decrypts with `decryptStringAsync`. Nobody re-enrolls, and a rollback to a build on the sync API still reads the file.
- **Same refusals.** There's still no plaintext fallback. Linux `basic_text` and `unknown` are refused (`plaintext-backend`), because `isAsyncEncryptionAvailable()` resolves true on `basic_text`.
- **Clubhouse calls `probeAsync()`.** The sync `probe()` is deprecated in 0.5.x, removed in 0.6.0, and reports `safe-storage-missing` on Electron 46. `FeedbackService` probes before it restores the enrollment, and again on each status request and action. `status()` stays synchronous and reads the last probe result.

Clubhouse's own destination secret store (`src/main/telemetry/secret-store.ts`) moved to the same pattern in the same PR. See `docs/electron45-security-2026-10-23.md`.

## Session id format (#2528)

Clubhouse sends `fb.feedback.sessionId` as the `session.id` resource attribute on telemetry it exports to Framebriar (`src/main/telemetry/destinations/framebriar.ts`). It treats the id as an opaque string. Nothing in Clubhouse parses or validates the `s-` form, so the change needs no code change here.

## Validation

- Vendored files match `v0.5.1` byte for byte (`framebriar:check --from`).
- `scripts/framebriar-type-contract.test.ts` compiles the surface Clubhouse uses, including an async-only safeStorage and `probeAsync()`.
- Both stores are tested against a fake safeStorage with only the async API, one with only the sync API, and one with both. A record the sync API wrote reads back through the async API.
- Framebriar has tested this only against a fake safeStorage. The PR lists the checks to run by hand in a real build.
