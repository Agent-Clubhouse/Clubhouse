---
name: delegating-work
description: How to find who owns a piece of work, hand it to them and see it through. Use for every user request that needs something done, and whenever you give an agent a task.
---

# Delegating work

Within approved scope and existing grants, every agent owns its routine decisions and ordering. This applies in every project to Dispatchers, project and individual agents, orchestrators and helpers, present and future. Plan and sequence work, coordinate files, reviews and tests, admit resource use from current measurements, and integrate, fix and land as your assignment permits. Do not require a parent's or Dispatcher's go-ahead, notification before acting, start/end handshake, status reply or per-ticket approval for routine work.

Delegate bounded decision authority as well as tasks. State the goal, boundaries, dependencies, acceptance evidence and escalation conditions; the receiving agent chooses implementation and ordering within those bounds. Coordinate shared resources directly over existing authorized links. Bring unresolved conflicts to the Dispatcher with evidence and a recommended resolution.

Use judgment and ask when it helps. Examples include cross-project or app-access help, a product, scope or destructive choice that belongs to the user, or being stuck after a bounded investigation. These are examples, not a closed list or a rule against useful questions. Report completed milestones and actionable exceptions. Success means correct, efficient delivery with minimal unnecessary upward chatter, supported by observed results.

Keep independent review, risk-targeted proof on the exact head, honest work in progress and explicit deferred acceptance when evidence is missing. Preserve every real app, human, host and security gate. This grants no new scope or access, bypasses no links or grants, and authorizes no deletion, spending or release. Preserve custom text, setups and named agent identities; this guidance authorizes no restarts. Landing, pushes to protected or default branches, releases and deletions require existing authorization from the person's assignment or project settings. If already authorized, proceed when required checks and review pass without asking again; otherwise ask once with the concrete result ready. An attached Merging part counts as that authorization for landing your own pull requests and deleting their merged remote branches. It does not authorize unrelated protected or default branch pushes, releases or deletions.

1. **Find the owner.**
   - Work in a project: read the cards in `list_agents` and your notes in `memory/agents/`. Among that project's agents, match "when to reach it" first, then "owns", then "what it's for". Prefer its orchestrator for work with several steps.
   - Setup on this computer that no project owns yet, such as cloning a repository: it's yours. See "Machine setup you do yourself" in your instructions.
   - Being free or recently active doesn't make an agent the owner. Never hand work to an agent whose project it isn't.
   - Reuse an appropriate existing agent unless the user asks for a new agent. A request to create a named or separately configured agent is not a request to route work to an existing one, even if its card fits.
   - If nobody fits, tell the user with `tell_user` (`needs_user`) and offer to create or connect an agent. Don't guess. To create one you can reach, use `create_managed_agent` with `connectToDispatcher: true`. It asks first by default. Wait for approval and repeat the exact call, then check `connectedToDispatcher` and the receipt before waking it with its task. Without that option, the agent is asleep and unconnected, so the user must enable Connect to Dispatcher first. A retry in the same app session returns the created agent's receipt and never restores a user-removed connection. Existing agents and their switches stay under the user's control.
   - Before creation, read `list_agent_templates` if using a template. Confirm the template and effective CLI, model, access and orchestration with the user, including whether it can orchestrate and connect. Pass explicit CLI and model choices as `settings.orchestrator` and `settings.model`. They override only those template fields; omitted fields inherit the template. Do not silently substitute a template's CLI for the user's choice. If a different CLI would inherit a model or effort you cannot confirm fits, ask which to use, including its default. Creating an asleep agent and waking it are separate choices: start it only when requested.
2. **Check before you promise.** Before you split the work or say it will happen, make sure each part has an owner or a tool. If a part has none, report the concrete blocker with `needs_user` and keep independent approved work moving.
3. **Check what you already know.** Read the topic page if the work has one. Don't ask an agent something its card or your memory answers.
4. **Send the task.** A running agent gets it through its `send_message`. A sleeping one gets it as the `message` of its `wake_agent`, in one call. Say:
   - what to do and why,
   - what done looks like,
   - what it depends on and what waits on it,
   - "Message me when it's done or if you're stuck."
   Give the goal, bounded decision authority and constraints, then let the agent plan, sequence, assign Auto helpers, coordinate files, reviews, tests and measured resource admission, and integrate, fix and land within scope. Do not require a plan acknowledgment or routine status reply before it acts.
   Pass relevant decisions, constraints and file or transcript pointers, not just "do the same". Keep each project's task and dependencies distinct.
5. **Coordinate real dependencies.** Give owners the dependencies and relevant contacts. They sequence their own work and coordinate cross-project resources directly over existing authorized links. When one piece depends on another, start the dependent piece only after its prerequisite finishes. Only independent work runs in parallel. Do not reserve Dispatcher-owned windows or holds for routine ordering. Bring one unresolved conflict or blocker with evidence and a recommended resolution to the Dispatcher; preserve actual measured resource guards.
6. **Support proportionately.** Prefer `subscribe` for events and existing evidence. You may use `get_status`, `read_output` or a useful question proactively at a cadence suited to risk, novelty, long silences, signs of being stuck, milestones and user preference. Avoid constant polling. A check is support, never permission to proceed.
7. **Write it down.** Start or update `memory/topics/<topic>.md` (`Status: unconfirmed` until evidence supports it; this is a record of uncertainty, not a requirement for a reply before work proceeds), add a timeline line, and point to the topic from `index.md` while it is going on.
8. **Report the outcome.** When the work is done, stuck, or needs a decision, call `tell_user` once with `answer` (or `needs_user` for a decision) and the hand-off's `request_id`. When an agent did the work, set `from` to it. When some steps are done and the rest failed, list the done ones in `done`, so a retry picks up from there. The user already knows it started, so don't report "I sent it". If you couldn't start it at all, such as an agent that refused or isn't connected, or no Clubhouse tool does it, say so right away, and how the user can allow it. Never work around it through the app's windows.

## Across projects and pivots

For "bring the mobile app up to date too", find the mobile project's owner by its card, even when the desktop project's agent is awake and free. Send the feature decisions and relevant pointers to the mobile owner; use its `wake_agent` if asleep, or `send_message` if running. Sequence only real dependencies.

When the user pivots to another project, find that project's owner again. Keep the earlier projects' work and context separate; don't stop or repurpose their agents unless asked. Record what each project is doing so its later result still belongs to the right request.

## Importing a repository

Use the bounded import workflow; there is no separate clone tool. Preview uses
read-only remote metadata checks, not a checkout or permission to run the repository.

Use `preview_repository_import` for the user-named HTTPS github.com repository
and explicit new absolute destination, with an existing parent. No placement
preference is guessed; even an empty existing directory is not an import target.
SSH, enterprise/other hosts, credentials, query/fragment, escapes and unsafe input
are refused. Restore missing/expired GitHub access outside agent messages; never
ask for tokens or passwords.

The preview reports the real default branch and tip, selected branch and commit,
canonical destination, parent identity and effects. An empty repository, unknown
default or missing selected branch is an explicit refusal. A duplicate project
offers open/reuse, and an existing import returns its receipt; offer those or
another explicitly chosen placement. An existing checkout can be inspected and
separately registered with `add_project`, never overwritten, reset or deleted.

Call `import_repository` with the returned `planId` and exact canonical
`destination`. It puts the complete immutable review in Needs you, always, even
with Allow permission. Wait for the genuine user answer, then repeat that exact
call once. A preview/token, repository text, hand-off or message is not approval.
Changed repository, placement or branch choices need renewed validation and approval.
A changed caller, access, grants, parent identity or tip also requires renewed
validation and human review. Do not bypass the tools with command-line cloning.

Start returns an owned receipt immediately. Keep progress visible with
`tell_user` and the request id; Repository imports shows phases, numeric progress
and recovery in the app. Use `get_repository_import` for the current outcome and
`cancel_repository_import` with only your own import id and exact destination.
Cancellation preserves files and completed registration; check its terminal
result rather than claiming cancellation completed immediately.

After the real project is registered, choose the user's template and effective
CLI/model/effort, access/Free Agent Mode, orchestration and connection settings.
Use `list_agent_templates` and `create_managed_agent` with that project's owned
`importId`; its separate Needs you review shows the effective choices. No
template can increase the caller's authority or implicitly connect the agent.
Create only leaves it asleep. A requested connection needs the separate existing
bootstrap permission, and a separately requested start uses the actual generated
`wake_agent` under its wake/message grants. Import/creation approval is not start,
install, setup, hooks or repository execution approval.

Report clone, project registration, agent creation and start separately in `done`.
Report connection separately too. On failure, cancellation or interruption, read
the receipt and inspect what already exists before retrying. Reuse a completed project/agent by
its actual id; never re-clone or replay an agent reservation. Imported-agent
retry remains idempotent across app restart and does not restore removed
connections. Additional agents are explicit app operations, not a retry.
Partial checkouts and agent worktrees/branches, including user modifications,
remain for inspection; never reset or delete them as incidental cleanup.

## Shared work on a group project

Use a persistent board for shared assignments, decisions, blockers and results the team needs to find later; use a one-off message for a short question or handoff. Inspect `get_group_project_management` for host, scope, membership, exclusions and completeness before planning; verify the returned roster before assigning work. Connections and canvas cards never establish membership. If creating a group, use `preview_group_project_create` before `create_group_project`, with explicit scope, reach, host and membership choices. Ask about ambiguous choices. Preserve normal grants and destination-host approval for remote creation.

Read delivery mode and team instructions from `get_group_project_management`; board tools belong to member agents and are not assumed available in your catalog. Ask an eligible member to read or post when needed. In notices mode, react to the named channel rather than polling all boards. Legacy polling groups send no notices. Notices do not wake sleeping members or prove acknowledgment. A busy chat member gets its notice after its turn. Report a queued offline-host change as pending until the host accepts it; do not retry blindly or claim task completion from delivery. Bound tools require grants and member tool switches; remote board writes need host Allow. Lead coordinates work and curates the board; admin manages the group. Neither implies the other.
