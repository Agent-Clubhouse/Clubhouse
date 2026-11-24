# #3714: request-local route-budget refusal candidate

**Final source:** `7207ed4cd4d0a6d5fba443450bed049c8283a02e`, tree
`55f4982865d75fe05ff1393651b2b39b516918e7`, based on landed main
`e68536e2d292ed0b824230e158e54ff79b2f027d`.
This is an implemented, locally validated candidate awaiting independent exact
source review, not PR-ready approval or security/whole-duplex closure.

The historical [README](README.md), [design](design.md), baseline manifest and
original attempts00-07 retain their pre-implementation meanings and bytes.
Design-only approval is commit
`93472ec24648696672e4138b91891a2227b0510b`, path
`docs/qa-transfer/2026-11-21/reports/3714-route-budget-1dcfae229-independent-review.md`,
reviewing design/evidence `1dcfae229ff0a2eb07b6d3a2e42f31f118f3dc32`.
That approval does not approve this production successor.

## Exact production disposition

Only the size predicate in `annex-control.ts`'s existing `rejectStart` changes:

```ts
kind === 'response' && message?.type === 'response'
  && link.direction === 'in' && link.features?.has('request') && pending
  && (size > responseBodyLimit(pending.path)
    || (pending.maxResponseBytes !== undefined && size > pending.maxResponseBytes))
```

Both alternatives remain beneath all response/type/direction/capability/current
pending-owner gates. The route comes from `pending.path`, not untrusted response
metadata. Existing parser, authority, fresh-token, metadata-size, transfer-count
and same-operation checks still precede this predicate. `accept`, bulk-lane
implementation, limits and the attachment-request refusal branch are unchanged.

The existing refusal deletes/cleans that pending request, returns
`response_too_large` with the existing read/write indeterminate distinction,
and sends the matching token cancel before credit or incoming body allocation.
The existing sender cancellation releases its transfer and response slot.
The token stays spent; old-token late body/finish/cancel cannot affect delivery,
and token restart against a fresh owned request remains fatal. Independent
completed-write history is not erased: retrying the same completed POST is
`replay_unavailable`, not reexecution or automatic retry.

Malformed/unknown/stale owners, pin/capability loss, metadata/count/duplicate
violations, replay, digest and credit failures are not made request-local.
Existing no-owner text no-ops and ledger-owned late cancellation are unchanged,
not generalized oversized-message tolerance. No route/permission/grant/phone
field, alternate-route retry, federation/422 policy, Naming/Details writer,
native process, or handoff production behavior changes.

## Executed proof and original failures

| Attempt | Exact input | Actual result |
|---|---|---|
| 04 | Unchanged production baseline `a7033fa7d` | 2 FAIL / 7 PASS / 169 skipped: owned GET/POST cap+1 closes both ends and unrelated work |
| 08 | Initial implementation `a3f46ae17` | 20 PASS / 169 skipped |
| 09 | `a3f46ae17` plus saved old-predicate WIP patch | 7 FAIL / 13 PASS / 169 skipped |
| 10 | Restored clean `a3f46ae17` | 2 FAIL / 221 PASS / 223 total; two old P6 cap expectations still required `transport_unavailable` |
| 11 | Final `7207ed4cd` plus saved old-predicate WIP patch | 8 FAIL / 13 PASS / 169 skipped |
| 12 | Restored clean final `7207ed4cd` | **224 PASS / 3 files / no skips** |
| 13 | Clean final `7207ed4cd`, root compiler, minimum6 GiB | **PASS**, exit0 |
| 14 | Clean final `7207ed4cd`, complete fixture compiler, minimum6 GiB | **PASS**, exit0 |
| 15 | Clean final `7207ed4cd`, scoped lint, minimum4 GiB | **PASS**, exit0, zero errors / one inherited warning |

Attempt10 is preserved, not relabeled green. Its sole two failures are directly
coupled old expectations in the existing icon/handoff cap+1 tests. Successor720
expects typed request-local refusal/indeterminate=false there and retains exact
cap acceptance, no additional binary frames and same-link liveness. It also adds
one sender-release case: more than a full request window of sequential rejected
responses, zero rejected binary frames, zero active runs, followed by a fresh
successful request on the same connection. No new production test helper.

The final 21-case disposition group executes cap equality/cap+1 with absent or
larger caller bound, zero caller bound, uncapped file versus a configured bound,
known-owned GET/POST refusal, sibling GET/POST success and subscription event/
input liveness on the same epoch, fatal owner/metadata/size/pin/capability controls,
old-token late payload while a fresh response is active, rejected-token replay
into a fresh owned request, completed-write history/no retry, and sender slot
release. The broader final regression also executes existing control, bulk-lane
and shared parser/token/credit/digest/authority cases.

Attempt15's warning is the unchanged telemetry catch in `annex-control.ts`,
baseline line562/current line563 (column47); the predicate adds one preceding
line. This is a source-position/byte bridge, not a newly executed baseline lint
comparison. No new warning is claimed fixed or silently suppressed.

## Commands and immutable input attribution

All commands use the installed normal `desktop-test-gate.sh lane-p2`, via the
unchanged task-only [capture.py](capture.py). No admission refusal occurred in
attempts08-15. Prior75 NOT RUN receipts and the52.5s retry violation remain.

```sh
python3 docs/evidence/3714-route-budget/capture.py 11-final-old-predicate-mutant 4 \
  npx vitest run --project main src/main/services/annex-control.test.ts \
  --maxWorkers=2 -t 'route-budget disposition'
python3 docs/evidence/3714-route-budget/capture.py 12-final-restored-regression 4 \
  npx vitest run --project main --project shared \
  src/main/services/annex-control.test.ts \
  src/main/services/annex-control-bulk.test.ts \
  src/shared/annex-control-protocol.test.ts --maxWorkers=2
python3 docs/evidence/3714-route-budget/capture.py 13-final-root-types 6 \
  npx tsc --noEmit
python3 docs/evidence/3714-route-budget/capture.py 14-final-fixture-types 6 \
  npx tsc --noEmit --project docs/annex-reverse-routes.tsconfig.json
python3 docs/evidence/3714-route-budget/capture.py 15-final-source-lint 4 \
  npx eslint src/main/services/annex-control.ts \
  src/main/services/annex-control.test.ts --format json
```

The mutant is deliberately modified tracked WIP on the stated HEAD, **not a
clean-head run**. Both old-predicate patches, raw original streams and before/
after head/tree/status/diff/gate/27 selected input seals are retained. The final
restored runs12-15 are clean and match final committed selected-input bytes.
The companion implementation manifest binds these artifacts without replacing
the historical baseline manifest or retrosealing earlier receipts.

Phone fixtures and the phone route contract remain byte-identical to the base;
this is a committed-tree/current-byte comparison, not fixture regeneration,
phone interoperability or new phone test execution. The pair uses deterministic
socket wires in one module instance, actual control/bulk/authorizer callbacks,
and fixture target dispatch/subscription handles. This is not actual TCP/TLS,
real server route confinement, native shell/PTY ownership, Electron/current-app,
phone, or full-duplex acceptance. Selected input seals are not exhaustive
transitive-runtime or untracked-input seals. No local full suite/E2E,
installation, release, branch deletion, workflow change or CI rerun.
