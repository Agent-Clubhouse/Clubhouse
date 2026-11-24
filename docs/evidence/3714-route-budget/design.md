# #3714: known-owned response-budget disposition (proposal, unwired)

Base: `e68536e2d292ed0b824230e158e54ff79b2f027d`.
No production failure-policy change is implemented here. Independent exact
design/security approval is required before changing the disposition.

## Smallest change

Extend only the existing requester-local `maxResponseBytes` refusal branch in
`makeBulkLane().rejectStart` (`src/main/services/annex-control.ts`). A **response
start**, already rejected by `accept`, may be refused locally only when:

1. The bulk frame parsed successfully; the lane already checked the current
   pinned authority, negotiated bulk capability, fresh UUID ledger reservation,
   metadata byte bound, transfer count and absence of a concurrent same-id
   incoming transfer.
2. `bulkMeta` parses its response status/headers, `kind` is `response`, direction
   is `in`, `request` was negotiated, and this exact link currently owns the
   pending request id.
3. Its safe, nonnegative advertised size exceeds **either** the existing route
   response budget or the optional stricter caller `maxResponseBytes`.

The sole proposed predicate delta is:

```ts
// Existing outer response/type/direction/capability/current-pending checks remain.
size > responseBodyLimit(pending.path)
  || pending.maxResponseBytes !== undefined && size > pending.maxResponseBytes
```

This replaces the old requirement that size be within the route budget but
above the caller bound. Do not add a catch-all refusal, change `accept`, change
response budgets, modify `ControlBulkLane`, or widen any inbound frame cap.
The parsed/safe-size preconditions are still supplied by the existing dispatcher
and lane, not by trusting a direct call to the predicate.

## Disposition and effects

Delete only this pending request, run its existing timer/AbortSignal cleanup,
and reject it using the existing `ControlRequestError('response_too_large',
!isReadOnlyMethod(pending.method), id)`. A write remains indeterminate: this says
nothing about whether the already-dispatched operation ran. Do not retry, dial
another route, change its request id, send a success-shaped result, or claim
remote effects were rolled back.

Return the existing `rejectStart` success value so the lane sends its existing
**bulk cancel for this token/id** before granting any credit. The rejected token
stays in the bounded lifetime ledger. No incoming transfer/body/timer is created,
no body is decoded or delivered to a consumer/handler, and the sender releases
that transfer through its existing cancel path. Unrelated pending reads/writes,
the same authenticated link/epoch and its subscription remain live.

This is typed **requester-local** refusal, not a new wire error or field.
Ordinary logging/refusal behavior is otherwise unchanged. The caller receives
an explicit error, not a silent empty/default result.

## Boundaries that stay fatal or unchanged

Malformed bulk/response metadata, oversize metadata/control frames, invalid size,
unknown/expired/cancelled request owner, wrong direction/capability, a reused UUID,
same-id active incoming transfer, count/history exhaustion, wrong token/id,
sequence/digest/chunk/credit violations, stalls and lost pinned authority still
take their existing fatal branches. They cannot reach this exception. An accepted
transfer failing ownership or integrity later still closes the link; the
exception is **start-only**, before any credit.

Existing ledger-owned late chunks/finish/cancel after cancellation are already
dropped without delivery; preserve that behavior, not a new generalized
oversized-message tolerance. Re-starting a rejected UUID remains fatal. An
unrecognized late binary token remains fatal.

This does not alter inbound authorization, P1/P5/P6 fences, grants, phone/wire
fields, federation refusal/422 policy, route registration, response families or
server subscription/private-shell cleanup. A genuine fatal failure still ends
the subscription and invokes its existing cleanup.

## Finite proof contract

The test-only candidate uses existing paired deterministic wire sockets and the
production control/bulk/P1-authorizer machinery. A genuine route-cap+1 response
start must show request-local typed refusal, zero credit/binary delivery for that
response, and one matching cancel. Simultaneous unrelated GET/POST must complete
normally; the same subscription must still send/receive, with no close callback
or replacement link. Test both rejected GET and POST to preserve indeterminate
disposition. This is not a real network/host/phone/native-shell experiment.

Existing local-limit, binary-family, replay/token/digest/credit and authority
controls remain regression prerequisites. Added malformed/unknown/expired/
cancelled/pin/capability route-oversize controls must stay fatal. After design
approval, add exact route-cap versus cap+1, no-cap file-read, rejected-token
replay/late-payload and subsequent-fresh-request discriminators where the
existing fixtures do not already prove that boundary. No broad full suite/E2E
or repeated #3772/#3773 validation.
