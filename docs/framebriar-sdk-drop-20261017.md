# Framebriar SDK drop — 2026-10-17

## Provenance

- Upstream repository: https://github.com/masra91/framebriar
- Source: `37282a360c4cae6e85c82a4a4b36b755e7624f0a`, fetched `origin/main`.
- Previous Clubhouse pin: `0c8b67a5884e5cb3dc47205f77bae33f1123ec21`.
- Clubhouse base: `2c26a643f8c5ca7b7b3efe9d9164a825b3accbda`.
- Distribution remains the existing source-vendoring mechanism, not a published npm version upgrade.

`VENDORED.json` records SHA-256 hashes for all eleven required runtime files. The vendor script reads Git blobs at the exact commit, including Node modules, shared browser telemetry/OTLP helpers, and the protocol module. Only `adapters/node/access.mjs` changes in this drop; all other runtime files match the previous pin. Clubhouse-owned `index.d.mts` remains outside the vendor manifest.

Reproduce the import and verify against an upstream checkout containing the source commit:

```sh
node scripts/vendor-framebriar.mjs --from /path/to/framebriar --commit 37282a360c4cae6e85c82a4a4b36b755e7624f0a
node scripts/vendor-framebriar.mjs --check --from /path/to/framebriar
```

The upstream `docs/general-feedback-sdk-pin.json` still names `82eb54c` and is not the source of this manifest. The local upstream checkout also contained an unpushed packaging commit (`7c97dfe`) when inspected; it was not used.

## Behavior and boundaries

Access redeem, refresh, and disconnect calls now allow 45 seconds each. Explicit invitation redemption retries transient failures twice after 2 and 5 seconds, reusing the same in-memory attempt id. The nominal maximum network/backoff budget is 142 seconds for three timed-out calls. Denials are not retried. Exhaustion retains the visible `connection-uncertain` notice; restart does not redeem automatically. An explicit retry of the same invitation reuses the attempt for up to 14 minutes in the same process.

Clubhouse's local diagnostic now uses the SDK timeout constant, instead of calling a ten-second failure a timeout. The log remains a duration-based estimate, not proof of the cause. Enrollment remains 30 days and upload tokens at most one hour. Report transport retains its existing 30-second request timeout and durable outbox behavior.

The integration remains in the Electron main process. Settings, feedback capture/review UI, secure-storage policy, and host telemetry consent gates are unchanged. Clubhouse continues to pass `telemetry: 'off'` to the SDK and `includeDiagnostics: false` on feedback submissions. Its own OTLP destination still obtains tokens through the existing enrollment and telemetry settings gates. Invitations, attempt ids, and credentials are not exposed in status views or diagnostic logs.

## Backend prerequisite

Recovering a reply lost **after the server redeemed an invitation** requires the server implementation in `37282a3` (`src/access.mjs`): accept `attemptId`, retain its hash on the enrollment, and return the same enrollment for the same invitation/attempt for 15 minutes without spending another redemption. The server's normal invitation validity, revocation, epoch, game scope, and quota checks still apply. An older server can accept the first request while ignoring the added field; it cannot guarantee recovery when the reply is lost, and a retry can receive a used-invitation refusal.

The deployed backend revision and deduplication capability were not verified. This PR does not deploy the service or issue/redeem a live invitation. Confirm the compatible server deployment before treating lost-reply recovery as a production guarantee.

## Validation receipt

- Exact Git-blob/SHA-256 verification of all eleven vendored runtime files: passed.
- Focused Clubhouse tests: 57 passed, covering SDK import/type contracts, 45-second timeout selection and abort/retry, a simulated 12-second cold start, retry exhaustion/identity/backoff, denial, cancellation, persistent uncertainty, grant limits, lost-reply host integration, and telemetry gating.
- Pinned upstream `tests/node-adapter.test.mjs` and `tests/correlation.test.mjs`: 19 passed, including lost-reply recovery against the real in-memory issuer with exactly one enrollment. Test-only secure storage and transport; no hosted or OS-keyring acceptance claim.
- Full repository lint: zero errors (existing warnings remain).
- Production TypeScript check: passed.

Full suite, packaging, and PR CI results are recorded in the PR. No test media or build artifacts are committed.
