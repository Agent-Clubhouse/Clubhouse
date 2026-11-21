# Current label projection and notification — source/design review

Bound to `c43ffb37d20650c542e449a8a04a9fd84e65b655`. Both patches are **unapplied**.
No client/handler/renderer product change or label-runtime acceptance is claimed.

## Exact agreed split

Naming owns only a pure local alias variable at toPublicConnection entry, the
alias property (c43 line648), and describeAnnexProblem's label argument (line662).
The resolver is the existing pure loaded-memory `annexPeers.peekPeerAlias`;
undefined, ambiguous, unloaded or empty results retain `s.alias`. The same seam
later receives the ordered name resolver, once separately implemented/reviewed.
No `getPeer`/`listPeers` credential initialization or display-triggered IO.

Host owns state652, generation657, receipt658 and lifecycle. Receipt658 remains
held for Details. Neither patch changes these expressions or any `s.alias`,
snapshot, state, epoch, trust, pin, grant, route, timer or connection object.
There is no setter or new source of admission. getSatellites may expose an
**already eligible existing** receipt; the name path cannot mint, restore, rotate
or extend it.

The sole additional notification hunk is the existing handler onDevicesChanged
callback (line155), disjoint from SAVE/MCP/disable ordering. It always performs
the existing DEVICES_CHANGED broadcast. It reads a pure current satellite list,
constructs sorted exact fingerprint/alias tuple strings, and emits the existing
SATELLITES_CHANGED channel directly when this observer's name signature changes.
It never calls broadcastSatellitesChanged, devicesChanged, presence refresh,
fetch, dial, runtime apply or read-lease revision logic. No new debounce/timer.

The observer's signature is private to that callback. It does not wrap, replace,
filter or deduplicate the host's genuine SATELLITES_CHANGED notifications. Genuine
state/generation/receipt updates still use the host's unchanged publication path,
even if the alias/fingerprint signature is identical.

Sorting uses ordinal tuple text, not locale ordering. Reordering an equivalent
list does not generate another name notification; exact fingerprint or alias
differences do. Full snapshots/generation/receipt are deliberately absent from
the name dedupe key: a name callback must not become their publication authority.

## Required review and executed controls before implementation/landing

The source patches are mapping proposals, not a claim that a full-list name
notification is harmless to renderer reconciliation. The current receiver calls
reconcileSatellites, which takes fresh receipt/generation fields and can hydrate
missing catalogs. That must be tested, not inferred from unchanged client fields.

The proposed observer starts with an unknown signature, so its first callback
publishes, including an empty/new-topology list. This avoids losing a rename in
the first coalesced connection/device burst, but is an explicit **unaccepted edge**:
startup/late-read/missing-catalog controls must show it does not cause forbidden
hydration or restore retired streams/positive admission. If those controls fail,
do not apply this callback wholesale. Report the exact failing source path and
obtain a separately scoped notification/renderer design; do not silently add a
new event/envelope or make a full snapshot authoritative through a label change.

Controls in controls.json bind both main and real renderer stores:

* The same healthy socket remains open, with unchanged snapshot object, epoch,
  receipt identity, trust, grants and active read leases across rename.
* Previously absent/retired receipt remains absent; paused/unavailable/disconnected
  or re-pair states cannot gain positive admission through a label event.
* Settled permissions, sleeping/retired agent streams, pause state, visibility and
  deferred reconciliation remain unchanged; no hydrate method/fetch/read is invoked.
* Pending initial/manual GET cannot return an older Alias over a newer name event;
  cleanup/retired callbacks and replacement generations cannot revive old rows.
* Peer lookup with no loaded cache does no IO and uses the prior connection label.
* New topology/first burst/removal and reordered-equivalent lists are explicit
  cases, not omitted as presumed host behavior. Dedupe can suppress only the
  observer's redundant labels; it cannot suppress genuine host notifications.

No production renderer change is proposed by this freeze. Whether the existing
reconciliation handles these controls is still unexecuted. The parent has routed
this host/naming split; independent source/design review precedes extra
notification implementation. Any failure needing broader renderer/IPC hunks must
be disclosed before editing them.

## Scope and larger naming dependency

This is the existing cached-label defect from #3720. It is separate from durable
ordered names and the stale self-hello/members overwrite. It needs no blanket Q5
journal/index/provider adoption. Future adoption of a shared primitive still
requires actual contract/ownership review. Store body/race review, actual Alias
intent and name durability, negotiation, mixed-version/restart/security proof
remain separate gates. Utilities #3764–#3767 confer no consumer or readiness proof.

Only patch applicability and source binding are checked here. No types/lint/tests,
snapshot-currentness execution, app/OS/live or full-duplex credit.
