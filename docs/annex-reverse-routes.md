# Desktop reverse-control routes and readiness (#3613 P2/P7/P7w)

## Route and reconnect slice (P2)

This is a partial implementation slice, not full reverse-parity acceptance.
The phone contract, `/ws`, `/network`, pairing, grants and approvals are unchanged.

`annex-routes.ts` describes desktop-local, peer-bound endpoints. Candidate order is
discovery, the saved typed address, announced endpoints, then remembered addresses.
Host and port stay together; duplicates are removed. A saved typed address bound
to another certificate and all `heldRoutes` are excluded. Legacy saved addresses
still require the current pinned TLS handshake.

Private forwards belong to the desktop that saved them and the specific peer
they reach. Route selection checks both identities. Announced loopback addresses
are not usable. A shared endpoint on the same host as a private forward retains
its own announced port. No route metadata here is persisted or sent to phones or
other members. Withdrawing the active endpoint also retires negotiated control;
unrelated additions or reordered routes preserve a still-allowed live socket.
The request selector prefers a live direct route, otherwise an
already-negotiated reverse control link, and selects only one transport.
Migrating request/subscription consumers and proving full-surface parity are
separate work; P2 does not change request forwarding.

While the client and server are enabled, the client supplies known routes for
active, pinned desktop network members. `/control` opens proactively without
opening a desktop view or waiting for `/ws`. It uses the same pinned mTLS options
and user-managed forward. The opener owns reconnect; receiving a reverse request
never starts a reverse dial.

The authenticated control connection has a separate lifetime from `/ws`.
An ordinary main-socket drop still withdraws the main epoch, buffer ownership and
membership channel, but does not close control. Explicit disconnect, replacement
of the main host, pairing/pin stops and client shutdown do close it. Retry and
initialization recheck client/network settings and current pairing authority;
they cannot automatically resurrect a stopped connection.

Each peer has at most one outgoing socket or pending handshake and one retry
timer. Failures try the next known endpoint serially, with exponential backoff
starting at 1 second and doubling to 30 seconds. Jitter multiplies by 0.5-1.5,
with a hard final maximum of 30 seconds. A connection must remain negotiated for
30 seconds before a drop resets backoff, so hello/drop flapping and presence
notifications cannot produce a reconnect storm. Operations are never retried.

Pre-control desktops can reset an unknown upgrade path rather than returning an
HTTP error. A transient reset retries normally. After six consecutive
reset-before-upgrade failures in the same peer/route/trust epoch, with no
successful control hello, probes slow to a 10-minute interval with 0.5-1.5 jitter
(5-15 minutes). A changed route or pairing trust, a fresh authenticated direct
`/ws` connection, or explicit Retry resets that probe backoff. Ordinary heartbeats
and presence notifications do not. Successful control negotiation ends
unknown-peer probing for that epoch. These probes open only `/control`; they
send no new frames on `/ws` or `/network`.

Routes, pairing trust and the existing authorizer are rechecked before dialing,
after TLS upgrade and after capability negotiation. Stale callbacks cannot take
ownership of a newer connection. Forget, revocation, client/server/network stop,
pin mismatch and certificate errors stop or cancel pending work. An explicit
Retry can re-probe; replacing an authorized pairing starts a fresh trust epoch.
Auto-reconnect respects the existing setting, including already-scheduled retries.

An older peer that refuses `/control` with 404, 405 or 426, or negotiates no
reverse-request capability, is not repeatedly probed. A changed known route or
explicit Retry can try again. Capabilities are negotiated afresh and never saved.
Its direct connection keeps today's behavior.

This successor ports only the original P2 route and scheduled-settings semantics
onto main after #3750. It does not import P7w/P8 or their historical ancestry.
There is no relay, multi-hop routing, tunnel/CLI management, new permission,
listener change, phone wire field or UI. Current P5/P6 authorization fences,
request/subscription ownership, strict HTTP reads and #3715 registration leases
remain in place.

Integration requires the separately delivered #3748 main-connection attempt
fence: a deferred refusal from an old main attempt must not stop a replacement
main or its independently authenticated control connection. P2 does not supply
or replace that patch.

`tsc -p docs/annex-reverse-routes.tsconfig.json` checks production sources and
the complete deterministic route/reconnect fixtures. Current-head validation
and independent delta review are required; historical P2 counts are not proof
of this successor or its composition with the separate wake fix.

## Desktop direction readiness (P7)

This separate successor depends on P2. Settings reports each direction
independently, preferring a direct observation. A control socket counts only
while open, after negotiating request capability, and while the request path's
existing authority still allows its pinned peer. An accepted connection
provides reverse outbound readiness; an opened connection provides reverse
inbound readiness. Only active, pinned desktop network members use it.

The existing desktop device-list IPC publishes negotiation and closure
transitions, not heartbeats or request frames. If reverse control covers a
missing direction, Settings does not suggest another forward for that
direction. Old-peer one-way advice and phone behavior remain unchanged.

These are transport-readiness observations, not proof of end-to-end reverse
requests, subscriptions, terminals or transfers. P7 changes no transport
selection, connection ownership, reconnect, grants, permissions or phone wire
fields. P7w consumer migration and full P8 acceptance remain separate; historical
P7 results are not evidence for this current-source successor.

The same fixture tsconfig also checks the complete current control, device-list
and Settings test files for P7, in addition to the P2 route/reconnect fixtures.

## Controller conversation reads (bounded P7w)

Only the read-only controller conversation page/history and sessions adapters
opt into the existing request selector. A connected direct route keeps its
existing pinned HTTPS implementation and wins over reverse control. Otherwise,
an already-authorized accepted control link can carry the existing GET routes.
There is no dial, transport fallback or operation retry after selection.

Reverse reads require the client to be running and enabled, active pinned
desktop network membership, current pairing authority and no manual pause or
pairing/pin/clock halt. Each read owns a cancellation/trust lease. Revocation,
trust changes, explicit disconnect, stop, forget and host replacement retire
that lease; a normal main-socket drop does not. Explicit Connect or Retry can
lift a manual pause. Responses from a retired lease are never published.

The receive limit remains exactly 8 MiB and the request timeout remains 30
seconds. The local limit is checked against decoded inline bytes and before
bulk credit/allocation, without new wire fields or changes to existing target
limits, P5/P6 authority, deadlines or retry policy. Existing controller
404/405, 401/403 and 429 states remain unavailable, forbidden and rate-limited.

The existing read-only renderer consumes device readiness transitions to
reload after reverse loss/recovery and suppress stale results. It keeps its
polling, history selection and command-free UI. Global satellite connectivity,
Settings/Details reads, writes, other adapters and subscriptions are unchanged.
This is not full P7w/P8, terminal/transfer/federation or phone parity acceptance.
Current-main integration, deterministic negative controls, complete changed
fixture typing and independent exact-head review are required before delivery;
historical P7w results and P7's prior 845-test execution do not transfer.
