# Offline beta7 / beta8 selected-session replay

Executed November 27, 2026. This is a bounded synthetic production-module replay, not an installed-app or phone reproduction. No real transcript, user-data directory, service, client, network request, installation or broad test suite was used. Publishing this branch is the only requested network operation.

## Reproduce

From the repository root, with its existing TypeScript dependency installed:

```sh
node docs/diagnostics/nov27-mobile-refresh/pair-replay.cjs
```

One Node process runs all cases sequentially, with synchronous local git-object reads and no test workers. The script creates its own synthetic userData beneath `pair-replay-fixture-*` in this diagnostics directory and removes only that generated directory afterward. It overwrites `pair-replay-output.json`. No git fetch or package install is performed; missing objects/dependencies fail the run.

The script transpiles and executes production TypeScript from local commit objects, resolving relative dependencies against the same commit. Electron's `app.getPath('userData')` points exclusively to the generated fixture directory; logging is a no-op. Actual filesystem reads, production event-envelope validation, JSONL parsing, session selection, Dispatcher visibility projection, remote event projection and page construction execute. SHA-256 hashes identify the loaded source text after trailing whitespace removal by the git wrapper. The output records runtime versions and exact release commits.

- beta7: `dc8e82236eb2ae8dadb6bd309297d0c157caaba4`, peeled local `v0.43.0-beta.7`; package version `0.43.0-beta.7`.
- beta8: `30fd3ab0fdca6dbe75aed0b91e4c9878eded9b71`, supplied release commit already present locally; package version `0.43.0-beta.8`. No local beta8 tag or installed-binary provenance was verified.

## Actual coverage and result

Both sessions belong to the same synthetic agent: 100 events / 41,274 bytes versus 20,000 events / 8,386,678 bytes. Each alternates completed assistant messages and thoughts, with fixed synthetic text. The ordinary view retains all events; the production Dispatcher projection removes the thoughts. Both session files exist throughout, proving selection rather than comparing isolated one-file directories.

The process index is warmed once with `listChatSessions`. Each release then runs small/long × ordinary/Dispatcher × latest/older, with three unchanged repetitions: 16 cases and 48 measured transcript reads total. Page limit is 50. Older-page input uses `beforeSeq = lastSeq - 50`, mirroring the route's strict cursor filter; this is a selected older slice, not traversal of every page. Small Dispatcher older pages have 24 eligible events.

Every measured read asserts exactly one `fsp.readFile`, for the selected session, with its complete byte length and no other readFile. Every page asserts exact ordered event sequences, count via sequence equality, truncation, next cursor and raw-session lastSeq. The loader permits only the expected builtin imports; readFile paths must remain beneath synthetic userData. All 48 reads passed. Fixtures were removed after the run.

The long session reads about 203 times the input bytes although latest responses remain about 21 KB. Every repeated latest and older request rereads the entire selected session. This directly demonstrates that the bounded page response does not bound selected-session acquisition. The unchanged read/page/visibility modules are present in both releases; the loaded shared events/capabilities/runtime modules differ, so the harness executes each release's dependencies separately.

Median milliseconds over three repetitions from the saved run (read/parse includes storage scheduling; filter/page includes harness assertions around production calls):

| Release | Session | View | Page | Read/parse ms | Filter/page ms |
| --- | --- | --- | --- | ---: | ---: |
| beta7 | small | ordinary | latest | 0.210 | 0.063 |
| beta7 | small | ordinary | older | 0.185 | 0.055 |
| beta7 | small | Dispatcher | latest | 0.185 | 0.159 |
| beta7 | small | Dispatcher | older | 0.182 | 0.131 |
| beta7 | long | ordinary | latest | 16.594 | 0.592 |
| beta7 | long | ordinary | older | 13.440 | 0.524 |
| beta7 | long | Dispatcher | latest | 19.694 | 12.420 |
| beta7 | long | Dispatcher | older | 14.509 | 11.637 |
| beta8 | small | ordinary | latest | 0.180 | 0.055 |
| beta8 | small | ordinary | older | 0.157 | 0.048 |
| beta8 | small | Dispatcher | latest | 0.201 | 0.185 |
| beta8 | small | Dispatcher | older | 0.139 | 0.122 |
| beta8 | long | ordinary | latest | 14.875 | 0.487 |
| beta8 | long | ordinary | older | 13.633 | 0.469 |
| beta8 | long | Dispatcher | latest | 13.887 | 11.776 |
| beta8 | long | Dispatcher | older | 15.753 | 11.511 |

See `pair-replay-output.json` for individual samples, response bytes and loaded-source hashes. The script's assertions, source and recorded output provide reproducible acceptance evidence for this narrow claim. Independent review remains for the receiving agent.

## Limits and deferred acceptance

No full HTTP handler, awake runtime emit-chain, pending/control/slash folds, authorization, epoch change, revocation, queue or pending interaction, oversized event/overflow, cold index migration/repair, controller cache, snapshot build/coalescing, capabilities endpoint, transport reconnect/replay ring, TLS, phone request schedule, rendering or real workload is exercised. Empty pending lists and a synthetic read-only metadata envelope are supplied directly to the production page builder. Ordinary and Dispatcher route orchestration is composed by the harness rather than invoking `annex-server.ts`; its selected-session read, strict cursor filtering and page limit match the inspected route pattern.

The filesystem cache is warm after generated writes; there is no physical-disk cold-cache claim. Releases run sequentially in one process and case order is fixed. Three samples, JIT/GC, shared-host load, instrumentation and synthetic text prevent a release performance comparison or latency threshold conclusion. These results do not attribute the observed live delay, attest either installed binary, establish phone polling behavior, or validate a product fix. Full snapshot/capabilities and live end-to-end acceptance remain deferred. No production/client code was changed.
