# Desktop reverse-control routes (#3613 P2)

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
