# #3714 route-budget blast radius: baseline and unwired design

**Production is unchanged from `e68536e2d292ed0b824230e158e54ff79b2f027d`.**
This branch contains a proposed disposition boundary and test-only evidence,
not an implemented failure-policy change. Independent exact design/security
review must precede implementation. Read [design.md](design.md).

## Actual baseline

Attempt04 on exact source `a7033fa7d` (full head/tree and selected input seals in
its receipt) uses the existing paired deterministic wire-socket fixture,
production control/bulk machinery and P1 authorizer. The target sends a real
bulk response start for a currently-owned request, with valid status/headers,
fresh token and a body exactly one byte above the route budget.

Both GET and POST discriminators **fail for the intended product reason**:
both connection ends close with4400/protocol; the requested error is
`transport_unavailable`, not `response_too_large`; unrelated GET/POST fail too
(the latter indeterminate); the subscriber receives `transport_unavailable`
and the target's served close hook runs once. No credit or rejected binary body
is sent. The failure is the whole-link disposition, not unwanted body delivery.
The later unrelated-success/subscription-liveness assertions are **not executed
past that failed aggregate assertion**; they are future acceptance conditions.

Result: **2 failed / 7 passed / 169 skipped**. The seven added controls preserve
fatal start handling for unknown/expired/cancelled owners, malformed response
metadata, invalid size, lost pinned authority and missing bulk capability.
There is no implementation-green or runtime-liveness claim.

Attempt05 on the same exact source: directly relevant existing caller-bound,
P6/replay/token/credit/digest, bulk-lane, mid-session authority, malformed protocol
and refusal-matrix selectors: **106 passed / 90 skipped / two files**. Attempt06
complete existing fixture TypeScript project: **PASS**, gate minimum6 GiB.
Attempt07 on evidence-only archival successor `b4fdbe97a`, with all effective
test/control/Python-capture inputs unchanged: scoped changed-test lint **PASS,
zero errors/zero warnings**, gate minimum4.

## Proposed disposition

Extend only the existing requester-local receive-bound `rejectStart` branch:
valid, currently-owned `response` start on the authorized incoming negotiated
link, rejected solely for size above the existing route budget or optional
stricter caller bound, receives the existing typed local error and existing
matching bulk cancel before any credit. No response bytes are retained/delivered.
Unrelated pending work and subscription retain the same link.

All preceding structural, pin, direction/capability, current-owner, token-ledger,
metadata/count and duplicate-transfer checks remain; later accepted-transfer
integrity/credit/authority failures remain fatal. Writes remain indeterminate,
with no replay, alternate route, grant/field change or federation refusal/422
bypass. Existing ledger-owned late-cancellation handling is not generalized.
There is no production patch or draft PR.

## Admission chronology, including the violation

Attempt00's first Node capture preflight fails before calling the gate because
it names nonexistent `src/shared/chat.ts`; the existing barrel is
`src/shared/chat/index.ts`. Its console transcript is owner-copied from the
original tool output, not an independently captured raw stream.

Attempts01 and02 are both **75 NOT RUN**, `other_test_running`. No Vitest child
was admitted and neither has proof credit. Attempt02 was mistakenly retried
after about52.5seconds: an interval assertion failed, but the outer shell
continued to the gate. Its original refusal receipt and owner-copied console
transcript retain the violation. The corrected capture now enforces60seconds
inside the producer before spawning any gate command.

One bounded read-only observation03 at2026-11-22T03:06:20Z finds no node Vitest/
TypeScript holder and no atomic lock; the installed gate's `--dry-run lane-p2 4`
reports advisory `guards=pass`, without slot/baseline/child mutation. This changed
admission evidence, plus the elapsed interval, precedes the next bounded attempt.

The idle Node capture parent's argv contained `vitest` and would itself match
the gate's node-process test predicate while it waits. The refused samples did
not record holder PIDs, so **exclusive historical cause is not proved**. The
original Node producer, including its later interval fix, is archived as text.
Task-only Python subprocess capture follows prior accepted capture practice;
the actual test command, min4 gate and installed gate are unchanged. There is
no process mask, kill, reset, gate relaxation or resource bypass. Attempt04 then
has an actual normal locked gate START/END, exit1 and exact before/after seals.

## Evidence and limits

The effective [capture.py](capture.py) refuses overwritten artifacts and retries
within60seconds, records original merged child stdout/stderr, and seals head,
tree, tracked status/diff, selected source inputs and installed gate bytes before
and after each command. The original Node refusal receipts describe their own
producer/input version and stdout-then-stderr ordering; they are not retrosealed.
Read-only observation03 and owner-copied console transcripts are separately
qualified. `manifest.json` supplies committed-file/artifact identities and
honest source bridges; it is not an exhaustive transitive-runtime seal.

```sh
python3 docs/evidence/3714-route-budget/capture.py 04-baseline-red 4 \
  npx vitest run --project main src/main/services/annex-control.test.ts \
  --maxWorkers=2 -t 'route-budget disposition design'
python3 docs/evidence/3714-route-budget/capture.py 05-preserved-guards 4 \
  npx vitest run --project main src/main/services/annex-control.test.ts \
  src/main/services/annex-control-bulk.test.ts --maxWorkers=2 \
  -t 'controller caller receive bound|P6|mid-session revocation|protocol:|refusal matrix|bulk lane guards'
python3 docs/evidence/3714-route-budget/capture.py 06-fixture-types 6 \
  npx tsc --noEmit --project docs/annex-reverse-routes.tsconfig.json
python3 docs/evidence/3714-route-budget/capture.py 07-test-lint 4 \
  npx eslint src/main/services/annex-control.test.ts --format json
```

Sockets, target dispatch and served-subscription handles are fixtures in one
module instance; identity/role authorization and control/bulk callbacks are
production. This is not real TLS/TCP, actual server route/content confinement,
phone, current-app/Electron, native shell/PTY cleanup or whole-duplex acceptance.
No repeated #3772/#3773 proof, local full suite/E2E, installation, release,
permission change or production policy implementation occurred.
