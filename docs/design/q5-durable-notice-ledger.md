# Q5 durable group-notice delivery ledger

Status: contract for independent review; product implementation has not started.
Inspection base: `d8c7247a4dccc1ebff01f0f28f8e61279bdf5437` (main).
Task branch: `auto-reset-policy-design/q5-durable-delivery-ledger`.
Canonical standalone issue: [Clubhouse #3758](https://github.com/Agent-Clubhouse/Clubhouse/issues/3758).
Parent published the exact preserved title/body after a later explicit user
authorization for its existing gh writer. The earlier MCP403 is historical;
`q5-issue-publication-draft.json` preserves it without alteration. No MCP retry,
new grant, credentials change or issue-write by this helper occurred.

Contract revision 2 addresses independent review C1–C3 at
`9d865f4e71ff95cb6581a29ad9fe074f6ece649e`,
`docs/qa-transfer/2026-11-20/reports/q5-b0d52ee6c-contract-review.md`.
The original contract remains immutable at `b0d52ee6c384386ef46eba3028634d7fc9d60473`.

## Decision and canonical history

The user selected **keep notices flowing with a durable delivery ledger**, rather
than persistent member pause. An unconfirmed earlier notice is retained and is
not automatically retried; later eligible posts can still produce notices.

The canonical earlier proposal is [Q5-policy-proposal.json](https://github.com/Agent-Clubhouse/Clubhouse/blob/e2340b51e434c499b5e4f7014e9bc3bcd857920f/notes/diagnose-navi-queue-transfer/evidence/Q5-policy-proposal.json).
Its adjacent README explicitly records no issue or PR for that assignment.
Historical baseline `edce1d072a674bc4d3673296a13b18ad54f535e5` has three
expected failing modeled tests: later success skips uncertainty, and reconnect
replays an uncertain batch with/without delivery memory. It does not prove an
actual provider incident or real process restart. The withheld runtime candidate
`0bb43aba9db9504bd5141f1387a512cf97a9b8ba` is evidence, not accepted code.
Related notices feature #3362 is not a Q5 issue number.

This contract authorizes no live setting changes, activation, chat clearing,
restarts, extra probes, access changes, installs, merges or releases. Controller
recovery preserves chat by default; explicit reset belongs to a separate owner.

## Source and writer inventory

Inspected at the base above:

| Source | Observed seam / consequence |
| --- | --- |
| `src/main/services/group-project-delivery.ts` | `deliver` installs settlement callbacks only in its busy branch; idle ignores returned queued delivery. `acknowledge` stores max sequence. `onConnected` reconstructs posts above that cursor. Later acceptance can hide a gap. |
| `src/main/services/group-project-notification-store.ts` | One `notified[group,agent]` scalar; shared serialized writer also maintains wake/urgent budgets. Validator discards extra fields. Corruption recovery baselines at current board sequence. Neither behavior may erase ledger uncertainty. |
| `src/shared/chat/runtime.ts` | Current `ActionQueueSettlement` has delivered/expired/replaced/dropped, no submitted-but-unconfirmed outcome. `RuntimeSendResult` is delivery mode, not proof of agent processing. |
| `src/main/services/agent-runtime/chat-runtime.ts` | `settleQueued`, immediate `deliverMessage`, queued `deliverQueuedMessage`, removal/expiry/discard, and session replacement are actual boundaries to classify. A rejected `session.send` is currently reported dropped in queued dispatch. |
| `src/main/services/actions/steps.ts`, `actions/engine.ts`, `clubhouse-mcp/tools/dispatcher-delivery.ts` | Other production owner of the settlement callback. Must exhaustively handle any added uncertainty variant, without fabricating cancellation or confirmed receipt. No sole-consumer claim. |
| `src/main/services/group-project-wake.ts` and `clubhouse-mcp/tools/agent-lifecycle.ts` | Existing guarded direct-post wake passes notice as mission. A Boolean false or failed spawn is not by itself proof the mission never reached a provider. Must be included in intent coverage. |
| `src/main/services/settings-store.ts:replaceFile` | Temp-file write, file sync and rename; no explicit parent-directory sync. Reuse as a utility only after reviewing limits; no shared writer change is proposed. |
| `src/renderer/features/group-projects/GroupProjectDeliverySection.tsx` | Existing local post-notification status is the proposed home for local uncertain batch status/retry, separately from saved permission. |

No product edit before independent contract review and coordinated hunk ownership.
Lane3613 owns SAVE_SETTINGS/controller reads, Details owns M1/M2; neither is in
this task. Parent routes overlap checks for runtime/delivery and renderer/API
seams before edits. No new connections or remote probes are needed.

## Guarantees and limits

1. A delivery handoff requires a persisted intent covering its exact post IDs.
2. Confirmed later coverage never converts an earlier uncertain record to success.
3. Automatic reconnect/restart skips confirmed, active-attempt and uncertain IDs;
   it may recover only explicitly known-unsubmitted or newly discovered IDs.
4. Uncertainty affects the batch, not subsequent independent notices to a member.
5. A local user can explicitly authorize one retry attempt after a duplicate
   warning. Recovery never creates that authorization.
6. Membership, deliver/wake permissions, sender identity, queue/session ownership
   and storage health are rechecked at their actual handoff boundaries.

“Accepted” means the existing runtime/driver acknowledged its handoff. It does
not mean the provider processed it, the agent read the board or a person saw it.
PTY acceptance establishes at most successful input handoff; label that weaker
receipt separately. No provider idempotency support is assumed. **No exactly-once
execution, end-to-end delivery or power-loss guarantee is claimed.**

## Identity, records and coverage

Use a local versioned ledger directory in app userData, never replicated board
metadata. Proposed directory: `group-project-notice-ledger.v1/`. Its envelope has
`schemaVersion: 1`, `minWriterVersion: 1`, monotonically increasing `revision`,
and per-recipient rows. Unknown future schema/minWriter versions refuse writes
and delivery; preserve original bytes. Unknown additive fields of a supported
version are preserved in read-modify-write, not silently dropped.

Recipient identity is the tuple `(groupId, fixed host.machine identity or the
explicit local-host sentinel, local agentId, membershipGeneration)`. Persist a
random membership generation when first initialized; retire it on confirmed
departure/group deletion. Display names, runtime session IDs and callable tool
labels are never recipient identity. A transient unresolved roster is not a
departure. A changed host identity or regressed/conflicting board identity is
visible and held for inspection; do not quietly rebaseline or reuse keys.

Each recipient row contains:

- `baselineThrough`: existing legacy cursor, or a new-member baseline captured
  at initialization, explicitly **not newly observed delivery**.
- `scannedThrough`: board change sequence through which a complete bounded scan
  and classification was durably committed. This is a scan frontier, not an ACK.
- Compact closed sequence intervals for terminal coverage: **accepted or
  excluded**, without falsely saying excluded posts were delivered. Adjacent
  intervals merge even above an uncertain hole. Keep exact `(seq, postId)` only
  for sparse ready/active/uncertain exceptions and attempt coverage. Intervals
  do not require a contiguous success frontier from zero. Alternating accepted
  and excluded posts do not create alternating interval types: both are safely
  covered for replay, with aggregate accepted/excluded counts, not per-post
  historical delivery claims. Ineligible own/system/subscription posts stay
  scan-time exclusions; later subscription changes do not revive them.
- Batches/attempts with exact sorted `(seq, postId)` coverage, `batchId`,
  `attemptId`, optional parent attempt for explicit retry, state, revision,
  timestamps, bounded reason code, runtime kind, and runtime message ID if known.

Do not persist post bodies, generated notice text, topic/sender/display names,
prompts, provider errors or transcripts in the ledger. Board content remains in
its existing authoritative store. Lookup retry text there, with current grants.
If a covered post was trimmed/deleted, report unavailable; do not reconstruct it
from a private text copy or infer it was delivered. Sequence gaps/non-post board
changes are not evidence of missing posts. If a complete scan cannot be proven,
do not advance `scannedThrough` past that portion.

Idempotency uses two levels:

- Coverage key: canonical JSON tuple of recipient identity plus `(seq, postId)`.
  Same post observed via onPost, reconnect and overlapping scans creates one
  coverage row. Same seq with different ID is a source conflict, not a duplicate.
- Attempt key: persisted UUID within that recipient generation, with a digest
  of exact canonical post coverage. Same key/same digest is one state machine;
  same key/different digest is refused. Coalescing before handoff may change a
  ready batch; once intent is saved its coverage is immutable. A manual retry
  uses a new attempt ID linked to its predecessor, never an invented success.

Keys enforce **local admission and callback deduplication only**; they are not
passed off as provider exactly-once keys. Serialize per-recipient operations and
store commits; mutation is copy-on-write, published to cache only after success.
Stale callbacks can settle only their exact stored attempt and recipient
generation. Repeated equal terminal outcomes are no-ops; conflicting late
outcomes are retained as a visible anomaly, never overwrite a newer attempt.
An absent sequence selects the supported post-ID mode below, not indefinite
deferral. Invalid identity or conflicting sequence is a visible source conflict,
with the explicit adoption path below; never guess a key.

### C3: supported legacy post-ID mode

Sequencing is preferred, not a minimum host requirement. If current board posts
lack a safe sequence, use `coverageMode: post-id-v1` for that generation, visibly
labelled “Older board: tracked by post ID; no host ordering guarantee.” Stable
`BulletinMessage.id` is required. Snapshot all current authoritative board IDs
on first upgrade/new member as baseline exclusions; do not replay old history.
Serialize snapshot activation with queued post events, so events after the
snapshot remain eligible and duplicate events already in it are suppressed.
Never infer a host sequence from timestamps, ID text or local arrival order.

Persist exact baseline/covered IDs in content-free, hash-partitioned index pages
(maximum256 KiB/page), plus sparse unresolved attempts. A digest chooses the
page; full ID equality decides coverage, so hash collision cannot drop a post.
One batch has at most50 IDs. Incoming events and a complete existing board
snapshot are deduplicated against this index and sparse attempts. Recovery
scans all available IDs instead of querying a numeric cursor; unavailable or
incomplete board snapshots report that limit and do not invent exclusions.
No transport fallback, polling/probes or host update is initiated by this mode.

Post-ID index storage is O(distinct covered IDs), an explicit compatibility
cost which arbitrary unsequenced IDs cannot safely compress into intervals.
Pages spill incrementally rather than hit a post-count admission cap. This
does not promise finite disk use for infinite traffic. Retain ID tombstones
even when content is deleted, so reappearance is not a fresh notice. Runtime
handoff uncertainty, retry and later-post liveness have the same semantics as
sequenced mode. A sequenced group alongside it is unaffected. Mixed boards use
post-ID mode for the generation; a later host upgrade does not auto-switch or
rebaseline. The local-human adoption action may explicitly start a sequenced
generation after showing its fresh baseline and the retained old uncertainty.
Missing stable ID is visible “Board identity unavailable”; manual board access
remains available and other valid recipients/groups continue. It is not silently
treated as delivered or deferred forever without status.

### C2: explicit local-human identity adoption

When host identity changes, source sequences regress/conflict, or the user wants
to leave post-ID mode after a real host upgrade, show “Board identity changed;
new notices need local confirmation” with old unresolved count, current host
display label and reason. Do not auto-adopt on reconnect, re-pair, rename or
restart. No actual pairing or trust change is part of this action.

A trusted local-human prepare-adoption IPC reads the current authenticated
group/host/board snapshot, validates existing group read/deliver authority, and
mints and persists a one-use five-minute nonce bound to installation UUID,
recipient/old generation, expected root revision, exact new host/coverage mode,
and proposed fresh baseline (sequence or snapshot-ID digest). The confirmation
explains: old unconfirmed deliveries remain unconfirmed; existing posts become
the new baseline and are not automatically replayed; new notices resume. A
second main read must still match those values. Renderer cannot nominate an
arbitrary fingerprint, generation or baseline. If anything changed, refuse
without adoption/send and require a new preview.

In one journal commit, consume the nonce, retire old generation with unresolved
attempts intact, create fresh random generation and baseline, and cancel
known-held old work. Final runtime entry is fenced by generation so removal
failure does not authorize a stale queued send. Already submitted old work
cannot be undone: late receipts remain historical and never change new
coverage. No notice is sent as part of adoption. Only subsequent eligible posts
enter the new generation; manual board reading remains available meanwhile.
Cancel before confirmation sends nothing and leaves generation unchanged.
Lost reply/double click reads the same persisted adoption result, never repeats
adoption. No agent, phone/Go route or timer can adopt; old uncertain rows are
still visible as retired history, not resolved or silently waived.

## Attempt state machine

| Durable state / observation | Permitted transition and recovery |
| --- | --- |
| `ready` (no handoff possible yet) | Existing batching, throttle and asleep behavior; may be automatically attempted after admission. |
| `intent` saved before runtime or wake handoff | Exact coverage reserved. Process loss here becomes uncertain even if dispatch may not have happened. |
| `queued` returned and saved | Runtime holds work; not confirmed. Must retain callback and cancellation ownership even when the owner's earlier busy check said idle. Process loss becomes uncertain unless durable proof of non-submission exists. |
| Runtime handoff acknowledged | Persist `accepted` with receipt strength; covered IDs become confirmed. This is not a provider-processing receipt. |
| Submitted, acknowledgement missing/rejection/timeout/session loss | Persist `uncertain`; exclude only those IDs from automatic recovery. Later posts continue. |
| Proven expired/replaced/dropped before provider entry | Persist `unsubmitted` with reason. Existing permitted recovery may make its IDs ready; never treat a post-submit error as this state. |
| Removed membership or deliver permission before entry | Persist `revoked`/held-unsubmitted as appropriate; do not dispatch. Historical unknown outcomes stay unknown. |

All busy and idle paths install receipt-aware ownership before calling the
runtime. The returned actual mode governs: queued waits for settlement;
acknowledged immediate mode can settle the same attempt; thrown errors default
to uncertain unless the runtime supplies bounded proof of pre-entry refusal.
Callback-before-return, callback-after-return and duplicate callbacks must be
safe. Callback state transitions run on the serialized owner path, not mutate
replacement in-memory state directly. An ACK received but not durably saved
leaves the old intent uncertain after restart, not automatically replayable.

Add an explicit `unknown` runtime settlement for a dispatched queue item whose
acknowledgement is unavailable. Update both production consumers exhaustively;
Actions may use its existing failed receipt with explicit unconfirmed text,
not a false cancelled/dropped outcome. Do not copy the entire withheld runtime
candidate or claim its historical 516 tests validate this new head.

The runtime must distinguish crossing `session.send` from pre-send admission,
including failures in provenance, queue removal, session replacement and late
completion. Once send has been entered, failure is conservatively unknown;
cleanup cannot turn it into unsubmitted. Receipt publication failure after an
acknowledged send cannot be classified as send failure. Scope any runtime change
to necessary settlement/admission fences, independently reviewed.

## Coalescing, continued delivery and rate limits

Only ready, never-submitted posts are freely combined. For an already queued
batch, replacement is allowed only after runtime removal proves its exact
attempt was replaced **before** submission and that proof is saved. If removal
races submission, preserve the old attempt as active/uncertain, and send only
new post IDs in the next notice. Never merge uncertain coverage into a fresh
automatic notice. Unique queue ownership per attempt prevents group-wide
latest-only replacement from silently discarding a sibling attempt.

Retain existing burst delay, normal notice rate limit, urgent allowance and
wake budgets. Uncertainty is not a reason to spam or bypass throttles. Persist
enough attempt timing to conservatively restore normal-notice rate windows on
restart; an uncertain attempt consumes its slot. Existing wake/urgent budget
store remains authoritative; ledger commits do not refund these on uncertainty.
Definite pre-entry refusal may be reported without pretending a notice sent.

### C1: compact coverage and continued flow at the detail bound

One uncertain seq1 followed by1,000,000 accepted/excluded sequences is one sparse
hole plus interval[2,1000001], not1,000,001 post rows. Ready/active holes split
intervals; terminal runs on both sides merge independently. Keep a separately
named contiguous accepted-or-excluded floor for truthful optional legacy cursor
export; do not call the scan frontier that floor. The normal sequenced storage
cost after compaction is O(holes+active attempts), not O(later post count).

Shard by recipient generation. Use bounded append-only journal segments (256
KiB target, maximum512 KiB including a final record), bounded checkpoint/index
pages (maximum512 KiB), and maximum64 KiB per committed delta. Limit a batch to
50 IDs and split a burst rather than truncate coverage. No full shared16 MiB
rewrite per notice. Confirmed/excluded intervals compact incrementally; sealed
segments are superseded only after the replacement checkpoint manifest commits.

The hot detail budget is256 unresolved/active attempts per recipient, not a
total uncertainty cap. Crossing it seals older uncertain detail into immutable
paged history with exact IDs, outcomes and retry links preserved; show “More
unconfirmed deliveries retained in local history” with exact count and paginated
lookup. New posts still append and dispatch under ordinary limits. No “capacity
pause”, TTL waiver, eviction or automatic retry. Archive location/revision is
deterministic and addressed through the checkpoint manifest; status/retry reads
the original entry plus later settlement events. A resolved retry does not
rewrite history as an original confirmed handoff. Keep at most4 uncheckpointed
segments per recipient by incremental compaction before rolling the next segment;
the bounded compaction may delay a commit but never require resolving old holes.

This bounds active page/commit size, not total disk for an unlimited number of
uncertain deliveries. Total retained archive grows O(unresolved holes) (and OIDs
in legacy mode). Actual disk exhaustion, unreadable storage or failure to commit
still refuses new handoffs visibly; no software can persist unlimited facts on
finite disk. That operational failure is different from a deliberately imposed
hole-count stop. A detail-threshold test must cross256 holes, deliver later work,
reload, and retrieve the first uncertainty without replay. Measure isolated
append/file-sync and checkpoint/rename/directory-sync latency at these byte
bounds; report actual environment/results, not a latency promise or product proof.

## Explicit retry and visible uncertainty

The local Group Project post-notification section shows unresolved batch count,
member display label resolved live, range/time and honest receipt status:
“Delivery unconfirmed. New notices continue. Retrying may send a duplicate.”
No bodies/sender names in local log/telemetry/export. Local UI can read details
only under existing group/read authority. This status is local computer data,
not a remote-members delivery claim. It is separate from notice permission.

Retry once is a local-human IPC action, not an agent tool, remote Annex command,
board post or unattended timer. Present explicit confirmation with the duplicate
warning. Main mints and persists the nonce at the prepare/preview step; never
accept a renderer-created nonce. Bind it to installation UUID, trusted window,
recipient generation, batch, attempt revision,
one use and a five-minute expiry. Repeated renderer submission of the same nonce
returns its saved result. Consume authorization and create the child intent in
one durable transaction **before** handoff. A crash after that commit does not
leave a reusable authorization or enable automatic repeat. If the retry is also
uncertain, show that separately; a later further retry needs fresh confirmation.
No implicit waiver/mark-read/confirm-received operation in this first version.

Closing/cancelling the warning before confirmation consumes no authorization,
creates no intent and sends nothing; the prepared nonce may remain until its
expiry and is not interpreted as consent. After intent commit, cancellation cannot promise
that input was not sent; report queued/accepted/uncertain according to evidence.
If the IPC reply itself is lost, the UI shows “Retry outcome unconfirmed” and
reads the saved nonce/attempt result; it never issues a fresh retry or switches
transport automatically. A repeated request with the same nonce is a status
lookup of the consumed authorization, not another handoff.

Retry requires an awake matching runtime, current membership/deliver permission,
post availability and current subscription/mention relevance. It cannot wake a
sleeping member, change permissions, switch recipients, restore removed posts,
or clear the chat. A refused preflight consumes no new dispatch intent; an
authorized in-flight attempt remains recorded honestly after revocation.

Both retry and adoption handlers require the registered local main Clubhouse
window WebContents ID, a live BrowserWindow, `event.senderFrame ===
event.sender.mainFrame`, and the exact registered app-entry document URL after
normalization. Reject popouts, window.open children, navigated windows, plugin
webviews/subframes, detached WebContents, remote/phone/Go/MCP callers. Recheck
trust on preview, commit and result lookup; nonce storage never substitutes
for sender validation or current group authority. This reuses the strict issuer
pattern in `plugin-mcp-handlers.ts`, not a grant to plugins. Ledger IDs and
baseline are main-owned; serialized renderer input is an expected-state token,
not authority. This is an app-mediated local-human control, not proof against
arbitrary code execution in the trusted app renderer.

### Separately owned Go adoption

[Clubhouse-Go #626](https://github.com/Agent-Clubhouse/Clubhouse-Go/issues/626)
tracks Go adoption, not the canonical Q5 issue. That owner requires advertised
host capability and redacted, versioned fixtures before presenting Q5 status or
retry/recovery controls. Proposed contract capability is a versioned
`groupNoticeLedger: 1` only after this implementation exists; this design does
not advertise it. Absent/older capability disables unavailable controls without
fallback calls, route probing or inferred support. An uncertain reply remains
uncertain, cancellation before confirmation sends nothing, and recovery preserves
chat by default. Go currently has no controller route; its clear/forget actions
using expectedState must not be borrowed as Q5 recovery. This first Q5 scope
adds local desktop IPC only; no Go implementation or new remote controller route.
Fixtures must contain synthetic IDs and reason codes, not notice bodies, live
recipient identities or raw provider errors. Parent coordinates the fixture
boundary with that owner; no direct/new access is implied.

## Revocation and wake boundary

Perform asynchronous membership/board/storage admission before handoff. After
awaited work finishes, the runtime invokes a **synchronous**, narrowly typed
owner pre-entry hook on main immediately before `session.send`, with no await
between hook and entry. The hook checks only main-owned cached generation,
permission/roster revision and exact attempt-admission tokens; it does no IO,
does not call a driver and cannot schedule work. Async admission must refuse
if a current revision could not be established; it must not turn stale cache
into permission. Relevant membership/permission changes synchronously revoke
the cached token before any asynchronous maintenance. No Promise-returning
hooks: reject malformed return values. Session mismatch also refuses entry.
Use the same final fence on immediate and queued sends. Clear references to
owner hooks/closures on every terminal settlement/removal/discard, including
unknown; no retained owner references after settlement. Hooks stay inside the
main runtime and never reach drivers, disk or renderer. Revoke removes known-held items
by their exact message/attempt IDs. Removal failure is visible; do not log that
queued input is harmless. A member departure does not undo submitted input.
Late callbacks update only historical attempts, not a rejoined generation.
Turning notices off holds ready work and prevents new dispatch; on re-enable
skip uncertain IDs and recheck ordinary eligibility. No new pause switch.

Wrap the existing permitted direct-post wake mission in a saved ledger intent
too. Preserve its current sender/grant/session/wake-budget guards and authority.
Run wake-budget availability, required last-session and permission/membership
prechecks **before** intent creation: a refused precheck makes zero intents and
zero handoffs. Consume existing budget reservation and recheck admission in
the existing guarded wake flow; a race refusing before entry is unsubmitted,
not uncertain solely because a precheck once passed. No budget refund on a
possibly submitted/uncertain wake. Do not change wake grants or resume policy.
Do not send the same notice again after wake merely because the lifecycle
returns false. Current wake Boolean is insufficient for accepted-vs-unknown
proof; without a verifiable handoff receipt leave that attempt uncertain.
If adding narrow receipt propagation to the existing wake path is necessary,
review that hunk before editing; do not advertise provider confirmation from
spawn success. No new automatic wake or resume behavior is introduced.

Confirmed group deletion/member departure retires the generation and cancels
known-held work. Keep compact outcome tombstones for callback fencing rather
than recreating an empty live row. Temporary roster failure, unknown replica
state or sender/grant lookup failure never authorize deletion/rebaseline.

## Durability, migration, compatibility and rollback

Use a dedicated ledger writer, not the generic settings merge path and not an
extra field in the stripping legacy receipt validator. One app process owns
the file; serialize operations and revisions. Recheck file identity/revision
against the loaded version before replacement, refusing detected external
writer changes rather than overwriting them. This is not a multi-process CAS:
concurrent app writers sharing userData are unsupported and must be refused by
the existing single-instance boundary. Test the detection limits honestly.

Each per-recipient journal record is a length-delimited canonical JSON delta,
with schema/revision, previous-record digest and SHA256 payload digest. One
record holds a complete logical transaction (nonce consumption plus child
intent, or adoption plus new baseline). Append then file-sync before publishing
to cache or handing off. Split discovery scans/bursts into committed bounded
deltas before dispatching corresponding batches; do not split a single retry
authorization across records. Exact post-ID page changes are transaction data,
not independently mutable authority. Journal replay applies each revision once.

On recovery, validate from the last committed checkpoint/digest anchor. A known
incomplete **last** record from a crashed append is preserved in a diagnostic
copy and ignored after its last verified boundary: no handoff was authorized
by an uncommitted tail. Prior durable intents recover uncertain. A checksum
failure in a complete record, non-tail damage, revision conflict, missing
referenced page or unknown version refuses that recipient's writes/handoffs
without replacing data. Healthy recipient shards continue. Never invent a
verified prefix when the anchor or framing is itself corrupt.

Checkpoint by writing bounded immutable pages with hashes, syncing them and
their directory, then atomically replace a small manifest naming the checkpoint
generation, page index root, last included revision/hash and remaining journal
range. Flush manifest and directory before publication/old-segment retirement.
The old manifest stays authoritative before that commit; orphan new pages are
not a new baseline or replay instruction. After commit the new manifest wins;
duplicate older records are ignored by revision/hash, not applied again. Page
index is paged too, not an unbounded manifest array. Unresolved archive pages
are never retired merely for age/space. Temp write/atomic replacement follows
the existing utility's file-flush pattern without changing shared settings.

On platforms without a proven directory flush, document the power-loss
limit; deterministic process-crash tests prove process recovery, not hardware
durability. A failed/ambiguous commit blocks further handoffs from that store
until reread/reconciliation succeeds. Do not continue from mutated cached data.
No defaults/rebaseline when a ledger exists but is malformed, missing after
load, unknown-version, unreadable or fails persistence. Preserve bytes and
report an operational failure; do not quarantine then overwrite with empty.

First upgrade reads legacy receipts without its mutating corruption-recovery
loader. Validate and preserve old cursor as a baseline, not proof of historical
delivery; retain existing wake/urgent budgets in their existing file. Commit
the complete initial ledger before using it. A genuinely absent legacy cursor
may initialize a new member at the current authoritative sequence as before.
Unreadable/corrupt legacy data needs explicit recovery rather than new silent
baseline. Existing ledger always wins over an old cursor; never import it again
after migration or allow a newer old-writer scalar to erase unresolved holes.
Normal legacy budget writes neither edit nor delete the separate ledger.

### R1: baseline pages before one small activation record

An initial or adoption post-ID baseline may exceed64 KiB. Build its immutable
hash-partitioned index pages first (maximum256 KiB each); for a large page list,
build bounded immutable index nodes too. File-sync every page/node and sync the
directory before activation. Until activation they are **inert orphans**, not
current coverage and not proof of a consumed nonce. The complete baseline is
identified by a bounded root reference with its digest and aggregate count,
not by embedding thousands of IDs or an unbounded page list in the delta.

Then append and sync exactly one small activation transaction (at most64 KiB)
containing that root reference/digest, expected old revision/generation,
fresh-generation creation and nonce consumption (when adoption requires it).
Only its verified committed revision exposes the new generation. A failed or
crashed build/before-record boundary leaves the prior generation and prepared
nonce unchanged; no partial baseline is visible and orphan pages cause no send.
A crash after committed activation recovers the entire referenced baseline and
consumed nonce once, with no historical replay or second adoption. A missing or
corrupt referenced page after activation refuses that shard rather than
falling back to an empty baseline. Orphan cleanup is separate bounded maintenance
after proving non-reference, never an activation or implicit reset operation.

Required control: an actual baseline encoded larger than64 KiB, with process
crash/failure cuts during page writes, after all page syncs/before activation,
and after the record sync. Assert no partial generation, no early nonce
consumption, inert orphans, complete after-record recovery, no replay and
double-submit returning the same consumed result. Sequence-only initialization
has a scalar baseline and is unaffected; post-ID/adoption implementation waits
for narrow independent R1 confirmation.

Local post IDs such as `msg_<timestamp>_<random>` can reveal posting time even
without message content. Keep them in local userData only; never export them
to logs/telemetry/Go fixtures. Status should show local retained-byte size and
the explicit unbounded-OIDs storage consideration for long-lived older boards.
For sequenced generations only, optionally advance legacy `notified` through
the contiguous accepted-or-excluded floor, never past the earliest unresolved
or ready gap, and only after that ledger commit. Exclusions retain the old
subscription semantics; they are not labelled provider-confirmed. Ledger is
authoritative if the secondary export fails. No cursor export is possible from
post-ID mode without inventing host order. This bounds some accidental downgrade
replay but does not make an older active writer supported.

Persist an independent migration marker `group-project-notice-ledger.required`
with supported version and installation UUID before first ledger activation;
the envelope must match that UUID. Sync marker and directory before any
handoff. A crash after marker/before initial ledger is an explicit incomplete
migration, not permission to auto-rebaseline. A marker without ledger on a later
process launch reports missing storage and refuses new handoffs. Ledger without
marker is likewise inspected, not overwritten. Both artifacts are part of
backup/restore and downgrade documentation. This detects isolated ledger loss
across process restart; simultaneous external removal of marker and ledger
cannot be distinguished from a genuinely fresh installation and is outside
the guarantee. Tests must not imply otherwise.

**Older binaries are not ledger-aware.** A sidecar does not make their delivery
writer fail closed. Do not mirror a scan frontier or uncertain coverage into
their `notified` cursor and call it successful notification. Supported ordinary
rollback is to a ledger-aware build preserving schema 1. To run an older binary,
the operator must first use its existing group notification permission controls
to disable notifications for affected groups while a ledger-aware build is
still running, drain/remove known-held work, preserve original ledger and legacy
files, and keep notifications disabled until returning to a compatible build.
This is an explicit maintenance procedure, not automatic member pause on
uncertainty; the implementation does not perform it or change live permissions.
An old binary run with notifications enabled can duplicate/skip deliveries and
is unsupported. Never claim tests can retrofit enforcement into that binary.
Cross-version same-userData concurrent writers are unsupported as well.

After restore, validate ledger and generation identities, turn recovered intent
or queued attempts uncertain, retain explicit retry-consumption state, restore
rate windows, and reconcile only known-unsubmitted/ready rows. No recovery path
clears chats, resets sessions, resolves uncertainty or spawns new tasks.

## Required deterministic proof and review gates

Contract approval and hunk coordination precede product implementation. Then
use focused fake-runtime/driver tests plus real temporary-directory persistence;
no paid/provider/live delivery or installed-app restart experiments.

| Proof | Required discriminator |
| --- | --- |
| Continued notices | A uncertain, B accepted; reload: A remains uncertain, B is not resent, C still delivers. Scan and confirmed frontiers are distinguishable. |
| Both owner paths | Busy and apparent idle returning queued; callback before return, after return and duplicate/conflicting callback. Queued result never immediately ACKs. |
| Idempotency/coalescing | Duplicate post/overlapping reconnect scan, same key/different coverage refusal, replacement removal racing dispatch; no repeated uncertain coverage in fresh notice. |
| Failure windows | Inject failure before intent save (zero sends), after save/before call (uncertain), after provider entry/before ACK (uncertain), ACK/before outcome save (uncertain), after outcome save (confirmed); raw disk reload for every window. |
| Actual process recovery | Child-process fixture exits at persisted barriers, new process opens same temp directory and recovers exact state. A module reset alone is not process restart proof. No laptop app restart. |
| Retry/adoption trust | Main-minted persisted nonce, main-window/frame/URL refusal matrix, warning, cancel-no-send, double click, expiry, stale revision, crash after consumption, uncertain reply lookup, sleeping/unavailable-post refusal. Adoption keeps retired uncertainty and fresh explicit baseline; no actual re-pair or automatic adoption. |
| Revocation | Membership/deliver-off before intent, during awaited admission, in queue and after send entry; removal failure and late callback fenced from rejoin/new session. No post-entry cancellation claim. |
| Wake | Budget/session/permission precheck refusal creates no intent or send; possible-handoff false remains uncertain, sender/permission/budget checks retained, no duplicate post-wake send. |
| Compatibility | Legacy import without replay, invalid legacy refusal, independent old-budget write, unknown versions/fields, external revision change, corrupt/missing ledger; raw originals preserved. Demonstrate old binary limit, not invented compatibility. |
| Capacity and compaction | One early uncertain hole plus1M terminal posts compresses to sparse hole+interval; cross256-hole hot limit with later delivery/reload/old-hole lookup; archive/page/journal crash cuts; real byte-bound latency observations, no count-cap stop or TTL pruning. |
| Mixed board versions | Sequenced and post-ID groups side by side; fresh post-ID events continue, initial snapshot not replayed, duplicate IDs suppressed, no timestamp ordering, later subscriptions do not revive exclusions; explicit post-ID→sequenced adoption. |
| Other callback owner | Actions unknown is explicit unconfirmed failure; delivered/expired/replaced/dropped unchanged where truthful, exhaustive future-variant check. |
| Non-goals | Existing grants/wake/default behavior and phone/Annex schemas remain unchanged except reviewed local IPC additions; no controller/settings-save/chat-clear edits. |

Follow desktop-test-gate actual parser contract (`<lane> <minGB> -- <argv...>`),
min4 tests/lint, min6 compiler, maxWorkers2 total, refusal75 and at least60s
between retries. No slot reservation, bypass or installs. Seal exact clean
head/tree/source hashes before and after commands, argv/exit/raw output;
preserve refusals/failures and scope limits. No historical counts transfer.
Independent exact source/evidence review precedes PR, then hosted checks. Public
release remains held. This contract has had source inspection only; none of its
new guarantees has yet been implemented or tested.
