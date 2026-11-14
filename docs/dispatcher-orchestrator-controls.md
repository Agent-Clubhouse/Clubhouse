# Dispatcher controls: helper settings and links

The Dispatcher can change two helper settings on a connected orchestrator, and link two agents directly (#2661, #3248). The rules live in `src/main/services/dispatcher-controls.ts`, and the links in `dispatcher-connections.ts`. This is the Dispatcher's first write authority beyond appearance, so it is narrow on purpose. Since 1.0 the Dispatcher's wider reach comes from its grants (#2921, #3050); see `docs/dispatcher.md` for what shipped.

## Who and what

Dispatcher-specific controls are in the `dispatcher` tool group: only the running Dispatcher sees or can call them, even with a stale tool list. The shared `set_connection_tools` tool instead uses `connection.manage` grants; Dispatcher callers still go through the rules below. Nothing here is exposed over IPC, Annex or the CLI.

A link end must be a local durable agent now: not disposed, not a helper, not the Dispatcher, with `connectToDispatcher` resolving true. Whether it orchestrates doesn't matter (#3248), and turning orchestration on or off never creates, suspends or removes a link. What a link can do is the tools on each direction, not the agent's orchestration authority. The Dispatcher also needs its `connection.manage` grant on both ends.

A `set_orchestrator_helpers` target must also be a connected orchestrator: `orchestrate` resolving true as well.

## Tools

Agents are named by id, from `list_agents`. Any argument not listed here is refused by name.

### `set_orchestrator_helpers`

| Argument | Meaning |
| --- | --- |
| `agent_id` | Required. |
| `cross_project_helpers` | True or false. |
| `max_helpers` | Whole number from 1 to the ceiling: the lower of 100 and the app-wide helper cap. |

At least one setting is required. The change goes through `setOrchestrationPolicy`, under its per-agent lock, where the target is checked again.

No helper is stopped or settled. A cap below the live count returns `helpersOverCap`, and new starts are refused until the count drops. Turning cross-project helpers off returns `crossProjectHelpersKept` when some are running elsewhere. Saving goes through the same gate handling as the settings UI, so it can open the tool gate of a running agent whose saved policy already says orchestrate.

The ceiling is enforced in this tool only. `setOrchestrationPolicy` itself still accepts up to 100, as it did for its other callers.

### `connect_orchestrators` and `disconnect_orchestrators`

| Argument | Meaning |
| --- | --- |
| `from` | Required. The agent that gets the tools. |
| `to` | Required. The agent it reaches. |
| `two_way` | Both directions, all or nothing. Default false. |
| `allow` | `connect_orchestrators` only. The tools `from` may use on `to` (#3215). |
| `allow_back` | `connect_orchestrators` only, with `two_way`. The tools `to` may use on `from`. Default: the same as `allow`. |

Limits: 50 links in total and 10 outgoing per agent, since each wire adds tools to an agent's list.

Connecting a pair already bound some other way is refused, so the Dispatcher never claims a wire it didn't make. Connecting a pair it already made is a successful no-op, unless the call names tools for it. Disconnecting only acts on pairs in its store.

### Tools on a link (#3215)

Each direction of a link has the switches of any connection (`CONNECTION_SWITCHES` in `shared/connection-grants.ts`): `get_status`, `read_output`, `check_connectivity`, `send_message`, `send_file`, `clear_agent`, `compact_agent` and `wake_agent`. `allow` names the ones to turn on; every other one is off. Sleep, provider changes and other control aren't connection tools, so naming them is refused (`invalid_args`).

- **A new link** starts like any new connection (the maintainer's defaults, 2026-11-09): read, message and wake, with `clear_agent` and `compact_agent` off (`NEW_CONNECTION_DISABLED_TOOLS` and `NEW_CONNECTION_ENABLED_TOOLS`). With `allow`, it starts with exactly those, so wake left out of `allow` is off.
- **Tools the user saved** on a direction (an earlier wire's, or a switch they turned) are kept. Naming tools for that direction is refused (`user_tools`), and nothing changes.
- **The Dispatcher's own tools** are marked `setBy: "dispatcher"` on the direction in `connection-grants.json`. Any other write (the Connections card, a canvas popover, Make two-way) drops the mark, and the tools are the user's from then on.
- **When its link goes** (`disconnect_orchestrators`, or the user removing it on the Connections card), the tools the Dispatcher set aren't its any more (`forgetDispatcherDirection`). If nothing binds the pair, they're dropped, so a wire the user draws later starts fresh. If another source still binds it (a canvas wire, a helper link), the direction goes back to a new connection's defaults, `clear_agent` and `compact_agent` off and wake on, with `setBy` dropped, so it's the user's from then on. The same runs whenever the user removes a pair, whatever held it.
- **Ownership is checked again under the store's lock.** The Dispatcher's writes go through `setConnectionDirections`, which refuses (`user_tools`) and writes nothing if any direction got a user link or user tools since the call looked. For `connect_orchestrators` the link isn't made either.
- Links made before #3215 had no saved tools, so every tool was on. Once, at startup after a rebuild has read every source, each one still only the Dispatcher's (in its store, no other source lists the pair, nothing saved for the direction) gets the new-link defaults, wake on, marked `setBy: "dispatcher"` (`migrateDispatcherLinkTools`). Every saved direction is preserved exactly, including one saved with wake off (#3333). The done marker `dispatcher-link-defaults-3215` is kept in `connection-grants.json` under `migrations`, written with the entries, and the change is logged. A direction with saved tools, or a pair the user connects too, is never touched. While a source can't be read, it waits for a later rebuild.

The maintainer's link between two agents (status and output, messages, wake, and nothing else) is:

```json
{ "from": "<a>", "to": "<b>", "two_way": true, "allow": ["get_status", "read_output", "send_message", "send_file", "wake_agent"] }
```

### `set_connection_tools`

This is also available to ordinary agents for connections they made with `connect_agents` (#3336). They need `connection.manage` on both endpoints, and cannot change another source's switches or a direction edited by the user. Changes affect only the named direction unless a reverse direction is explicitly requested. Reset switches additionally require an allowed `agent.reset` grant on the receiver. Ordinary agents start with Ask first for managing themselves, not permission to manage unrelated agents. `list_connections` reads sources, creator, saved switches and whether a direction is changeable. These general connection tools currently resolve local durable agents by id or unique name across registered projects; remote agent endpoints remain a separate follow-up.

| Argument | Meaning |
| --- | --- |
| `from`, `to`, `two_way` | As for `connect_orchestrators`. |
| `allow` | Required. The tools `from` may use on `to`. An empty list turns them all off. |
| `allow_back` | With `two_way`. Default: the same as `allow`. |

Changes only links in the Dispatcher's store whose tools are still its own: not a direction the user set tools on, linked with Make two-way, or also connects with a canvas wire (`user_tools`). A link it didn't make is `not_dispatcher_owned`. All directions are checked first, so a refusal changes neither.

### Reading tools back

`connect_orchestrators`, `set_connection_tools` and every row of `list_orchestrator_controls` return, per direction:

```json
{ "tools": { "allowed": ["get_status", "read_output", "send_message", "send_file", "wake_agent"], "disabled": ["check_connectivity", "clear_agent", "compact_agent"] }, "tools_yours": true }
```

`tools_yours` says whether `set_connection_tools` can change them.

### `list_orchestrator_controls`

| Argument | Meaning |
| --- | --- |
| `agent_id` | Just this agent and its links. Any link end; `orchestrators` lists it only if it orchestrates. |
| `limit` | Orchestrators per page, 1 to 25. Default 10. |
| `cursor` | `next_cursor` from the last page. |
| `audit` | Newest audit rows to add, 0 to 50. Default 0. |

`links` holds only what is in the Dispatcher's store. A wire it didn't make is never listed. A pair the user also drew has `also_user_wire: true`, and that wire stays whatever happens to the link.

`unconfirmed_removals`, when present, lists links the user removed that the store hasn't taken yet. `saved` is false when a restart could lose the removal. See [User removal](#user-removal).

## Refusals

| Case | Code |
| --- | --- |
| Not the Dispatcher | The registry's group gate (no audit row), or `not_dispatcher` |
| `orchestrate`, `connectToDispatcher`, `access`, `control` or any other extra argument | `unknown_field` |
| The Dispatcher as an end or a target, which covers disconnecting a target from it | `dispatcher_wire` |
| A helper | `helper` |
| A disposed or unknown agent | `unknown_agent` |
| Connect to Dispatcher off | `not_connected_to_dispatcher` |
| `set_orchestrator_helpers` on an agent that doesn't orchestrate | `not_connected_orchestrator` |
| Disconnecting, or setting the tools of, a link the Dispatcher didn't make | `not_dispatcher_owned` |
| Naming tools for a direction whose tools are the user's | `user_tools` |
| Connecting a pair already bound some other way | `already_linked` |
| Connecting a pair the user removed | `removed_by_user` |
| `max_helpers` outside its range | `max_helpers_out_of_range` |
| Past a link limit | `link_limit` |

A refused call changes nothing. With `two_way`, a refusal for one direction leaves both as they were.

## Provenance

`dispatcher-connections.json` under the Clubhouse base dir holds one entry per direction: both ends, each end's project, `createdAt` and `createdBy`. It isn't in the Dispatcher's folder, because that is its working directory. That keeps it out of the way of ordinary file tools. It is not a security boundary against an agent at bypass level, which can write any file.

A restart rebuilds stored pairs through a pruning binding source, registered after the canvas source. A pair the user also drew restores from the canvas first, so the binding stays the user's, and disconnecting it drops only the Dispatcher's entry.

## Link status

| Status | Meaning | Binding | Entry |
| --- | --- | --- | --- |
| `active` | Both ends can be link ends. | Up | Kept |
| `suspended` | An end's Connect to Dispatcher is off, the Dispatcher is off, or the store's folder takes no writes. | Removed | Kept |
| `unverified` | An end's project can't be read. | Left as it is | Kept |
| `gone` | An end was disposed or deleted, became a helper, or its project was unregistered. | Removed | Dropped for good |

A suspended link has a `reason`: `dispatcher_off`, `store_unwritable` or `not_connected_to_dispatcher`. `orchestration_off` is gone with #3248: orchestration no longer suspends a link. `mcp_off` is gone: the Clubhouse MCP always runs (managed-agents D69). It comes back by itself when the reason ends. So that this is never unseen, readback and the Connections card both show suspended links, and the user can remove one from the card.

## User removal

The Connections card marks the Dispatcher's links and lets the user remove them. A removal drops the entry and writes a tombstone to the same store, so the pair stays removed across restarts and the Dispatcher going off and on. It ends only when the user draws that pair. A tombstone covers one direction, and is dropped once an end is gone for good.

Limit: tombstones only cover pairs in this store. Removing a wire the Dispatcher never made is remembered for that session only, as for any other wire, so it could connect that pair in a later session.

### When the removal can't be written

The store keeps its stale entry if it can't be written, or read, at that moment: a full disk, a permissions problem, or a store from a newer Clubhouse. So the removal stays pending, and a stale entry can't restore:

1. The removal goes to `dispatcher-connections.pending-removals.json`, beside the store. Every read of the store applies that file first, so restores, readback and the tools all see the pair as removed and tombstoned. The next successful save carries it in and deletes the file. A retry runs every 30 seconds, on any change the store watches, and at startup. A store from a newer Clubhouse is never rewritten, so there the file just stays.
2. If that file can't be written either, the removal holds in memory for the session and keeps retrying. The user gets an error toast saying the link could come back, and readback shows `saved: false`.
3. A session that finds saved links in a folder that takes no writes restores none of them, since the last session may have had no way to record a removal. They read as suspended with `store_unwritable`, and come back by themselves once a write lands.
4. A pending file that can't be parsed fails closed. No link restores and the link tools return an error until a person moves the file away. Nothing overwrites it.

None of this touches the user's own wires. A pair the user also drew restores from the canvas as usual, stays bound while the store is suspended, and only the Dispatcher's entry is dropped.

Drawing a pair while its removal can't be saved leaves the removal in place, so the Dispatcher stays refused for that pair until the user draws it again with the store working. That is the safe side, and the user's wire isn't affected.

Limit: step 2 is the only case with no record past the session. If nothing in the folder could be written until the app ended, and writes work again at the next launch, nothing is left to say the link was removed, so it returns. That needs a failure lasting from the removal through every retry that then clears by the next launch, and it is the case the toast warns about. Closing it would need evidence written before the failure, such as suspending every link after any unclean exit. That was left out because a crash would then take down every link.

## Audit

One `clubhouse.audit.dispatcher_control` event in the local telemetry record (#2920, `docs/telemetry-otel-spec.md` §6.13) per write call that reaches the service, including the service's own refusals. `list_orchestrator_controls` with `audit` returns them as rows:

```json
{"ts":"2026-11-01T12:00:00.000Z","tool":"set_orchestrator_helpers","actorId":"durable_1","targets":["durable_2"],"requested":{"fields":["max_helpers"],"max_helpers":3},"outcome":"ok","before":{"crossProjectHelpers":false,"maxHelpers":5},"after":{"crossProjectHelpers":false,"maxHelpers":3}}
```

Rows hold allowlisted values only, and ids the caller supplied are cut to 100 characters. The record's retention keeps it bounded. Until #2920 part three this was `dispatcher-audit.jsonl`, which is no longer written.

Every code in [Refusals](#refusals) comes from the service and is audited, apart from the registry row below.

Two refusals happen in the tool registry, before the service runs, so they leave no row: the group gate for other agents, and the check of an argument's type. Those show only in tool-call telemetry. This is an accepted limit. The same caller reaching the service directly is refused with `not_dispatcher`, and that is audited.

If local telemetry recording is off, nothing records the call: the change stands and the result has `audit_warning`.

**Reading the rows.** In the record, ids are hashed and values are kept only as short words, ids, booleans and whole numbers. `list_orchestrator_controls` with `audit` reads its rows from the record:
- Ids are matched back to the agents Clubhouse knows. One since removed shows as `hash:<hash>`. A row recorded under another salt (another build's, or from before an install id reset) is left out.
- A caller-supplied value that isn't a short word or id is left out.
- With local telemetry recording off, there are no rows to return.

## Controllers in Annex Network

Computer members publish their hidden Dispatcher controller endpoint on the pinned
Annex connection exchange. Membership creates both directions automatically. Phones
and one-to-one pairings do not get controller links. The visible Dispatcher chat is
never an endpoint. The Connections view identifies these as **Annex Network
controllers**. Removing the computer from the network ends its links; they cannot
be removed individually.

Controller links have fixed tools: status, connectivity, messages, files and request
handoff. Request handoff behavior is delivered with the remote request workflow.
Read output, clear, compact and explicit wake are always off. Settings, approvals
and prompt answers are not controller-link capabilities. Neither the connection
editor nor agent connection tools can override these rules.

Offline computers retain paused links and use Annex durable delivery on reconnect.
Turning off a Dispatcher leaves its endpoint known, shows an unavailable reason on
other computers and refuses new requests. A new network pairing must publish its
controller again before links resume. Each receiver derives its link from its own
membership and endpoint record, and rechecks membership before execution.

An enabled sleeping controller is woken through the receiving machine's own
Dispatcher delivery path. Remote origin labels remain intact, and a durable
receipt confirms accepted input only. Busy controllers leave input in the sender's
durable queue. Admission is rechecked after delivery waits and saved-config reads.

Controller publications carry both network pairing IDs. Exchanges capture the
service lifecycle and pairing before authenticated I/O, and publication commits
check that guard again before the atomic rename. A delayed response or request
from a removed pairing cannot label its endpoint as belonging to a later pairing.

## The network lead (#3351)

Settings › Dispatcher has **Lead** on a computer that's in an Annex Network with
at least one other computer. It's None (each computer uses its own Dispatcher,
as before) or one computer, this one included. Only a person chooses it. No
tool, grant or controller link reaches it.

- **One record for the network.** The choice is `{lead, rev, changedAt, by}`
  (`src/shared/dispatcher-lead.ts`), kept in `dispatcher-lead.json`. It travels
  as `extra.lead` on the same pinned connection exchange as the controller
  (`/api/v1/network/connections`, both the request and the answer), and is
  learned only under the exchange's authenticated pairing, checked again when
  it's saved, so it can't cross a remove and re-pair. A computer that was off
  gets it when it reconnects. A change is sent to every connected computer at
  once, and a computer that takes a newer record passes it on, so it also
  reaches computers the chooser can't reach.
- **Which record wins.** The higher `rev`, then the later `changedAt`, then the
  higher machine id. A choice is always one `rev` past the newest record its
  computer has seen, so a clock that's ahead or behind can't undo a later
  choice, and two choices made at once settle on the same result everywhere.
- **Confirmed.** The page lists which computers have sent back the same record,
  and which it's still waiting for.
- **The lead's computer leaves the network.** Each computer that sees the
  removal writes "no lead" one past the record it had, naming the computer that
  left, and the page says so. An offline lead stays the lead.
- **This computer leaves the network.** It forgets the record, so it can't
  overrule the lead of a network it joins later.
- Older desktops ignore `extra` and stay peers.


### Requests between controllers

Use a controller link's `hand_off_request` with `request` and an existing local `request_id` to ask the other computer's Dispatcher to handle part of that request. Plain `send_message` and `send_file` calls are news. They do not create work requests. A hand-off creates a separate receiver-local request with authenticated machine and agent identity, the origin request id, and the text. Identity claims in the text have no effect.

The receiving controller uses `list_remote_requests` and `triage_remote_request` to choose `now`, `check_in`, `needs_user`, or `decline`, with a reason. Held requests stay on the list; the next check-in explicitly reads and triages them. `needs_user` names the origin when asking the person on the receiving computer. All subsequent actions use that controller's own local grants. Nothing from another computer answers a permission prompt, an Ask first request, or a question. Pending runtime prompts hold remote input until the person here has answered them.

`report_remote_request` sends an explicit `under_way`, `waiting_user`, `answered`, `declined`, or `failed` report. Reports carry the origin request id and reach its controller and chat with the other computer's label. Only an explicit report changes that outcome. A delivery receipt and a finished CLI turn never mean the requested work is complete.

Delivery is recorded separately as `accepted`, `delivered`, `refused`, or `expired`. Accepted means a durable request is waiting. Delivered means the receiver durably admitted it, not that its model executed the task. An offline member's requests wait in the existing durable Annex outbox, expire after seven days, and have their grants, controller link and pairing checked again before sending. Removal drops pending requests and replies and tells the local sender. Already delivered requests are not sent again on reconnect. Retrying the same request id and exact text reuses the existing identity; duplicate receipts are counted.

Fixed controller bounds are eight causal crossings, twenty crossings per minute per member link, and thirty waiting requests per link. Reply and news causality is retained, so a reply cannot start a fresh loop. A new request created by the local person's conversation can start a new cause; an agent-supplied id or text cannot. A tripped link pauses and sends a notice to both computers. Its pause is retained for that pairing. This version has no agent tool for clearing it. Request/outcome, duplicate and limit telemetry contains only bounded state codes, with no raw or hashed identifiers, request text or report text.

The two-desktop fake CLI fixtures in `e2e/annex-v2/dispatcher-federation.spec.ts` cover local triage, correlated outcomes, offline restart and a bounded loop. That file is in the explicit Annex CI shard list. No paid model is used.
## Other machines' Dispatchers (#3349)

`src/main/services/dispatcher-presence.ts` turns what the controller links already know into one read-only snapshot (`DispatcherPresenceSnapshot`, `src/shared/dispatcher-presence.ts`). It has one entry for each other computer member, never phones or one-to-one pairings, sorted by machine name. Each entry has:
- the controller's machine-qualified address;
- its name and the label "<Dispatcher name> on <machine>" ("Dispatcher on <machine>" until its name is known);
- a state: `online`, `working`, `asleep`, `offline` with `lastSeen`, `off`, or `unknown` (connected, but no controller published yet). `lastSeen` is when the connection was last confirmed alive: the Annex client records it when the connection opens and at every answered heartbeat (30s), in memory, and writes it to the peer record once when the connection drops (`recordLastSeen`, never backwards). The later of that and the stored time is shown, so a connection that stayed up for hours shows when it actually went quiet;
- the link state from the federation status: `active`, `paused` (its computer is offline), `tripped` (a fixed cross-machine limit was reached; the reason is the limit the request store recorded, through the router's `pauseReason`) or `unavailable` (a Dispatcher is off), with the reason. The request store calls `federationStatusChanged()` whenever a link's pause is recorded or cleared, so a trip reaches Settings, Details, the phone and `list_other_dispatchers` at once.

The published controller now carries an optional `state` (`asleep` while its agent isn't running, `working` while requests are under way, else `online`). It's validated under the same publication guard. An older computer that sends none reads as `online` while connected.

Nothing polls. The snapshot is recomputed on device and connectivity changes, Dispatcher changes and controller publications, and its listeners hear only real changes. It is read by:
- Settings › Dispatcher › Other machines, and the compact Other machines card in the Dispatcher's Details (IPC `dispatcher:get-presence`, pushed as `dispatcher:presence-changed`);
- phones (the snapshot's `dispatcherPresence` and the `dispatcher:presence` event, advertised as `dispatcher.presence` in the capabilities; see docs/mobile-control-v1.md);
- the controller (`list_other_dispatchers`, `agent.read` on connected, read-only);
- agent pickers (#3348).

Messages and files from another machine are tagged "<name> on <machine>" by the receiving computer. This computer's own Dispatcher never gets a machine label.

The controller's memory has one page per known peer, `agents/peer-<hash>.md`. The hash is the first 16 hex digits of the SHA-256 of the lowercased machine-qualified address, so the name is safe on every file system (fingerprints contain colons). The page is titled by the label. Clubhouse writes the card from the link's stable facts (name, machine, address) only when they change, while the Dispatcher is on; the Dispatcher's notes are kept. A page write that doesn't set a title keeps the page's existing heading, so the Dispatcher's own notes write never turns the label into the hashed name. A peer that leaves keeps its page.
### Following the lead (#3352, #3353)

On a follower, the Dispatcher pane is the lead's chat, through chat across
desktops (D219): the lead's Dispatcher chat agent from its computer's snapshot,
under its namespaced id. The header says "Following <name> on <computer>".
Typing there sends to the lead's chat as a `chat.send`, which the lead shows as
the person's message.

- **This computer's earlier chat** stays as it was, read-only, one click away
  in the pane. Nothing is deleted or merged into the lead's chat.
- **The sidebar row** is the lead's Dispatcher, with its status and its
  computer's name, dimmed while that computer is offline. Before the lead's
  Dispatcher is known (no snapshot yet, or it's off there), the row still names
  the lead's computer.
- **Lead offline.** Followers stay followers. The pane says "Lead (<computer>)
  is offline, last seen …", and the lead's chat as last loaded stays readable.
  What the person types waits on this computer (`dispatcher-lead-outbox.json`,
  at most 20 messages, a day each) and goes in order when that computer is
  back. A message keeps its command id while a try's outcome is unknown, so the
  lead takes it once while it hasn't restarted; after a "not now" refusal the
  next try is a new command with a new id, since the lead keeps each id's
  receipt, a refusal included, for an hour. A lead chat asleep there is woken with the message as
  its first (`agent.start` with `resume`, main only). "Not now" refusals
  (a new session, busy, waking) are tried again for a minute; any other refusal
  drops the message and the pane says why. Expired messages are counted in the
  pane until dismissed. A message goes to the computer it was written for, even
  if the lead changes meanwhile.
- **Take back** is a button in the pane, and only a person presses it. This
  computer uses its own Dispatcher chat again (its earlier chat plus new
  messages). It never travels: other followers and the lead are unchanged.
  Settings › Dispatcher offers "Follow <lead> again", and a new lead choice
  follows again by itself. Nothing takes back by itself, however long the lead
  is offline.
- **News goes to the lead.** What a follower's triage would show in its own
  chat now (an agent's question for the person, the answer to a request, a
  check-in) goes to the lead's controller instead, over the controller link as
  a `send_message` whose `news` field holds the facts (`kind`, `text`,
  `fromName`, `request`): controllers talk to controllers, never to a visible
  chat (#2834). The lead checks the fields, refuses malformed news and news when
  it isn't the lead, and tells its controller a message rewritten from them,
  named with the follower's computer as the pinned connection names it
  ("docs-agent on Laptop"), never as the text says. The controller passes it to
  the person with `tell_user`, as with any agent's news, and sends an answer
  back to that computer's Dispatcher.
- **When the lead can't take it.** While the lead is offline, after Take back,
  or when it refuses news (at once, or later from the queue), the news shows in
  this computer's own chat. The follower pane says so ("An update from this
  computer's Dispatcher is in its own chat…"), with Show for the earlier chat,
  and says when one needs an answer, which needs Take back. After Take back,
  Settings › Dispatcher › Lead says what still waits for the lead and what
  didn't make it.
- **Phones:** a phone paired with a follower keeps that computer's own
  Dispatcher chat. A member phone already connects to every computer in the
  network (D212), so it opens the lead's chat on the lead's computer.

### Approvals from other computers (#3354)

On the lead, the Dispatcher chat lists the Ask-first requests waiting on the
other computers in the network, from each one's snapshot (`grantRequests`),
oldest first, each as "<computer>: <agent> <what it asks>", with its reason,
its detail, the call's arguments (the first 4,000 characters) and what allowing
does. The lead's row in Needs you carries them too, counted with its own. The
same requests still show on their own computers. A row that was answered shows
"Answered." until that computer's next snapshot drops it.

They show only while the lead's Dispatcher is on: with it off there's no chat
or row to show them in, so they're answered on their own computers.

- **Answering.** A person's click sends `grant.answer` to that computer over
  the pinned connection (`answerFollowerApproval`, main only), as Needs you
  there would. That computer applies it only while the request is still
  pending and the answer still offered. The first answer wins: answered on its
  own computer first, it leaves the lead's chat with that computer's next
  snapshot, and an answer from the lead then is refused with "It was already
  answered, or it ended, on that computer."
- **Only a person.** The only caller is the IPC behind the button. No tool,
  controller link, message or forwarded news reaches it, and a test scans the
  source for any other caller.
- **Left to its computer.** A desktop update's restart choice, and an answer
  the lead doesn't know, show "Answer it on <computer>." An offline computer's
  requests aren't listed.

### Authorized agents reaching another computer's Dispatcher

`list_other_dispatchers` is a read-only view available to agents. Use its machine name or fingerprint with `message_remote_dispatcher` or `send_file_to_remote_dispatcher`; the app resolves the receiving hidden controller. Both tools require `agent.message` on **Another machine's Dispatcher**. The Dispatcher defaults to Allow, agents connected to their own Dispatcher to Ask first, and others to Off. The person can change that target on the agent's Clubhouse permissions page. Ask first authorizes the exact call and arguments, never a later message or file.

The sending computer checks the agent's grant before durable admission and checks its saved policy again before retries. Removing or changing that permission invalidates queued authorization, including a revoke followed by a reset. The receiving computer checks its current member pairing, controller availability and link bounds. Sender text cannot supply identity, approve a permission, or impersonate controller news. Messages and files enter the receiving hidden controller as news under its local readiness and wake rules; they create no work request and need no local Dispatcher work turn first.

`offer_handoff_to_remote_dispatcher` delegates to `offer_handoff` with a machine-qualified Dispatcher target. This is the normal Handoff agreement and its own `handoff.offer` permission, including its normal Ask first approval, rather than a `hand_off_request` subtask. Connected agents default to Ask first on this target; the Dispatcher keeps the Handoff system's normal Ask first default. No agreement is accepted automatically. The receiver responds explicitly through `respond_to_handoff`; the original sending agent reads the same agreement id with `get_handoff` and receives labelled lifecycle notices. The source Dispatcher sees a linked local memory record and timeline entry. That copy grants it no Handoff participant rights and does not settle a Dispatcher work request.

Both Handoff modes transfer code from a registered Git worktree with a committed HEAD (#3342/#3343). Offering automatically prepares that code when no prepared manifest is supplied. A plain folder returns `not_a_repository`; a Git repository without a commit returns `no_commits`, with instructions to initialize Git or create the initial commit. Neither creates an agreement or sends transfer bytes. Use `message_remote_dispatcher` for task context that has no code to transfer.
