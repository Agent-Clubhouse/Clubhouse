# Desktop reverse-control routes and readiness (#3613 P2/P7/P7w)

## Landed transport and remaining composed proof

At source checkpoint `c2a59f9f2c872bf2cb1fe9852adf8c92f2a996fc`, common
reverse requests/subscriptions are present, the bounded Git diff envelope landed
in #3775, and the narrow Details continuation landed in #3776. These are scoped
desktop changes, not full-duplex, handoff-product or release acceptance.

The historical capability inventory is in
[`evidence/3613-duplex-current-c43/README.md`](evidence/3613-duplex-current-c43/README.md).
Its source-specific missing/candidate labels are not a current-main inventory.
Original evidence and its execution limits remain unchanged.

The existing reverse-consumer fixture's 81,937-byte handoff-shaped envelope is
transport fidelity only: its custom handler accepts `op: chunk`, not the actual
handoff `manifest`/`read` operations. The separate reverse-handoff fixture composes
the existing pinned transport and request adapter with the actual source/receiver
and real disk I/O. Agreement/preparation lookup, application route dispatch and
agent-grant admission remain fixtures; offer, acceptance, apply, renderer and
two-host product behavior are not exercised. Its bounded source/proof
`a4074c7f5e76714bbe346ecee1acfc434307de0e` /
`be01f8bd511dba2a625462021732c119ce6b170e` was independently accepted at
`74d2ed4f64c1e9d539339e5a75b7c3c31171e8b3`, without upgrading those limits.

### Bounded handoff synchronization candidate

The four-file successor follows the independently approved desktop contract
[`6385c5ead`](https://github.com/Agent-Clubhouse/Clubhouse/blob/6385c5ead359d3b46bfc7895e889d4a486dedc4e/docs/evidence/3613-handoff-sync-contract-r2/README.md).
This is an unlanded candidate, not approval of its implementation. A handoff-local
attempt can use request readiness without a snapshot when the direct connection
is absent. It retains the original host and observation revision; every primary
and secondary cancellation POST keeps that capture. Existing positive outgoing
authorization and pending-cancellation/history exceptions remain. Only a fresh
local sender's offered record without pending cancellation takes the additional
negative authority lease. Global connectivity, grant scope, phone fields,
the 30-second sweep and its 10-slot fairness are unchanged.

History adoption and ACK/removal checks run inside their actual private queues,
before admitting the decision/save. Retirement before admission refuses without
that mutation; retirement after admission can complete the save and publish
matching committed memory. No post-save fake refusal or guessed disk rollback
is used. Reverse ACK memory advances only after actual guarded durable success.
Storage errors remain errors, including ambiguous IO that may have replaced the
file before reporting failure.

An enclosing sync holds its queued work. Each deadline-wrapped POST also holds
the actual operation until settlement, not merely until the outer five-second
deadline. Stop retires admissions and drains enclosing writers before replacement;
an expired outstanding POST retains its reference but cannot later admit writes.
Notifications retain their ordinary committed-history semantics, not continuous
transport liveness through notification/provider awaits. No shared-store or notice
ledger redesign is included.

The new paired fixture exercises actual hosts/coordinators/history and command
stores over pinned TLS/control with opposite direct reach blocked and no received
snapshot. Grant callbacks, preparation binding, worker/provider delivery and route
dispatch remain explicit fixtures. It does not replay the separately accepted
content proof or claim native grants, offer/accept/apply UI, two-host or full
handoff-product acceptance. Exact candidate proof and independent source review
are still required before a PR and ordinary hosted gates.

Common REST requests capture one route before sending: a live direct connection
wins, otherwise an already-authorized accepted control link is used. Each request
retains its original trust, direct connection or accepted-link epoch, cancellation,
deadline and local receive limit. A retired response is rejected; an original
control write error keeps its request ID and indeterminate disposition. No error
causes transport fallback, operation replay or a new dial. Existing statuses,
headers, UTF-8/JSON bodies and Retry-After handling are preserved.

The specialized icon, PTY-buffer, file-tree/text-read and bulletin adapters retain
their direct implementations and can use reverse requests when direct is absent.
This text-read API is not an arbitrary binary decoder. Current binary content and
handoff verification still require their separate byte-exact acceptance evidence.

Each missing-icon worker rechecks its originally captured stream before sending
and before recording a result. Retired reverse work cannot become a direct request
or attach to a replacement accepted link. Retirement also retires the icon batch
state, so a fresh stream's first snapshot can fetch the same icons immediately,
even before old abort promises settle; the cached offline snapshot is retained.

A subscription belongs to one current stream and original accepted-link epoch.
Its first compatible snapshot starts a fresh sequence; old frames and asynchronous
icon/canvas completions cannot modify a replacement. Direct availability retires
the owned reverse subscription rather than migrating shells or replaying input.
Stop, disconnect, forget, trust replacement and link loss retire subscriptions,
pending requests and tracked reverse terminal handles. A refused/ended stream is
not subscribed again in the same epoch without explicit Retry.

Only a compatible current stream snapshot projects live renderer consumer state.
Request capability alone does not mint a snapshot or live state. The existing
direct connectivity/publication predicate remains direct-only, and device reach
uses that observation rather than treating reverse consumer state as a direct
route. The narrow Details continuation below separately extends its request
transport and positive snapshot receipts. Selected-board query/import/inventory
hunks remain reserved; Naming's pure alias getter is separate, and its full-list
label notification is held.

### Bounded real producer admission candidate

The local MCP offer captures its original argument/approval scope before dynamic
module awaits, then owns the original host and registered source before implicit
preparation. Its main-only selection binds the exact preparation ID, owner,
project, worktree, mode and summary; neither a replacement source nor a new
same-summary preparation can be substituted. Public tool and phone fields are
unchanged. Valid durable sources need not retain a live runtime; general MCP gate
closure/forget alone does not cancel an already-running call.

Actual history-queue admission follows duplicate/capacity checks, fresh full
authorization for the original call and canonical recipient, and synchronous
original-source/authority/selection continuity. Ask first needs that exact consumed
approval and its original version, captured before awaits; fresh Allow does not
depend on an approval version. Cosmetic bindings do not retire a pending target
capture. Admission precedes the first offer-specific delivery marker or catalog
write, not just history visibility.

Command, preparation and history saves remain independent. Already-admitted
saves may finish truthfully after retirement, publishing matching committed
memory; no post-save fake refusal or rollback is added. Marker/binding failures
retain their actual partial IDs/artifacts. A generic IO failure, including an
after-rename failure, does not prove disk absence or authorize an automatic
new-ID retry. Explicit preparation and initial maintenance remain separate work,
not an offer-wide zero-write guarantee. A producer can own its await of a prior
independent preparation, then make its own original source/mode selection.
Stopping that producer denies its continuation, not the already-admitted read.

Stop/replacement account for actual producer work and already-dispatched POSTs,
including underlying promises beyond the existing five-second waiter deadline.
A committed offer alone cannot initiate fresh immediate transport from a retired
producer. Normal retained-history/notice policy is not a call-specific final-sink
receipt. The isolated real MCP/grant/Git/catalog/history fixture supplies caller
registration, synthetic approval input and a held transport adapter; it proves
neither bridge/provider/live-human authority nor native content/apply/wake,
two-host, whole-handoff or full-duplex acceptance. Independent exact source/proof
review and ordinary hosted gates remain required.

### Landed Details transport and positive admission (#3776)

The four existing Settings, selected dispatcher, agent Details and Changes GET
readers can use an already-authorized accepted reverse request link when direct
is absent. Existing endpoints, encoded targets, caller caps, statuses, body/page
validators and the common one-route/no-fallback request implementation are
unchanged. Old-host route refusals remain unavailable; successful request-only
responses neither mint nor restore a snapshot receipt or populate snapshot cache.

Two private helpers implement this bounded continuation. `captureDetailsRead`
captures the original satellite, selected direct/reverse transport, socket,
stream (including absence), connection generation, pinned trust, role, kind and
pending state before the first await. Reverse reads additionally retain accepted
link epoch and local readiness revision. The same capture is checked before send
and before post-await statuses/body/receipt effects; replacements cannot be
recaptured as the original. Legacy raw-connected direct reader behavior is
retained; socket `OPEN` is a snapshot admission guard, not a new GET permission.

The selected dispatcher reader retains its existing receipt-equality fence.
Ordinary agent Details intentionally does **not** acquire that fence: its captured
receipt is only the exact target for denial invalidation. A late403 cannot revoke
a newer same-stream receipt; a new same-stream snapshot does not alone invalidate
an ordinary successful Details body. Shared structured401 pairing revocation is
unchanged.

`snapshotAdmissionCurrent` requires an owned current `snapshotAccepted` stream,
a compatible nonpaused snapshot, and no pairing/unavailable condition. Direct
admission also requires the existing socket `OPEN` guard. Only the existing
accepted snapshot handler can generate a local UUID; public export only checks
provenance and cannot mint. Wire receipts, request readiness, cached serialization,
resume, retired frames and replacement streams cannot attest retained cache.
Existing retirement clears stream and receipt before close/disposal/publication.

This is the host-authorized transport/currentness and mint/export continuation
mapped in `db46fc6eae9ecd1153dbb9c97b816f002ba5ad86`, not whole-function or
selected-board clearance. No producer, DTO, renderer, Naming, phone/wire, grant,
shared authorization/retirement helper or release changes are included.
The [genuine test-only baseline](evidence/3613-details-transport/baseline/README.md)
retains9FAIL/0PASS/372SKIP on landed `edcd915763a2ec73f0e8149917b4683ced06ecd6`.
Its downstream assertions remain unexecuted. The
[frozen original proof](evidence/3613-details-transport/proof/README.md)
records95 targeted passes on `b1f2ce9b1b360f1ca0fedc2b93af53d67c158a58`;
the actual full fixture compiler remains54FAIL, exactly matching its separate
baseline by complete diagnostic/3956-input comparison. This is not compilerPASS.
Independent review
[`bd4b9fe`](https://github.com/Agent-Clubhouse/Clubhouse/blob/bd4b9feff8aee6e4b03f9d7303ab4cc4fb3e7df0/docs/qa-transfer/2026-11-22/reports/details-b1f2-independent-source-review.md)
accepted the exact source and that separate54FAIL nonregression disposition.
The [hosted packet](https://github.com/Agent-Clubhouse/Clubhouse/blob/63978a2e9213a61795c6a8381e7191c6d7cbabd3/docs/evidence/3613-details-transport/hosted-45017029171/README.md)
records actual checkout and both-platform client results. Those client tests
still mock request/readiness/subscription ports; neither full duplex nor real
paired application acceptance follows from their hosted passes.

### Existing GET Git diff response envelope

With negotiated bulk, the exact existing GET
`/api/v1/projects/:projectId/git/diff` route admits up to **32 MiB of encoded
JSON response bytes**, including its ordinary query string. This rule uses the
original request method/path, before legacy query-sensitive response rules.
Other methods/routes and no-bulk frame limits are unchanged. A stricter caller
receive limit still refuses the owned response before credit; no error retries
or switches routes. Larger responses remain explicitly refused, so this is not
arbitrary-size direct/reverse parity.

Credit bounds each chunk, not the complete process allocation. Four transfers,
complete finish buffers, JSON decoding and target disk/string/serialization
have separate costs. Target clipping retains a logical subarray that can keep
the full backing allocation alive; the route cap is not a target/global RSS
guarantee. Current targeted implementation/proof is subject to independent
exact-source review.

This candidate changes no handler permissions, phone/control/network fields,
P5/P6 fence or grant. #3711 is documented separately below; #3714's narrow security gate, current-app/P8 cleanup
and confinement acceptance, #3760 and the release hold remain separate. Historical
proofs do not transfer. All TypeScript compiler checks require gate minimum 6 GiB;
targeted tests (at most two workers) and scoped lint require minimum 4 GiB.

## Legacy paired-peer removal (#3711)

The legacy `REMOVE_PEER` IPC now revokes the pairing and then calls the existing
client-side forget operation, including when the pairing was already absent.
This retires the retained outgoing socket, requests and stream before returning;
late socket frames and callbacks cannot revive it. The revocation result and
peer-list notification behavior are unchanged. Revoking first preserves the
existing removed-phone notification ordering.

`REMOVE_ALL_PEERS` captures the paired fingerprints before server revocation
clears the peer store, then forgets each outgoing owner. It does not stop the
client, remove unrelated discovered devices, change pairing consent or grants,
or introduce a new removal channel. The unified device-removal and membership
paths are unchanged.

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
A successful network-enabled to network-disabled settings transition aborts
only controller-read leases synchronously before notifying device observers.
SAVE_SETTINGS serializes persistence plus runtime application, so each next
request reads the prior committed or rolled-back settings, never an earlier
save's optimistic cache. Every rejected save remains its caller's failure
without poisoning the queue. Failed and semantic no-op saves do not apply the
network-transition abort hook; direct requests and unrelated sockets keep
their existing lifecycle.

The receive limit remains exactly 8 MiB and the request timeout remains 30
seconds. The local limit is checked against decoded inline bytes and before
bulk credit/allocation, without new wire fields or changes to existing target
limits, P5/P6 authority, deadlines or retry policy. Existing controller
404/405, 401/403 and 429 states remain unavailable, forbidden and rate-limited.

The existing read-only renderer consumes the optional desktop-local
`reach.acceptedControl` observation and per-peer `acceptedControlRevision` to
reload after accepted request-readiness loss/recovery or replacement and
suppress stale results. Revisions capture current trust, accepted-link ownership
and immediate withdrawal before the debounced device publication, so a burst
ending with the same ready boolean does not hide a retired request. Heartbeats,
presentation changes and other peers do not revise a selected peer's read.
The renderer ignores reverse revisions while a direct main connection is up.
This is local IPC metadata, not a
phone/control/network wire field or routing authority. Aggregate direction
presentation can stay up through an opened control or ordinary main link even
when the accepted request link changes; it is not a substitute for this
observation. Missing metadata retains the previous reverse-only hint. It keeps its
polling, history selection and command-free UI. Global satellite connectivity,
Settings/Details reads, writes, other adapters and subscriptions are unchanged.
This is not full P7w/P8, terminal/transfer/federation or phone parity acceptance.
Current-main integration, deterministic negative controls, complete changed
fixture typing and independent exact-head review are required before delivery;
historical P7w results and P7's prior 845-test execution do not transfer.
The fixture configuration uses ES2022 library declarations for existing test
APIs supported by the test/Electron runtime, including `Array.at`. Production's
ES2020 target and `noImplicitAny` remain unchanged; raw wire fixtures and chat
envelopes are contextually typed rather than excluded or cast through `any`.
Observed runtime qualification is Node 24.22.1 and Electron 45.2.3. Complete
fixture typing originally exposed 91 individually mapped diagnostics: 90
legacy-exposed and one introduced. These were 48 TS2550 library diagnostics,
39 TS7018 contextual-fixture diagnostics (38 legacy, one new), one legacy
TS2345 incomplete PeerTrust fixture and three legacy TS2322 chat-envelope
diagnostics. All originals and their classifications are retained.

Pre-fix source `4a9cdd11e8146e4379efd124f65b46dc99694da8` had 890 actual
passes on `fd80a1c58e3362b03440f7a315db8918cda15ee4`, but independent review
found the network-transition and mixed-direction observation gaps above.
Regression-only fixtures reproduced two actual SAVE_SETTINGS semantic failures
with three controls passing, and three UI semantic failures with two
accepted-only controls passing. Earlier IPC fixture setup failures remain
separate receipts, not semantic negatives. That pre-fix proof is not acceptance
of the corrected/current-main composition.

The next `5a44c556d40c8892d0f8e1aa86bfb3de69efd035` composition on
`d991a39e790f02b7da2b9385d2c32aeec0111ba9` ran 939 targeted tests and
production types successfully, but exposed 84 additional integrated fixture
diagnostics (83 TS7018, one TS2353) and two further reviewed race conditions.
Exact source-line blame attributes all 84 to ancestors of that base, not new
P7w test bodies. Explicit card/Changes contracts and malformed-payload contexts
resolve them without changing their values or assertions. Incorporating the
landed Connections paging source exposed one further legacy TS7018 in its
role-page `next` fixture; a typed card callback replaces the existing cast.
Regression-only fixtures separately reproduced coalesced ready-state recovery
and a failed-first/successful-second optimistic save as two genuine failures.
Those originals remain separate from the earlier red/green runs; neither
pre-fix execution is acceptance of the final revision/serialized-save source.

### Current controller-read proof and review

Reviewed source `d0b59fbc8e7274ad1679ca15c5ee0c0776421590`, tree
`90745279c3d077679193875e4c68f54a33ed8a3e`, incorporates actual landed
`d8c7247a4dccc1ebff01f0f28f8e61279bdf5437`. Fresh gated validation on
2026-11-21 ran 886 focused tests plus 65 selected refusal tests: 951 passes,
with 646 deliberate selector skips. Production and complete fixture types
passed; scoped lint had zero errors/162 warnings against the current base's
zero/163, with no added diagnostics.

The initial integrity harness retained stale fd80 fixture expectations after
lint passed; that failure remains an original. Landed d991 had changed eleven
fixtures by 324 bytes. A separate corrected gated phone-only check proved all
103 fixtures/1,529,625 bytes identical across current base, source and worktree,
SHA256 `8b9b4065da56af163f07fb62efa127d4789f2fa8775e6fbb02e77c1805cb620f`.
Lint was not rerun; an intervening gate refusal remains no execution.

The same independent reviewer inspected this exact twelve-file delta and
original focused/type/lint/phone evidence, finding no significant issues after
the lifecycle and save-ordering corrections. No commands were rerun for that
review. A later documentation-only delivery tip preserves all eleven
code/config blobs; it is not another test execution or broader P7w, full-duplex,
security, merge or release acceptance.
