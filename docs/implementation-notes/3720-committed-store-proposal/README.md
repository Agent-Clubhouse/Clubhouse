# Complete opt-in Annex store proposal — review only

This is an **unapplied source proposal**, bound to main
`f19eceee25effd264276d70a419bebfe58924876` after #3767. It implements no product
behavior in this checkout. It supersedes callback-only store sketches for review,
not the frozen contracts or their historical evidence. Contract basis:
`38cbdaa9fff26aa28630ad14b5db9c13359d39f1` successor-r3, with the B1/L1/C1–C3
corrections and N1–N4 carried below. Preserve afefa/r1/r2/r3 and all helper freezes.

The complete proposed bodies are:

* `annex-committed-store.review.ts.txt` → new
  `src/main/services/annex-committed-store.ts`: explicit field plans, private actual
  primary base, immutable public tuple, commit ownership, degraded reads, emergency
  strict reread and controlled recovery.
* `recovery-tickets.review.ts.txt` → new
  `src/main/services/annex-settings-recovery.ts`: bounded entry ticket consumption,
  duplicate/status lookup and completed-result retention.
* `settings-store.review.patch` → `src/main/services/settings-store.ts`:
  complete concrete IO adapter and an opt-in overload. The full resulting source
  is also in `settings-store.proposed.ts.txt`; it must equal applying the patch.

All referenced **store-side** methods and IO bodies are present. This is not a
replacement of all r3 scaffolding or an acceptance of its missing consumers.

## Exact reservations requested

The two new modules above and the following settings-store regions need independent
shared-store/Annex review before application:

1. Two additive imports; extract the existing inline options type without changing
   its existing fields; add one specialized overload selected by
   `{ committedAnnex: true }` and restricted to `annex-settings.json`.
2. Immediately after the existing `pendingWrite`/`updateLock` declarations, add the
   specialized facet/adapter and its reset callback. It uses that **same existing
   `pendingWrite`**. It neither calls generic save/update nor adds a queue.
3. One conditional source capture at the start of `notifyLoad`. Ordinary stores do
   not retain it. Existing startup load/recovery behavior remains the startup port.

No reservation is requested in replaceFile, renameOver, bounded read helpers,
agent/group-project direct callers, shutdown/update/devrestart/launch-gate,
annex-client, handlers, tools, renderer, preload, network protocol, mobile or
Settings runtime consumers. No facade opts in yet. The original 46 factory
callsites and five other direct replaceFile importers are inventory from
`26551597085c2f4b6b9eaa014b651211e093b317`, not compatibility proof.

Default `get`/`save`/`update`, synchronous accepted-save displaySnapshot timing,
rollback only when `cachedSettings === attempted`, updateLock, audit, migration,
temporary naming/sweep/mode, retries/preconditions and recovery copies retain their
existing bodies. The opted return type has **no full-body get/save/update fallback**.
It must not be enabled until every actual Annex writer is migrated and reviewed.
Extracting the options type adds no persisted/wire/mobile fields.

## Commit turn and publication

Entry detaches a local patch by invoking the already shipped strict parser.
Original authority belongs to the supplied entry-captured Admission, never origin,
request ID, revision, witness, hash or timestamp. Its precondition must be bounded,
idempotent and non-mutating. It preserves existing grant checks and the original
main WebContents/frame/document incarnation, original installed tool host, launch
and emergency admission. Those actual capture bodies remain consumer work.

Each operation captures the current in-memory settings epoch and fixed admitted
path. Inside **one actual pendingWrite turn**, it rechecks admission, reads the
private confirmed base, checks epoch before versions, rejects the whole patch on
any touched-field conflict and rebases untouched fields. Same-value LOCAL writes
and explicit unset of an already absent optional field still advance the touched
version. No-op MCP loopback must retain its existing early read-only return, with
no Ask/write/version, in its future consumer.

Candidates, serialization, public values, versions, display provenance and owned
receipt data are staged before primary IO. A normal healthy successful commit
publishes a single immutable values/epoch/revision/fields tuple in the store turn
after definitive `await replaceFile`, before audit/caller resolution. Readers
during IO may see the previous complete tuple. No caller observer/publisher is
registered; no callback, IO, await or emit occurs in tuple publication. The extra
display/ownership assignments are synchronous and are not independently exposed as
versioned DTOs. A fault there marks the entire versioned surface degraded.

The publisher is **outside** filesystem retry/temp cleanup and generic optimistic
cache rollback. A thrown EPERM after confirmed primary cannot trigger another
rename or report refused. Postcommit authority loss is committed_unconfirmed and
confers no runtime/name/ACK authority. WeakMap receipts bind the exact committed
loopback field version and its private prior presence/value; restoration cannot
overwrite a newer loopback writer, including ABA. Unrelated field writes rebase.
Only a receipt from the accepted local intent write can retire that exact witness.
Non-name writes preserve it; disable/purge clear it.

This is **process-level** publication using the existing file fsync + rename.
There is no new directory fsync or power-loss/directory durability guarantee.
replaceFile/renameOver/direct caller semantics are untouched. A non-guard IO
failure is conservatively UNKNOWN, even if the filesystem may have committed it.
Only an error tagged by this operation's pre-rename guard is definitely refused.
Errors raised after a definitive primary are committed_unconfirmed, never rollback.

## Degraded actual base and emergency persistence (B1, N2)

Known post-primary publication failure retains the actual new base privately.
`read` returns degraded with no valid epoch/versions, ordinary patches refuse, and
peekLoaded reports unreadable provenance with detached saved display labels.
Neither GET nor display initializes, heals, rereads or emits. The private witness
and unknown future metadata are excluded from opted display provenance too.

Emergency live-off remains the consumer's synchronous effect **before any await**;
this proposal neither implements nor claims that effect. Disable persists server
and client off. Server purge preserves actual Alias/deviceName, resets icon/color/
autoReconnect, removes optional preferences and clears only the private witness.
Both compose the actual confirmed base, never an optimistic Alias or old public
tuple. A degraded emergency success remains committed_unconfirmed; it does not
reactivate an invalid versioned surface. Version history across an UNKNOWN primary
is not reconstructed. Only explicit validated recovery starts a fresh epoch.

If the actual primary/base is UNKNOWN, the strict bounded reader runs FIRST in
the **same pendingWrite turn** as the emergency mutation. It uses the existing
fixed-path bounded reader (file identity/size/time checks, fatal UTF-8, JSON object)
then the full Annex and private-witness decoder. Missing/unreadable/invalid data
means read_failed and **no primary write**. There is no default, candidate, old
tuple, migration write or legacy-loader fallback. Valid reread establishes a known
private base (N2); repeated emergency writes may then use that known base. It does
not heal the public tuple, rotate its epoch, activate a name or enable runtime.
A subsequent uncertain replace makes the base UNKNOWN again.

Entered OS IO is not cancellation. Reset rotates settings admission immediately,
but preserves pendingWrite until IO settles. Explicit initialization queues behind
it, so an old completion cannot publish into a replacement store or let a new load
race the old rename. A fixed admission deadline can refuse checks; it cannot free
the disk chain while an old fsync is still running. No emergency persistence bypass
of stuck filesystem IO is promised; live-off must remain independent.

## Strict schema and proposed witness concretization

Controlled reread requires all seven required Annex fields with their current
boolean/string types; optional fields retain exact presence. It accepts the
existing boolean `enabled` migration in memory. It **does not** merge missing
required fields with defaults during recovery. Normal first startup alone retains
existing default merge/missing-file behavior. Unknown JSON keys stay private and
are preserved through mutations. Unchanged legacy strings keep their exact UTF-16
and length; only new local changes use the shipped parser's limits. Optional unset
does not accidentally reinsert a default.

The r1 witness format was a sketch. This proposal makes its schema concrete for
review: `memberNameIntentCommit = { id, epoch }`, exact two keys; id is the 64
lowercase-hex pending name record ID; epoch is the canonical JSON string
`[lowercasePinnedFingerprint, joinedAtMillis, pairingIdOrNull]` (max 256 UTF-16
units), with the primitive epoch bounds. This structural check is **not** record-ID
verification, authorship or authorization. The future name-store consumer must
verify the pending record and current target epoch/active membership and bind the
still-valid original accepted intent. Equal committed preference text never does
that. This exact schema is a **new review proposal**, not inherited approval.

## Recovery idempotence (L1, N1, N3, N4)

Fault transition creates one degradation scope and a main-issued ready ticket.
Pure status/GET reads reveal the existing ticket without allocating or reading
disk. Recovery requests are exact own-data `{v:1, mode, degradationId, requestId}`;
no renderer ordinal is accepted. Bad version is schema_invalid. The real captured
authority is checked before parsing/duplicate lookup and the healthy shortcut.

`execute` can consume only the current ready ticket. Main consumes it and allocates
its internal ordinal synchronously before queueing/awaiting. Exactly one global
reload may be in flight. Known duplicate execution joins that operation; known
status reads never execute. There are globally 32 oldest-first completed records,
never eviction of in-flight work or an unbounded ID map. Unknown/evicted ID gives
not_retained, never a new execution. Failure issues a different ready ticket for a
**fresh human retry** and includes it in result/status; no auto-submit (N1).
More than 32 failures must still permit a success. The ordinal overflow transition
rotates only ticket bookkeeping before exhaustion, not settings publication.

Successful reload strictly reads/validates in the same disk chain and rechecks
original admission before publication. It atomically establishes a new settings
scope, coherent base/tuple and zero field counters, with no runtime apply, name
activation, migration write or adoption by equality. It ends the degradation scope.
Recent duplicates retain their historical outcome but contain **no adoptable old
snapshot**. A later fault has a fresh scope; old IDs cannot execute in it. Reset
invalidates ticket generation without releasing entered IO. Restart does not
reconstruct ephemeral results or old request identities.

The public submit/recovery paths return typed ordinary failures (N3). Consumer
post-await setters/load/save/error/status handling still needs C1 ownership gating,
including suppressing a reply after cache eviction or a newer renderer action.
Opaque epochs are not ordered strings. A reloaded healthy tuple is a local state
mutation, not a wholly read-only action, although disk recovery itself is read-only.

## Work deliberately not implemented by this proposal

No hidden store-side helper is a stub. The following **consumer implementations**
are absent and remain independent review gates:

* Main-window/frame/document incarnation capture and post-await checks; real tool
  host/Ask/grant capture; launch/emergency entry receipts and synchronous live-off.
* The Annex facade opt-in and complete migration of all five actual primary writers:
  MCP loopback forward/restore, LOCAL SAVE, emergency disable and server purge.
* Strict LOCAL IPC envelope/withValidatedArgs/settings-audit attribution, cloned
  patch capture, committed GET values+versions+epoch and typed error/result plumbing.
* Renderer pending-draft/load/reply generations; all explicit-key producers
  (Identity Alias/Color/Icon, NetworkSettings, palette server/client toggles),
  degraded owner status and disabled Rename/Use-this-Alias with typed refusal.
* Bounded name intent reservation, atomic witness ownership, durable name store,
  pin/member/target-epoch rechecks, negotiated transport and no-IO label resolver.
* Runtime apply on actual committed before/after and owned secure-listener receipt;
  all RS1–5 effects/status/catch/STOP admission fences, including independent
  client-off/control effects after TLS bind failure and offline Alias behavior.

Store enqueue, handler settingsWrites, MCP invocation queue and runtime effects are
**distinct boundaries**. The earlier real-store sequential RL1 helper test is not
their composition proof. No OS teardown, app/live, mixed-version transport, grant,
name-convergence or #3720 feature acceptance is claimed here.

## Checks and evidence limits

`check-proposal.py` materializes the three proposed files into a task-local symlink
mirror and typechecks that mirror against the existing matched dependency cache.
It never patches product source or installs dependencies. This checks typed source
composition, including existing default-store callers, **not** executed store
behavior or compatibility under failure. Exact run records identify whether the
proposal was tracked/frozen; original failures are retained, not relabeled green.

The initial check failed for three missing callback return annotations and the
mirror's missing relative node_modules path used by an existing Azure import.
The latter was a mirror layout issue, not a production source defect. A later
corrected run passed. The final frozen-source record, source-equality/patch checks,
dependency admission and manifest are packaged separately. Direct parser fixtures
do not establish Electron reachability. No runtime tests or mutation kills are
credited by this docs-only artifact.

`proof-obligations.json` enumerates the exact future red/green and mutation controls
required before applying/landing this shared piece. Independent source/security/
shared-store review must decide the new facet/witness choices and full bodies.
