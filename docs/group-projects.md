# Group Projects

## Creation scope

New records persist a validated `scope`: project or app, and local or network.
`create(name, options?)` accepts an optional registered `projectId` as the default
context and an optional explicit `scope`. Without either, the default is
app/local. A project context defaults to that project/local. An explicit scope
takes precedence, including app scope from inside a project; contradictory
project IDs and unregistered IDs are refused before creating a record.

Canvas creation forwards its project context (including an explicitly associated
project on an app canvas); an app canvas without one uses app/local. A project
canvas missing its context refuses creation rather than silently using app scope.
The MCP create tool derives the registered project from its caller's project
path and refuses an unregistered caller path.

Network reach is refused, with its reason, until network group projects are
available (#3363): "Network reach needs Annex Network" when Annex Network is off,
otherwise "not available in this version yet". `groupProjectHost.scopeOptions()`
(IPC `group-project:scope-options`) gives the same answer to the UI, which shows
Network disabled with that reason. No local group is presented as a network
group. `get_project_info` includes scope; legacy records without one return
`scope: null` unless membership-aware migration can verify the complete
membership inventory. Creation does not infer migration scope from an incomplete
startup binding cache or change existing members or subscriptions.

## Scope and members (#3355)

| | This computer | Network |
|---|---|---|
| Project | Agents in this project on this computer | Agents in this project and in projects linked to it on other computers |
| App | Agents in every project on this computer | Agents in every project on every computer in the network |

`memberInScope` in `src/shared/group-project-scope.ts` applies the table to a
member's host-relative address (one with a machine is on another computer) and
its project. A member whose project isn't known is neither in nor out: it is
never counted as leaving, and it is admitted.

An agent outside a group project's scope is not a member. When a wire binds one,
lifecycle releases the binding and posts no join (`groupProjectHost.admits`),
including a wire restored at startup.

Changing scope is a person's action in Settings > Group Projects (agents get it
with the admin grant in #3360). `previewScope(id, scope)` lists the members who
would leave and changes nothing. `setScope(id, scope, { confirmLeaving })` applies
only when `confirmLeaving` names exactly those members, so what the person
reviewed is what happens. Otherwise it refuses with `changed`. Widening needs
no confirmation. Members who leave lose their live bindings and explicit
membership entries. The change takes a sequence number like any other.

Until #3357 registers its membership policy, "members" are the agents wired to
the group project, with their projects read from durable agent configs and live
registrations.

## Legacy scope inference

Initial registry loading inventories registered projects, durable agents, saved
connections, every app/project Canvas store, and live bindings/registrations.
It reuses the existing wire and connection eligibility rules, including saved
grant-authorized foreign endpoints, without creating memberships or changing
subscriptions. Unknown live-agent directory identities defer inference rather
than being ignored. A single known member project implies
project/local; mixed or verified empty membership implies app/local.

Strict read-only source readers refuse unknown or malformed rows, ambiguous
identities and corrupt/unreadable primary files rather than treating filtered
rows, caches or recovered backups as a complete inventory. Ordinary readers
retain their existing recovery behavior. Backup-only or recovery-only data is
untrusted; only verified absence of primary and recovery copies is empty.

Inference persists atomically before publication, retaining an internal
`_scopeInference: "legacy-v1"` provenance marker on every later registry write.
The marker is not part of the public Group Project object. On every fresh load,
marked scopes are untrusted until a complete inventory reproduces the recorded
candidate and passes drift checks. A different candidate is never silently
adopted. Unrelated edits retain the recorded candidate even while its public
scope is unresolved. Explicit scopes from new creation remain authoritative and are not
re-inferred.

Immutable inventory signatures are rechecked before and after persistence.
Detected drift restores the previous registry before publication; restoration
failure explicitly rejects loading. The retained provenance also protects a
restart after a crash between rename and verification. This is cooperative
validation, not a transaction spanning independent source files or protection
against external filesystem tampering.

Unavailable, unknown or changed inventory leaves scope unresolved
(`get_project_info` returns `scope: null`) with a logged retryable diagnostic.
Repairing the source permits another attempt on the next app startup. There is
no polling loop, automatic read retry or live membership expansion.

## Local persistence

The app-wide registry is `group-projects/registry.json`. Each group project has
`group-projects/<id>/bulletin.json`. These live under `.clubhouse` in the user's
home directory (`.clubhouse-dev` in development). Their existing JSON formats
retain existing data; new registry records add the optional scope field.

The registry and bulletin services serialize pending writes and use the same
atomic replacement helper as the settings store: write a neighboring temporary
file, flush its contents, then rename it over the previous file. Failed writes
leave the previous file readable and the in-memory changes available for retry.
An explicit `flush()` rejects on failure; deferred flush failures are logged.
Shutdown flushes drain mutations that arrived while an earlier write was pending.
The all-board flush awaits every board before reporting failures, so one failed
board does not bypass other pending board writes. The existing shutdown timeout
still applies.

Only a missing file initializes an empty store. An unreadable or corrupt store
refuses reads and mutations rather than overwriting history with an empty
fallback. Repairing the file permits a later load to retry.
Protection changes made before the first board read are applied after loading
the saved history, rather than replacing that history or ignoring the change.

Protected bulletin topics are exempt from both retention limits. The global
budget and trim preview count only unprotected messages. Posting retains the
just-posted message even if older history has timestamps ahead of the clock.

## File map

- `src/shared/group-project-types.ts`: registry and bulletin types.
- `src/main/services/group-project-host.ts`: the one writer; serialization, sequence numbers, membership, tombstones.
- `src/main/services/group-project-membership.ts`: membership policy and its binding source (#3357).
- `src/renderer/features/group-projects/GroupProjectMembersSection.tsx`: members, exclusions and the auto-join offer, for the directory.
- `src/main/services/group-project-host.test.ts`: real-file ordering, restart, crash and address regressions.
- `src/main/services/group-project-host.guard.test.ts`: fails any write outside the host.
- `src/main/services/group-project-membership-file.ts`, `group-project-json-file.ts`, `group-project-paths.ts`: host-only stores.
- `src/shared/group-project-members.ts`: host-relative member addresses.
- `src/main/services/group-project-registry.ts`: registry loading, CRUD and flush.
- `src/main/services/group-project-scope-migration.ts`: checked legacy inventory.
- `src/main/services/group-project-scope-migration.test.ts`: real-file inference,
  drift, crash-provenance and publication-barrier regressions.
- `src/main/services/group-project-bulletin.ts`: board loading, retention and flush.
- `src/main/services/settings-store.ts`: shared atomic replacement helper.
- `src/main/services/group-project-storage.test.ts`: real-file crash/failure,
  concurrent-load and in-flight mutation regressions.

Scope management, directory management and network synchronization are
separate additions. These foundations do not change canvas membership, grants
or polling.

## Authoritative host and store (#3356)

Each group project has one host machine that holds the truth about it. The
record's `host.machine` is that machine's Annex identity fingerprint (lowercase),
set at creation and fixed in v1. It is `null` when the creating machine had no
lasting Annex identity (Annex never turned on, or an ephemeral profile); null
means "the machine whose registry holds this record". Legacy records without
a host load as `{ machine: null }`, so their host is this machine.

`src/main/services/group-project-host.ts` (`groupProjectHost`) is the only
writer. Record changes, membership, board posts and removals, topic protection,
retention, channel and inbox seeding, flushes and deletion all go through it.
`group-project-host.guard.test.ts` scans main-process source and fails on any
registry or board mutation, store module import, or file write under
`group-projects/` outside the host and its stores. Reads may still use the
registry and board directly. Remote writes over Annex (#3363) will enter
through the same methods.

Writes to one group project are serialized. Each change gets the next sequence
number for that group project. The number is saved atomically in
`group-projects/<id>/host.json` (`{ "version": 1, "seq": n }`) before the change
is made, so it keeps increasing across restarts and a crash can only leave a gap,
never a repeat. A change that changes nothing (protecting an already protected
topic, deleting a missing message, an identical membership) takes no number.
Board messages record the number they were posted at (`seq`); older messages
have none. Records report their latest number as `seq` (0 before the first
change). `groupProjectHost.onChange` announces `{ groupProjectId, seq, part }`
after each change, where part is `record`, `membership`, `board` or `deleted`.
A corrupt `host.json` refuses writes rather than restarting at zero.

`exclusive(id, fn)` holds a group project's writes while `fn` runs.
`delete(id, { expectedSeq })` refuses with code `changed` when anything changed
since that number, so a confirmed impact still matches what is deleted.

### Members by address

`group-projects/<id>/membership.json` holds the membership record that #3357's
policy maintains: `{ version: 1, autoJoin, explicit: [...], excluded: [...] }`,
keyed by address. A missing file reads as empty. Unknown fields are kept.
Addresses are host-relative machine-qualified agent addresses (#3063): an
agent on the host machine is its bare id, and one on another machine is
`<id>@<fingerprint>`. This machine's own qualified address is stored in its
bare form. The same address twice is refused. Names are display only, so two
agents with the same name stay distinct. `memberAddress` and `sameMember` are in
`src/shared/group-project-members.ts`.

Inbox channels record the address that owns them (`inboxOwners` in
`bulletin.json`). A member joining with the same name as an existing inbox's
owner gets `inbox-<name>-<6 hex>`, derived from its address, rather than sharing
the first member's inbox (#1646). Polling instructions and shoulder-tap reply
hints name the member's own inbox. Inboxes from before this change have no
owner, and the next member with that name to join claims them.

### Ids and deletion

New ids add 48 random bits to the creation time (`gp_<ms>_<12 hex>`,
`msg_<ms>_<12 hex>`), so ids made on different machines don't collide. Existing
ids are unchanged.

Deleting has two steps, so a cascade (#3364) can clean up around it and
recover after a crash. `beginDelete(id, { expectedSeq })` saves a tombstone in
`group-projects/tombstones.json` (`{ groupProjectId, host, seq, deletedAt,
state: "deleting" }`), hides the group project from every reader (the registry
reads tombstones when it loads, so this holds after a crash too), refuses
further writes and announces `deleted`. `finishDelete(id)` marks the tombstone
`deleted`, then removes the record, board, membership and `host.json`. It is safe
to repeat. `listPendingDeletes()` and `exclusivePending(id, fn)` let the cascade
resume a `deleting` tombstone after restart. `delete(id)` does both steps in
one call.

On start, the host never finishes a `deleting` tombstone, since its cascade owns
that. For a `deleted` tombstone it removes any record or data a crash or failed
removal left behind. A removal that still fails is logged and retried at the
next start. Tombstones are kept 90 days and at most 1,000, but a `deleting` one,
or one whose data remains, is never pruned. A deleted id is never reused. Other
machines use tombstones to drop their cached copies (#3363).

### Durability

Registry and board files keep their existing atomic writes (below). `host.json`,
`membership.json` and `tombstones.json` use the same temp file, flush and
rename, so a crash mid-write leaves the previous file readable.

## Membership (#3357)

Who is in a group project is a record on its host (`membership.json`, written
only through `groupProjectHost.updateMembership`), not canvas wires. Policy is
in `src/main/services/group-project-membership.ts`; MCP bindings are derived
from it by a pruning persisted-binding source, `group-project-membership`.

- **Auto-join.** With `autoJoin`, every top-level durable agent in scope (not a
  helper, not disposed) is a member, existing and future. One that leaves
  scope (deleted, moved, its project removed) leaves. A new group project
  auto-joins: the create paths call `beginAutoJoin`.
- **Exclusions.** Excluding a durable agent records it in `excluded`, so
  auto-join never brings it back, across restarts. Adding it again removes the
  exclusion.
- **Helpers** join only when added (`explicit`, kind `helper`), and leave when
  disposed or deleted; the entry is dropped then.
- **Quick agents** join only when added, for one run (`runId`). The entry goes
  when the run ends, and doesn't survive a restart. A quick member's display
  name carries a suffix from its id, so two runs that drew the same name get
  separate inboxes and sender labels (#1646). Their posts stay.
- **Migration.** A group project from before the record keeps exactly the
  members its bindings had at the first start with this build (`explicit`,
  `autoJoin: false`) and gets `autoJoinOffer: 'pending'`. The directory's
  members section shows who would join; accepting turns `autoJoin` on,
  dismissing keeps the current members.
- **Tool switches (#2084).** A member's disabled group-project tools are kept
  in the record (`disabledTools`, by address), so "Apply to all" and the wire
  popover survive restarts. A member without its own list starts from the
  group project's `defaultDisabledTools`.

Restores are silent, as for every binding source. Changes after startup bind
and unbind through `claimSourceBinding`/`releaseSourceBinding`, so a new
member's join is posted on the board. Canvas cleanup (closing a card or a
canvas) keeps a member's binding, since the record holds it.

**Canvas gestures.** Drawing a wire to a managed group project adds the member
(or removes its exclusion). Deleting the wire excludes the agent, or drops a
helper or quick agent. A stored wire the canvas binds again on load
(`MCP_BIND_RESTORE`) never adds a member. The canvas wire source no longer
lists group-project wires for a managed group project.

**Orchestrator tools.** `create_group_project`, `add_to_group_project` and
`remove_from_group_project` change the record for a managed group project;
nothing about the membership goes in the orchestrator connection store. A
helper an orchestrator added stays a member if it is reparented or released,
until it is disposed or removed.

**Reading it.** `describeMembership` (IPC `GROUP_PROJECT.LIST_MEMBERS`) returns
members, exclusions and the offer; `MEMBERSHIP_CHANGED` is broadcast with the
group project id. The host's `resolveMembers` uses the same resolution. The
Connections card lists a membership as "Group project member". A deleted group
project's bindings are released when the host reports the delete.

## Local directory

Settings > Group Projects, also available as **Group Projects** in the command
palette, lists this machine's local registry, including records on no Canvas.
This is not an authoritative host, network or membership directory.

Select a record to edit its name, description and instructions through the same
store and IPC used by Canvas. Instructions retain their whitespace. Legacy or
missing scope is shown as unresolved, not inferred, until someone sets one.
Failed loads hide the inventory and offer a retry. Failed writes retain the
current draft and report that it was not saved.

Creation here defaults to the whole app on this computer, and the person can
choose a project instead. Selecting a record also shows its scope with Review
change and Apply. Network reach is shown disabled with its reason. Host state,
durable membership management, grants, owned Actions, deletion, board viewing
and Canvas navigation are outside this directory slice.
