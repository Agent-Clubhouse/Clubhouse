# Annex resume readiness proof

Scope: deterministic current-source proof from main `69ef383cefec405d811f1c199f25c10cdc0395b6`, compared with `v0.43.0-beta.7`. No live device or mobile behavior is asserted.

## Source comparison

The beta7 and baseline `resumeAllConnections` implementations are identical. The Electron resume hook still calls that function; index changes since beta7 concern durable initialization, not power handling. Other Annex changes include saved-route verification and listener collision handling, membership/approval snapshots, and remote-buffer seeding; they do not invalidate connected/connecting sockets on resume. This patch preserves those changes and does not edit the asynchronous refusal-body path being worked on for #3733.

## Discriminating baseline

`annex-client.test.ts` / `pinned satellite connections` / `resume freshness` uses mocked discovery, pinned TLS, sockets, captured socket handlers, captured heartbeat callbacks and a fake clock. `setSystemTime` advances 109s or 101s without running JS timers, modeling a sleep interval without asserting host clock equivalence.

On the unchanged baseline: **9 fail, 2 pass** (see `baseline.txt`).

- A connected socket remains `isMachineConnected() === true` after resume: stale positive readiness.
- An in-flight handshake is not replaced by resume. This proves the lack of an immediate fresh attempt; it does not prove an indefinite real-socket stall.
- An old socket pong cancels a replacement socket's 10s heartbeat timeout.
- Explicitly invoking a captured obsolete heartbeat interval/deadline affects a replacement socket. These model already-dispatched callbacks; they do not assert how often the OS queues them.
- Resume also redials stopped certificate/clock/pin and removed-pairing states. Preservation tests expose that existing behavior.
- Client-off and the current socket's pong pass as controls.

## Reproduction

With dependencies matching the committed package lock:

```sh
node node_modules/vitest/vitest.mjs run --project main src/main/services/annex-client.test.ts -t 'resume freshness' --maxWorkers 1 --no-file-parallelism
```

The regression commit contains only tests and this evidence; the next commit contains the narrow correction. To reproduce red without changing a shared checkout, apply the test-only commit to an isolated checkout of the baseline. On the fixed head, run the same command for green.

For this run, the existing dependency cache's `package-lock.json` matched SHA256 `bd9cc80304b81d317f2ffb295d9af5abbc484bf8efb64fc8d7f118e1288c212d`; all nonoptional package versions/integrities matched its installed metadata. No installation or cache write was used. A local temporary Vitest config copies the committed config, substitutes `import.meta.dirname` for `__dirname` for the runner loader, sets every project's `cacheDir` to a workspace-local directory, and disables test caching. `--configLoader runner` avoids bundle writes into shared `node_modules`; runs use one worker with file parallelism off.

## Evidence boundary

The Mini trace crossed OS sleep. All 122 watchdog stalls overlap sleep; the residual 34s after wake remains UNKNOWN. Historical authenticated OS sleep receipts are context supplied by the parent, not locally verified proof. This patch neither explains that residual delay nor claims a mobile fix. No keepawake, power policy, retry/deadline increase, blanket request cancellation, settings, restart, install, release, merge or live probe is included.
