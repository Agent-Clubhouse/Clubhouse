# Desktop reverse-control routes (#3613)

This is a **partial implementation slice**, not full reverse-parity acceptance.
The phone contract, `/ws`, `/network`, pairing, grants and approvals are unchanged.

`annex-routes.ts` describes desktop-local, peer-bound endpoints. Candidate order is
discovery, the saved typed address, announced endpoints, then remembered addresses.
Host and port stay together; duplicates are removed. A saved typed address bound
to another certificate and all `heldRoutes` are excluded. Existing legacy saved
addresses still require the current pinned TLS handshake.

Private forwards belong to the desktop that saved them and the specific peer
they reach. Route selection checks both identities. Announced loopback addresses
are not usable. A shared endpoint on the same host as a private forward retains
its own announced port. No route metadata here is persisted or sent to phones or
other members. The request selector prefers a live direct route, otherwise an
already-negotiated reverse control link, and selects only one transport.
Migrating request/subscription consumers and proving full-surface parity are
separate work; P2 does not change request forwarding.

While the client and server are enabled, the client supplies known routes for
active, pinned desktop network members. `/control` opens proactively without
opening a desktop view or waiting for `/ws`. It uses the same pinned mTLS options
and user-managed forward. The side that opens it owns reconnect; receiving a
reverse request never starts a reverse dial.

Each peer has at most one outgoing socket or pending handshake and one retry
timer. Failures try the next known endpoint serially, with exponential backoff
starting at 1 second and doubling to 30 seconds. Jitter multiplies by 0.5–1.5,
with a hard final maximum of 30 seconds. A connection must remain negotiated for
30 seconds before a drop resets backoff, so hello/drop flapping and presence
notifications cannot produce a reconnect storm. Operations are never retried.

Pre-control desktops can reset an unknown upgrade path rather than returning an
HTTP error. A transient reset retries normally. After six consecutive
reset-before-upgrade failures in the same peer/route/trust epoch, with no
successful control hello, probes slow to a 10-minute interval with the same
0.5–1.5 jitter (5–15 minutes). A changed route or pairing trust, a fresh
authenticated direct `/ws` connection, or explicit Retry resets that probe
backoff. Ordinary heartbeats and presence notifications do not. Successful
control negotiation ends unknown-peer probing for that epoch. These probes open
only `/control`; they send no new frames on `/ws` or `/network`.

Routes, pairing trust and the existing authorizer are rechecked before dialing,
after TLS upgrade and after capability negotiation. Stale callbacks cannot take
ownership of a newer connection. Forget, revocation, client/server/network stop,
pin mismatch and certificate errors stop or cancel pending work. An explicit
Retry can re-probe; replacing an authorized pairing starts a fresh trust epoch.
Auto-reconnect respects the existing setting.

An older peer that refuses `/control` with 404, 405 or 426, or negotiates no
reverse-request capability, is not repeatedly probed. A changed known route or
explicit Retry can try again. Capabilities are negotiated afresh and never saved.
Its direct connection keeps today's behavior.

There is no relay, multi-hop routing, tunnel/CLI management, new permission,
listener change, phone wire field or UI in this slice. P5/P6 authorization fences,
request/subscription ownership and strict HTTP reads are untouched.

## Desktop direction readiness (#3613 P7)

Settings reports each direction separately, preferring a direct connection.
A control socket counts only while open, after negotiating request capability,
and while the request path's existing authority still allows its pinned peer.
An accepted connection lets this computer reach its opener through that
computer's connection here. An opened connection lets the peer reach this
computer through this computer's connection to it.

Readiness updates use the existing desktop device-list IPC. Negotiation and
closure publish transitions; heartbeats and request frames do not. If reverse
control covers the missing direction, Settings does not suggest adding another
forward for that direction. Without negotiated capability, the existing
direction and one-way advice stays unchanged. Phones still use their existing
routes and copy.

These are transport-readiness observations, not proof of end-to-end reverse
requests, subscriptions, terminals or transfers. They do not change transport
selection, connection ownership, reconnect, grants or permissions. P8 acceptance
remains separate.

## Desktop consumer wiring (#3613 P7w)

Desktop REST consumers now share one request seam, including chat, files, icons,
PTY buffers, git, agent calls, group-project writes and handoff requests. A live
direct connection wins. Otherwise the existing request authority must report a
negotiated, authorized incoming control link (`acceptedHere`), and the desktop
client must be running and enabled. A socket being open is not enough. Pairing,
discovery and certificate probes remain direct-only.

The transport is chosen once, before sending. A failed, cancelled or timed-out
operation never falls through to the other transport. Reverse failures retain
their request id, error code and indeterminate flag. A write whose answer is
lost may have executed; making another route available does not send it again.
Existing application-level refusal handling and durable outbox policies are
unchanged.

The adapters retain their HTTP status, response headers, JSON/text/byte handling,
timeouts and cancellation. Specialized direct GET adapters decide unusable status
or content type on response headers, draining unused bodies without delaying their
original result. Reverse replies keep their existing buffered completion semantics.
A caller's `maxResponseBytes` also bounds reverse receipt: inline decoded size is
checked before allocating its body, and bulk
size before accepting or crediting the transfer. Exceeding that local cap fails
only the request, not unrelated subscriptions. Existing protocol/path caps and
P6 rejection fences still apply. The limit is local, not a new wire field.
`files/read` remains uncapped UTF-8 text, not an arbitrary-binary-file API.
Working-tree `git/diff` also retains its existing uncapped response over bulk;
requester-local limits still apply, and other Git routes keep their existing limits.
The existing bulletin all-message and topic GETs and native session transcript
GET also retain their uncapped responses. Only those exact endpoints are exempt;
other routes and methods keep their budgets. Bulletin message transport failures
reject on both direct and reverse paths instead of appearing as an empty board.
The board shows the read error, preserves prior messages and keeps its normal polling.

One reverse subscription feeds the existing satellite snapshot and event IPC.
Public satellite connectivity includes authorized reverse reachability, while
Settings keeps a separate direct observation so `via=reverse` stays accurate.
Request-only peers do not acquire subscription or terminal-control capability.
Old peers without reverse capability keep their direct/offline behavior.

Snapshot ordering and asynchronous icon/canvas guards use a stream identity,
not a WebSocket. A new stream gets a fresh snapshot; late callbacks from the old
one cannot replace it. Direct becoming available replaces the reverse
subscription. This is a real ownership boundary: D10 closes private shells
owned by an ended subscription. There is no shell migration or replay of input.
An ended/refused subscription does not spin; a new control-readiness transition
or explicit retry can start another.

Disable, stop, disconnect, forget, revocation and changed pairing trust retire
the owned stream and cancel affected local requests. Client stop does not close
unrelated incoming control links. Ordinary stream frames add no device-readiness
notifications. Grants, approvals, reverse eligibility and P5/P6 authority checks
are unchanged.

The consumer probes are now ordinary tests. They exercise nine families in both
single-forward orientations, with reverse direct dials blocked, a dial audit
and an independent sentinel. They use the actual client/control stack and small
fixture target handlers, not the complete production server or paid models.
This proves consumer wiring, not full-surface P8 acceptance; the full inventory,
hosted end-to-end coverage and physical-machine/phone acceptance remain separate.
