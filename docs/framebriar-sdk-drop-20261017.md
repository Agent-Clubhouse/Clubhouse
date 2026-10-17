# Framebriar SDK drop — 2026-10-17

## Provenance

- Upstream repository: https://github.com/masra91/framebriar
- Source: `4bd23032b840368c77cd50bf96bc484517d81143`, fetched `origin/main`, merging [upstream PR #5](https://github.com/masra91/framebriar/pull/5). This source stages SDK version `0.4.1` and contains the cold-start retry changes from `37282a360c4cae6e85c82a4a4b36b755e7624f0a` and persistence-recovery fix from `a5054eeca79f8307056d23bf10ccb293f5f19841`.
- Previous Clubhouse pin: `0c8b67a5884e5cb3dc47205f77bae33f1123ec21`.
- Clubhouse base: `2c26a643f8c5ca7b7b3efe9d9164a825b3accbda`.
- Distribution remains the existing source-vendoring mechanism, not a published npm version upgrade.

`VENDORED.json` records SHA-256 hashes for all eleven required runtime files. The vendor script reads Git blobs at the exact commit, including Node modules, shared browser telemetry/OTLP helpers, and the protocol module. The changed runtime files are `adapters/node/access.mjs` and `adapters/browser/telemetry.mjs`; the other nine match the previous pin. The browser module includes upstream queue-expiry and cancellation changes in its `createTelemetry` implementation. Clubhouse's Node adapter imports only its unchanged pure helpers and does not instantiate browser telemetry. Clubhouse-owned `index.d.mts` remains outside the vendor manifest.

Reproduce the import and verify against an upstream checkout containing the source commit:

```sh
node scripts/vendor-framebriar.mjs --from /path/to/framebriar --commit 4bd23032b840368c77cd50bf96bc484517d81143
node scripts/vendor-framebriar.mjs --check --from /path/to/framebriar
```

The initial fetched main was `37282a3`; its stale browser manifest was not used. This drop uses the exact accepted source and hashes above. Private npm package adoption is deferred; no registry authentication or CI package access is needed to consume this source drop. Merged source, package publication, and deployed backend compatibility are separate states.

## Behavior and boundaries

Access redeem, refresh, and disconnect calls now allow 45 seconds each. Explicit invitation redemption retries transient failures twice after 2 and 5 seconds, reusing the same in-memory attempt id. The nominal maximum network/backoff budget is 142 seconds for three timed-out calls. Denials are not retried. Exhaustion retains the visible `connection-uncertain` notice; restart does not redeem automatically. An explicit retry of the same invitation reuses the attempt for up to 14 minutes in the same process.

The attempt also survives response validation or temporary enrollment-storage failure. It is cleared only after successful persistence and acceptance, with generation and identity checks so an interrupted operation cannot clear a newer attempt. Explicit disconnect and disposal clear it. This fixes the independent review's recovery gap: a successful server redemption followed by a failed local save can be retried with the original identity instead of spending another invitation use.

Clubhouse's local diagnostic now uses the SDK timeout constant, instead of calling a ten-second failure a timeout. The log remains a duration-based estimate, not proof of the cause. Enrollment remains 30 days and upload tokens at most one hour. Report transport retains its existing 30-second request timeout and durable outbox behavior.

The integration remains in the Electron main process. Settings, feedback capture/review UI, secure-storage policy, and host telemetry consent gates are unchanged. Clubhouse continues to pass `telemetry: 'off'` to the SDK and `includeDiagnostics: false` on feedback submissions. Its own OTLP destination still obtains tokens through the existing enrollment and telemetry settings gates. Invitations, attempt ids, and credentials are not exposed in status views or diagnostic logs.

## Backend prerequisite

Recovering a reply lost **after the server redeemed an invitation** requires the server implementation in `37282a3` (`src/access.mjs`): accept `attemptId`, retain its hash on the enrollment, and return the same enrollment for the same invitation/attempt for 15 minutes without spending another redemption. The server's normal invitation validity, revocation, epoch, game scope, and quota checks still apply. An older server can accept the first request while ignoring the added field; it cannot guarantee recovery when the reply is lost, and a retry can receive a used-invitation refusal.

The deployed backend revision and deduplication capability were not verified. This PR does not deploy the service or issue/redeem a live invitation. Confirm the compatible server deployment before treating lost-reply recovery as a production guarantee.

## Validation receipt

- Exact Git-blob/SHA-256 verification of all eleven vendored runtime files: passed.
- Focused Clubhouse tests: 58 passed, covering SDK import/type contracts, 45-second timeout selection and abort/retry, a simulated 12-second cold start, retry exhaustion/identity/backoff, denial, cancellation, persistent uncertainty, grant limits, lost-reply host integration, temporary secure-storage failure, and telemetry gating. The new storage-failure regression fails on the earlier pin and passes on this accepted source.
- Feedback IPC, store, UI and telemetry control tests: 65 passed.
- Pinned upstream `tests/node-adapter.test.mjs` and `tests/correlation.test.mjs`: 19 passed, including lost-reply recovery against the real in-memory issuer with exactly one enrollment. Test-only secure storage and transport; no hosted or OS-keyring acceptance claim.
- Pinned upstream `tests/node-access-persistence.test.mjs` and `tests/telemetry-sdk.test.mjs`: 34 passed, covering persistence recovery and the shared browser telemetry implementation.
- Full repository lint: zero errors (existing warnings remain).
- Production TypeScript check: passed.
- Earlier drop qualification: local macOS arm64 packaging passed with ad-hoc signing. The sandbox full-suite run passed 606 files / 14,129 tests but denied loopback listeners and process inspection/cleanup (`EPERM`); all ten affected files then passed with normal local access (394 tests). Fresh PR CI qualifies this final source across platforms and app E2E.

Full suite, packaging, and PR CI results are recorded in the PR. No test media or build artifacts are committed.
