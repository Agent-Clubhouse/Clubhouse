# Independent QA (lifecycle): #3720 runtime readiness seam, read only

Reviewer: qa-details-local-composition, the assigned shared-lifecycle reviewer. November 21, 2026.

- **Target:** `c4daf8bef235f540ab622626aadceeba0f6a5d90`, which matches the remote `annex-wake-readiness/3720-runtime-review`. Its base is main `b02542b5c`.
- **Change:** documentation only, in `docs/implementation-notes/3720-runtime-readiness/`.
- **Seals:** the 9 `SHA256SUMS.txt` entries are all ok. The patch JSON is bound to the `annex-server.ts` sha256 `22d5e74f…`.
- **Credit:** document identity only. No build, type, race or runtime credit.
- **Method:** I read the seam against main `annex-server.ts` (`start`, `startVerified`, `startServer`, `stop`, `AnnexStartFailure`, `trackServer`, listener callbacks) and `annex-handlers.ts`, `annex-network-tools.ts` on `b02542b5c`.

## Verdict

- **Helper design: APPROVE WITH ONE REQUIRED CHANGE (RL-1)**, plus reservations.
- **The consumer contract is truthful.** It isn't implemented and isn't credited.

## Proposed server helpers

### `captureSecureListenerReadiness(expectedHost)`: correct

- It captures `serverGeneration`, the exact `tlsServer` and `pairingServer` objects, both ports and `boundHost`.
- It latches `wasReady`: both listeners present and listening, ports above 0, and `host === expectedHost`.
- The predicate checks the latch, the same generation, the same objects, that both are still listening, and the same ports and host.
- A TLS-unavailable fallback (`httpServer`) is **never** ready, because `main` must be `tlsServer`.
- **No IO, await, timer, settings or status reads.**
- **There is no ABA:** `serverGeneration` increments on every `startServer` and every `stop`, and objects are compared by identity.
- A capture taken while unready stays false forever.

### `startVerifiedWithReceipt(expectedHost)`

- **Capture point is correct.** `startVerified()` is async. When called, it runs synchronously up to its first `await`: it calls `startServer(true)`, which increments the generation and assigns both server objects before returning. The wrapper's capture right after the call therefore holds **this attempt's** identities.
- If a server is already running, `startServer(true)` throws "already starting or running" synchronously. `startVerified` turns that into `AnnexStartFailure` with `interrupted = true` and no `stop`, and the wrapper rejects without touching the running server. That's correct. The unchanged-enabled path must use `captureSecureListenerReadiness`, as the document says.
- Existing strict failure cleanup still happens inside `startVerified`, unchanged.
- **Superseded after strict success** (different generation or objects): throws `AnnexStartFailure(..., generation, true)` with no `stop` and no rollback of the replacement. That's correct.
- **Owned but not ready at confirmation:** calls `stop()` with no await between the check and the cleanup, then throws with `generation + 1` and `interrupted = false`, which is consistent with `startVerified`'s own owned-failure cleanup.
  - **This is acceptable for genuine readiness loss:** a listener that closed or errored after strict success, or a port change, with the same generation and objects.

### RL-1 (required): a host mismatch is not readiness loss, so it must not stop the server

- `current()` is also false when `boundHost !== expectedHost`.
- `startServer` takes its host from `annexSettings.getSettings().loopbackOnly` **at start time**, not from the caller's committed snapshot.
- **On `b02542b5c`, the MCP `applyLoopbackOnly` path calls `annexSettings.updateSettings` directly, outside the handler's `settingsWrites` chain.**

  Compare `annex-handlers.ts:77` with `:181–193`.
- **The race:** a SAVE computes `expectedHost` from its own commit while an MCP loopback change commits in between. The server started from the **newer** setting gets the same generation and objects, so the wrapper treats it as "owned but not ready". It then `stop()`s a runtime that matches the newer committed state. That's an old operation tearing down newer state.
- **Fix:** split the predicate result into "not ready" and "host mismatch". On a mismatch, don't stop. Throw a typed `unconfirmed` or `superseded` result, so the consumer reports runtime as not confirmed for this intent.
  - Optionally, have the consumer pass the exact expected profile into a strict start, instead of `startServer` reading settings again. That would be a new hunk and needs separate review.
- **Control:** a commit is followed by a loopback change from another writer before the start reads settings. The result must be no `stop`, the newer server stays running, and the operation gets `unconfirmed`.

## Consumer contract (not implemented): truthful, with reservations to settle before shared edits

- **Contract accepted as written.**
  - `applyNetworkSettings` becomes awaitable and returns `applied`, `superseded` or `failed`. An applied server-on result carries the owned predicate.
  - An unchanged server that is ready is captured without starting anything. An unchanged server that isn't ready reports `unconfirmed`, with no retry.
  - Off and client-only results describe synchronous policy application only.
  - The receipt is main-process internal and never in an IPC DTO.
  - No client lifecycle receipt is introduced, and `connectionEpochs` and #3733 receipts aren't reused.
- **Reservations, which must be shown in the future consumer patch:**
  - **RS-1, queue membership:** state and prove whether MCP forward and restore run in the same `settingsWrites` chain as SAVE and emergency persistence. If they don't, RL-1 is mandatory and the consumer must treat cross-writer interleaving as `superseded` or `unconfirmed`.
  - **RS-2, admission re-check after the wrapper resolves:** check the original r3 caller, host, settings epoch, emergency generation, launch receipt, and owned commit version **again after** `startVerifiedWithReceipt` resolves and before any activation, ACK or status publish. The listener receipt confirms neither commit nor intent.
  - **RS-3, emergency:** a live-off `stop()` increments the generation, so the wrapper's owned branch can't stop a post-emergency runtime. The consumer's late success or failure continuation must still be fenced by the emergency generation before it publishes status or calls `refreshNetwork`.
  - **RS-4, late callbacks:** every catch, STOP and status call in the consumer checks both the operation admission and the listener predicate before affecting the runtime. A stale STOP must not hit a replacement.
  - **RS-5, offline metadata path:** Rename and USE_LOCAL_ALIAS stay independent of listener readiness, as stated.
- **Reserved edit sites:**
  - `annex-server.ts`: the additive helpers only, appended after `startVerified`, plus server tests;
  - `annex-handlers.ts`: `applyNetworkSettings`, SAVE and the MCP host runtime effects;
  - `annex-network-tools.ts`: entry capture, forward and restore, under r3.

  No changes to app-shutdown, update, devrestart, launch-gate, agent-work, auth, REST, mobile or client socket and heartbeat code.

## Required proof after implementation (in addition to the seam's list)

- **RL-1 control:** a host mismatch from another writer causes no `stop`.
- A TLS-fallback (`httpServer`) server never yields a receipt.
- A listener closed or errored after strict success, with no generation bump, goes to the owned `stop` and an `AnnexStartFailure` that is not superseded.
- An already-running server with `startVerifiedWithReceipt` rejects with interrupted set and no `stop`.
- Mutants that must fail:
  - dropping the generation check in the predicate or the wrapper;
  - an equality-only (ports and host) capture that accepts a replacement;
  - a `stop` on the superseded branch;
  - a `stop` on a host mismatch.
- Mocked listener proof stays separate from real OS teardown. No live endpoints.

## Not accepted

The consumer implementation, MCP migration, emergency or recovery handling, naming activation, client or discovery readiness, any lifecycle policy change, and live behaviour.
