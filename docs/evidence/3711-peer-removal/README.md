# Legacy outgoing peer-removal correction (#3711)

Base: `7dfc8b1541bc8c77980faaff782f573c2fa85a15` (landed #3772).
Execution source: `2ec597518` (full SHA/tree and file seals in `manifest.json`).
This is one desktop lifecycle correction, not full-duplex, phone or release
acceptance. Independent review and ordinary hosted CI remain required.

## Exact change and ownership

Only the two legacy removal bodies in `src/main/ipc/annex-handlers.ts` change
production behavior. Single removal revokes first, then unconditionally calls
the existing `forgetSatellite`, preserving the revocation result and peer-list
notification. Bulk removal snapshots paired fingerprints before revocation
clears the store, then forgets those owners. The client remains running.

Server revocation still owns trust removal, incoming connection closure and the
existing removed-phone notification. Client forget still owns outgoing socket,
request, stream and reconnect retirement. No new permissions, grants, routes,
wire fields, membership writers, Details receipts or Naming observers are added.
Unified device removal and the existing membership hook are unchanged.

## Executed negative controls and final proof

- Attempt01 on test-only `cec78a7d2`: three genuine missing-forget assertions;
  two lifecycle cases stop at a missing peer-list mock export. This original
  fixture failure is retained, not called a product reproduction.
- Attempt02 on test-only `b232d4829`: five failures. The two actual IPC/server/
  client cases show retained connected state, an extra socket write and an
  accepted late snapshot. The first late-IPC filter used the wrong constant;
  it is not late-publication evidence.
- Attempt03 on test-only `8ad8363bb`: five failures / 405 skipped, with the
  actual satellite-event channel and positive live-publication control.
  Production is still byte-identical to the base. Both removal channels retain
  the outgoing socket, sends and late snapshot/publication.
- Attempt04 on source `854817d97`: 457 tests pass across handler, client and
  device tests. Attempt05 production types pass.
- Attempt06 genuinely fails: including the changed handler fixture exposes
  21 existing incomplete settings/status mock types, plus one new uncontextualized
  null expectation. Attempt07 lint has zero errors / 146 warnings.
- Source `2ec597518` adds only fixture typing: Vitest's existing partial-mock
  typing preserves all old runtime mock values, and the new expectation gains
  its actual observed return context. No cast, suppression, compiler-option
  change or production follow-up is used.
- Exact final source: attempt08 complete fixture types PASS; attempt09
  three files / 457 tests PASS; attempt10 production types PASS; attempt11
  lint PASS, zero errors / 146 existing warnings. Attempts12-14 compare the
  exact base: every warning maps to its unchanged source line and column;
  zero introduced diagnostics.

The initial attempt12 readback compared differently ordered JSON arrays by
position and raised an assertion (0-warning production versus 3-warning test
fixture). ESLint itself completed successfully. Attempts13-14 use exact paths
and unchanged-line bridges, without rerunning or rewriting either lint result.

## Commands and gates

Every test/lint command uses
`~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 --`; every TypeScript compiler
uses `lane-p2 6 --`. Originals contain admission measurements and terminal exits.

```sh
npx vitest run --project main src/main/ipc/annex-handlers.test.ts \
  src/main/services/annex-client.test.ts --maxWorkers=2 \
  -t 'legacy peer-removal IPC|REMOVE_PEER|REMOVE_ALL_PEERS'
npx vitest run --project main src/main/ipc/annex-handlers.test.ts \
  src/main/services/annex-client.test.ts src/main/services/annex-devices.test.ts \
  --maxWorkers=2
npx tsc --noEmit
npx tsc --noEmit --project docs/annex-reverse-routes.tsconfig.json
npx eslint src/main/ipc/annex-handlers.ts src/main/ipc/annex-handlers.test.ts \
  src/main/services/annex-client.test.ts --format json
```

## Observable scope and limits

The lifecycle cases use the real registered IPC handler, production server
revocation and production client callbacks, with deterministic in-memory peer
storage and EventEmitter socket/TLS/discovery fixtures. They first prove live
snapshots and actual writes to the fixture socket. Removal must synchronously
close/forget the outgoing owner, refuse subsequent sends, ignore late frames/
close/error/open callbacks, and remain forgotten after 120 seconds of fake time.
Single removal also leaves the other peer's connected sends and snapshots live.
Bulk removal exercises a genuinely cleared peer store.

This is not a real TCP/TLS pair, real Electron/current-app E2E, phone notification
execution, native PTY/process-tree cleanup, or federation/handoff validation.
No full local suite/E2E, dependency installation, app restart, phone-fixture
regeneration or release action was performed. Historical #3772 evidence is
preserved and is not relabeled as new execution.
