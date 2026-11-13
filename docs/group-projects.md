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

Network reach needs Annex Network on and this computer in a network (an Annex
identity). Otherwise it is refused with the reason: "Network reach needs Annex
Network…" or "…Add a device in Settings > Annex Network first."
`groupProjectHost.scopeOptions()` (IPC `group-project:scope-options`) gives the
same answer to the UI, which shows Network disabled with that reason. `get_project_info` includes scope; legacy records without one return
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
its project. A member whose project isn't known (an unreadable or unregistered
project) is neither in nor out.

**Joining is checked where a binding is made.** The MCP bind handler asks
`groupProjectHost.admits(id, agentId, { restore })` before anything is bound,
recorded as a member or made admin:

- A restore of a stored wire is admitted unless the address is excluded, so a
  check never evicts a current member.
- A drawn wire is a person's choice. An explicit member is admitted. Otherwise
  the agent must be within the scope, failing closed on an unknown project or
  any error. Within scope, drawing lifts an exclusion the person made earlier by
  deleting the wire (#3357). A scope refusal stays until the scope covers the
  agent.

A refusal answers `{ notMember: true, reason: 'out_of_scope' }`, which the
canvas treats as final and stops retrying. A refused draw is also recorded as
excluded (`reason: "scope"`), so the canvas restoring that wire later is
refused too. At startup the canvas wire and orchestrator connection sources
don't restore a group project binding whose agent is excluded (`withinScope` in
`managed-group-projects.ts`). Card inspection stays read-only and shows stored
wires as they are. The bind decision is `bindToGroupProject` in
`group-project-bind.ts`, called by the MCP bind handler.

**Explicit adds are checked too.** `addMember` (the person's Add in the
directory, and agents' `add_to_group_project` / `join_group_project`) refuses an
agent outside the scope, failing closed when its project isn't known. It answers
"…is outside the scope of "<name>", so it can't join. Widen the scope in Settings
> Group Projects first." So an explicit add can't put in an outsider or undo a
narrowing. For a group project still on wire membership, the connection tools
apply the same check before connecting.

Changing scope is a person's action in Settings > Group Projects (agents get it
with the admin grant in #3360). `previewScope(id, scope)` lists the members who
would leave and changes nothing. `setScope(id, scope, { confirmLeaving })` applies
only when `confirmLeaving` names exactly those members, so what the person
reviewed is what happens. Otherwise it refuses with `changed`. Widening needs
no confirmation. The preview also lists agents an earlier narrowing (or a
refused draw) excluded for scope that the wider scope covers again
(`returning`). Applying it lifts those exclusions, so they can join again. Members who leave move from `explicit` to `excluded`
(`reason: "scope"`) and lose their live bindings, so neither a restore nor
auto-join brings them back. The change takes a sequence number like any other.

**Upgrade.** After a persisted-binding rebuild, every agent bound to a
project-scoped group project from before #3355 whose members are still wires
(not a managed record, #3357) is recorded once as an explicit member
(`migratedFrom: "wire-3355"`, helpers as helpers, quick agents and other
machines' agents left to their runs, excluded agents skipped). The record is
then marked `scopeMembersRecorded`. It waits for a complete agent inventory: a
partial read records nothing and marks nothing. New group projects are marked
at creation. So scope affects only new joins, and no existing member is dropped
silently.

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
- `src/main/services/group-project-delivery.ts`: post notices, coalescing and the rate limit (#3362).
- `src/main/services/group-project-roles.ts`: lead and admin grants, the group project's own grants, migration (#3360).
- `src/renderer/features/group-projects/GroupProjectMembersSection.tsx`: members, exclusions and the auto-join offer, for the directory.
- `src/main/services/group-project-host.test.ts`: real-file ordering, restart, crash and address regressions.
- `src/main/services/group-project-host.guard.test.ts`: fails any write outside the host.
- `src/main/services/group-project-membership-file.ts`, `group-project-json-file.ts`, `group-project-paths.ts`: host-only stores.
- `src/shared/group-project-members.ts`: host-relative member addresses.
- `src/shared/group-project-network.ts`: the network protocol, its validators and membership patches.
- `src/main/services/group-project-network.ts`: requests between computers; the host service keeps every store.
- `src/main/services/group-project-network.sim.test.ts`: two desktops in one process.
- `e2e/annex-v2/network-group-projects.spec.ts`: two desktops, the host away and back.
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

## Post notices (#3362)

Members hear about new posts as notices instead of polling the board.
`src/main/services/group-project-delivery.ts` follows the host's `board`
changes; the message a post adds carries that change's sequence number.

- **Who.** The members subscribed to the post's topic, members it names as
  `@name`, and the lead (an agent granted `group_project.lead` on it). Never its sender, and
  never for `system` posts. By default a member is subscribed to `general`,
  `control` and its own inbox; `subscribe_topic` adds or removes channels,
  kept in the membership record (`subscriptions`, by address). Members on
  other machines are left to #3363.
- **Coalescing.** Posts to one member within 15 seconds of the first become
  one notice: `3 new messages in "general" from "lead", "qa", in group
  project "Release".` with the `read_topic` tool to use. The sender is left
  out by address for `post_bulletin` posts.
- **Safe text.** Only the fixed first line is marked as from Clubhouse in
  chat. Channel, sender and group project names are flattened to one line,
  capped and quoted, and `post_bulletin` only takes channel names of
  lowercase letters, digits, `.`, `-` and `_` (up to 64).
- **Rate limit.** At most 6 notices per member per 10 minutes. Posts over the
  limit wait, merged, and go as one trailing notice when the window frees.
- **Sleeping members** aren't woken. Their notices are merged and sent as one
  summary when the member's MCP connects again. In memory only: a restart
  drops held summaries, not the board.
- **Busy members.** A chat member in a turn gets the notice queued for the
  turn's end (as Action messages are, #3297). A newer notice replaces the
  queued one with one covering both. A terminal agent's turn can't be seen,
  so it gets the notice typed in as it comes.
- **Still a member.** Every notice is checked when it goes: an agent that
  left, or a group project switched back to polling, gets nothing held.
- **Polling is legacy.** A group project with `pollingEnabled` keeps polling
  and gets no notices. `toggle_polling`, `query_polling` and `nudge_polling`
  say so in their descriptions. `GroupProjectDeliverySection` (for the
  directory) offers such a group project "Switch to notices", which turns
  polling off through the existing control.
- **Telemetry.** `clubhouse.group.notices`, by `clubhouse.notice.result`:
  `sent`, `coalesced` (messages folded into a notice beyond the first),
  `held_asleep` and `rate_limited`.

## The group project as a principal (#3360)

`src/main/services/group-project-roles.ts`.

- **Lead and admin are grants** on one group project, `{ kind: 'group_project', id }`.
  - `group_project.lead`: `broadcast`, `shoulder_tap`, `wake_agent`, `sleep_agent`, `clear_agent`, `compact_agent`, `delete_messages`, `clear_topic` and the legacy polling controls.
  - `group_project.admin`: `set_project_info`, and through the app the record, members, the group project's own grants and its Actions.

  No agent holds either by default, the creator included. They're kept in `agent-grants.json` with every other grant, so the Clubhouse permissions page lists them ("Group project <id>"). The Dispatcher may administer any group project, asking first.
- **Checked at call time** like every grant. Each group-project tool declares its actions: the lead tools declare `group_project.lead` on the bound group project, beside their `agent.*` action on its members. A member without the grant gets the typed refusal `no_grant` naming `group_project.lead`, including when it calls a tool by name. The `admins` role no longer gates any tool, and joining no longer makes the first member lead.
- **Its own grants** are what it does by itself, kept in its record's `metadata.grants`:
  - `deliver`: post notices to members (#3362). On by default.
  - `wake`: a lead's `shoulder_tap` wakes a sleeping member, with the tap as its first message. Off by default.
  - `actions`: run the group project's Actions. On by default. Message and tap steps also need `deliver`; wake steps need `wake`.

  With `wake` off, a tap to a sleeping member reports `not-running` with `refusal: 'group_project_wake_off'`.
- **Migration.** At startup, each agent in a group project's old `admins` list gets lead and admin (Allow) on it, once: `metadata.rolesMigratedAt` marks it done, so a later change isn't undone.
- **Delete.** A deleted group project's role grants are removed.
- **UI.**
  - `GroupProjectRolesSection` (for the directory) sets each member's lead and admin (Allow, Ask first, Off) and the group project's own grants.
  - The canvas card's star sets lead.
  - IPC: `GROUP_PROJECT.GET_ROLES`, `SET_ROLE`, `SET_OWN_GRANT`.

## Group project Actions (#3361)

A person or an agent with the group's Admin grant can create Actions owned by the group. They run on its authoritative host under its own grants and survive removal of their creator. Settings > Actions and the group project directory list them; peers see read-only summaries labeled with the host computer. Scheduled and one-time Actions use the normal Actions catch-up rules. Board triggers can watch a topic, membership changes, or a quiet board, with the usual coalescing rules. Deleting the group project includes its Actions in the impact preview and removes them during the recoverable delete cascade (#3364).

## Network group projects (#3363)

A group project with network reach is held by its host and copied to every
other computer in the Annex Network (members, never phones). Requests go over
the pinned mTLS connection, between network computers only
(`src/shared/group-project-network.ts`, routes on the main TLS port):

- `POST /api/v1/network/group-projects/sync`: `{ v: 1, known: { id: seq } }`
  answers the network group projects the host holds that changed since `known`.
  Each answer has the record, membership, the board's messages after that
  sequence number, and every id it still holds (so a copy drops what the host
  removed). It also lists unchanged ids and the host's tombstones. A computer
  speaks only for group projects it hosts.
- `POST /api/v1/network/group-projects/write`: up to 100 queued writes, applied
  or refused by the host in order (post, delete message or topic, topic
  protection, record fields, a membership patch, channel and inbox seeding).
- `POST /api/v1/network/group-projects/changed`: the host's notice that some of
  its network group projects changed, one per burst. The other computer then
  catches up.

**Copies.** On a non-host computer the copy is an ordinary record whose
`host.machine` is the host's fingerprint, with its board, membership and
`host.json` sequence number, so every read works unchanged. `hostName` names the
host by device name, never by fingerprint. `network` gives `role`, `state`
(`online`, `cached` while the host is away, `host-removed`), `waitingWrites`,
`syncedAt` and `refusals`. A copy catches up when the computers connect and on
every change notice, from the last sequence number it saw. A copy that finds
messages missing asks for everything next time.

**Writes.** A write on a copy goes to the host: at once when it is connected and
nothing waits before it, otherwise into `group-projects/network-outbox.json`.
That queue holds 200 writes per group project and 1,000 in all. A queued post
answers `pending: { waitingFor: <host> }`, and `post_bulletin` reports it as
queued. On reconnect the queue is sent in order. A write the host refuses, or
one that waited more than a day, is kept in `network-refusals.json` for the
directory, and the agent that made it is told. A write refused while the host is
online is refused to the caller at once. Membership changes on a copy go as a
patch (entries added and removed, fields set) that the host applies to its own
current record. Only the host deletes, clears, changes retention or changes
scope (`not_host`, "Only <host> can …").

**Addresses.** On a copy a bare id is the host's agent. An agent here is
`id@<this machine>` (`addressOf`, `localAgentId`). The membership policy (#3357)
binds only this machine's agents on a copy, and never auto-joins, adopts or
tidies there.

**Project scope over the network.** Project links (#3066) are kept by the
renderer, so the main process can't read them. A copy of a project-scoped
network group project carries its host project's repository key
(`scopeProjectKey`), the key link suggestions use.

**Leaving.** When a computer leaves the network, the group projects it hosted
become read-only copies here ("<host> left your network"), and writes waiting
for it are refused. Its agents' explicit entries leave the network group
projects this computer hosts. When the host deletes a group project, or stops
sharing it (narrowing to this computer), each copy goes at its next catch-up,
using the tombstone (#3364).

**Read state** stays per computer. Copies keep the host's message timestamps,
so the same read markers give the same unread counts on both computers (#1559).

## Local directory

Settings > Group Projects, also available as **Group Projects** in the command
palette, lists this machine's local registry, including records on no Canvas.
This is not an authoritative host, network or membership directory.

Select a record to edit its name, description and instructions through the same
store and IPC used by Canvas. Instructions retain their whitespace. Legacy or
missing scope is shown as unresolved, not inferred, until someone sets one.
Failed loads hide the inventory and offer a retry. Failed writes retain the
current draft and report that it was not saved.

Each record shows its host line ("Host: This computer", "Host: Desk, offline.
Showing a saved copy, 2 changes wait for it.", "Host: Desk left your network.
This copy is read-only."), and a copy lists changes its host refused, with
Clear this list. A copy has no scope editor: only its host changes scope.

Creation here defaults to the whole app on this computer, and the person can
choose a project instead. Selecting a record also shows its scope with Review
change and Apply. Network reach is shown disabled with its reason. Host state,
durable membership management, grants, owned Actions, deletion, board viewing
and Canvas navigation are outside this directory slice.
