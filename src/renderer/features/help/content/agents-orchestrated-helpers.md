# Orchestrated helpers

An orchestrator agent takes a larger piece of work, such as an epic, and starts its own helper agents to do parts of it. It gives each helper a task, talks to it, accepts its work and disposes of it when it's done.

Helpers are full durable agents. Each has its own worktree and branch, runs in chat or terminal, and can be opened and talked to like any other agent. A helper's view has a **Helper of** line at the top that links to its orchestrator.

## Helpers in the sidebar

Helpers sit under their orchestrator, joined by a thin guide line. The caret on the orchestrator's row folds them away. A folded orchestrator shows how many helpers it has, with a dot when one needs you or is working.

While its worktree is being made, a helper's row says **starting**. If that fails, the row says **couldn't start**, and its hover card shows the reason.

## Making an agent an orchestrator

Turn on **Let this agent orchestrate** for a durable agent. The switch is in the **Orchestrate** card in the agent's details, and on the **Helpers** page of the agent's settings. Both change the same setting, and they also hold the agent's access, control and limit settings. Neither is shown for a helper.

When it's on, the agent's Clubhouse MCP gets the helper and connection tools. If the agent isn't running, the tools appear the next time it starts.

If you turn it off while the agent has helpers, Clubhouse asks what to do with them.

- **Keep helpers as normal agents** clears their link to the orchestrator and leaves them as they are.
- **Dispose helpers** runs the dispose checks for each one. If a helper would lose work, the dialog lists it, and **Dispose anyway** appears only when every blocked helper has work at risk. If a check couldn't run, only keeping or cancelling is offered.
- **Cancel** changes nothing.

Agents using the **Orchestrator** persona start with the switch on. The persona also tells the agent how to plan, start helpers, hand off and dispose. Give helpers the **Workhorse** persona when no other role fits.

## Starting helpers

The orchestrator calls `start_helper` with a name, a task and, if it wants, a persona, a CLI, a model and a branch to start from. A helper runs on the same CLI as its orchestrator unless the orchestrator picks another.

Creating a worktree can take up to a minute on a large repository, so `start_helper` returns at once with the helper starting. If the orchestrator's control level asks before starting, it waits for you first, as **Control levels** describes. When it's ready, Clubhouse starts it with its task and tells the orchestrator. If it fails, the orchestrator is told why. If the helper was made but its task couldn't be delivered, the task is saved, and `wake_helper` delivers it.

The orchestrator keeps track of its helpers with `list_helpers`, which shows each one's status, branch and uncommitted work. It can pause a helper with `sleep_helper` and resume it with `wake_helper`, with an optional message.

The **Helpers** card in the orchestrator's details lists its helpers with their status, branch and unsaved work. From there you can open a helper, put it to sleep, wake it, or dispose of it.

## Access

A helper never gets more access than its orchestrator has right now. Clubhouse reads the orchestrator's live permission level when the helper starts. If the orchestrator isn't running, or its level isn't known, the ceiling is **Ask first**.

| Helpers get | What that means |
|-------------|-----------------|
| **Same as**, with the orchestrator's name | The orchestrator's live level. This is the default, so an orchestrator with **Full access** starts helpers with full access. |
| **Ask first**, **Auto** or **Full access** | That level, or the ceiling if it's lower |

A helper's level is lowered until its CLI's own flags fit under the ceiling. Copilot CLI helpers only run at Ask first or Full access, so under an orchestrator at Auto they start at Ask first.

When the orchestrator wakes a helper with `wake_helper`, Clubhouse checks the ceiling again and never raises the helper above the access the orchestrator asked for when it started it. Permission prompts from a helper's own tool calls follow the helper's level as usual. The orchestrator can't answer them for you.

## Control levels

| Control | What needs you |
|---------|----------------|
| **Hands-off** | Nothing. Helpers start and are disposed without asking. This is the default. |
| **Ask before starting** | Starting a helper |
| **Ask for everything** | Starting a helper, and every dispose |

At any level the orchestrator can still ask you when it judges a choice is yours, such as when the scope is unclear or work could be lost.

Under **Ask before starting** and **Ask for everything**, `start_helper` creates nothing until you answer. The request shows under **Needs you** on the orchestrator, and as a row marked **Waiting for approval** in its **Helpers** card. You also get a desktop notification, if those are on. Select **Approve** to start the helper with the same checks as any other start, including the helper limits and the access ceiling. If the orchestrator is asleep, wake it first, and the request keeps waiting until then. Select **Decline** to drop it. Either way the orchestrator gets a message. Each orchestrator can have up to 3 requests waiting. A request that waits 24 hours expires. Waiting requests are also cleared when Clubhouse quits, and when you turn off orchestration for the agent or dispose or delete it.

## Limits

- **Helpers at once** caps how many helpers one orchestrator can have. The default is 5. The Orchestrate card shortens the label to **At once**.
- **Helpers running at once** in **Settings > Helpers** sets a cap across every orchestrator in every project. The default is 20, and no agent can be set above it.

Running helpers count against your plan's usage limits, and every message between agents costs a turn on both sides. Sleep helpers that are waiting, and dispose of them when their work is in.

## Accepting work

When a helper is done, the orchestrator checks its work and calls `hand_off`, saying whether the work was pushed, merged into the orchestrator's branch, or copied. The helper then shows as **Handed off**, and the Helpers card offers **Review**. Handing off doesn't dispose of the helper. Clubhouse never merges on its own; the agents use ordinary Git.

## Disposing

Disposing stops the helper, then deletes its worktree folder and its local branch. The copy of the branch on the remote is never touched.

Clubhouse always runs its checks first.

| Check | Effect |
|-------|--------|
| Uncommitted files | Holds the dispose |
| Commits that weren't pushed | Holds the dispose |
| A check that couldn't run | Holds the dispose, and it can't be forced |
| Commits not merged into the orchestrator's branch | Reported, but doesn't hold the dispose |

When the orchestrator calls `dispose_helper`:

- **Nothing holds it.** The helper is disposed straight away.
- **Something holds it.** Nothing is deleted and the helper keeps running. The orchestrator gets back the facts, such as which files are uncommitted and how many commits weren't pushed. It can finish the work, ask you, or call again with `force` when the only problem is work at risk.
- **Under Ask for everything**, the request goes to **Needs you** instead, and `force` is refused. Selecting it opens the dispose dialog, where you dispose of the helper or decline. If the orchestrator is running, it's told what you chose.

When you dispose of a helper yourself from the Helpers card, the dialog runs the same checks. A clean helper shows **Dispose**, work at risk shows **Dispose anyway**, and a failed check only offers **Check again**. **Just sleep** stops the helper and keeps everything.

Disposed helpers move to a **Disposed** section at the end of the Helpers card, where **Remove** deletes them for good. **Settings > Helpers** lists disposed helpers whose orchestrator was deleted.

If you delete an orchestrator that still has helpers, Clubhouse asks whether to dispose of them, with the same checks, or keep them as normal agents.

## Connections

Each helper gets a two-way wire to its orchestrator when it starts. These wires survive restarts. The helper replies with `message_parent`.

Helpers aren't wired to each other automatically. The orchestrator can connect them in two ways.

| Tools | What they do |
|-------|--------------|
| `connect_agents`, `disconnect_agents` | Add or remove a wire between two of its helpers, or between itself and a helper |
| `create_group_project`, `add_to_group_project`, `remove_from_group_project` | Create a named group project and choose which helpers are in it |

These tools only reach the orchestrator and its own helpers. Connections and memberships they make are saved and come back after a restart. `disconnect_agents` only removes wires made with `connect_agents`. Wires drawn on the canvas, and the wires between an orchestrator and its helpers, stay.

The **Connections** card in an agent's details lists its wires. Wires made by the connection tools have **Disconnect**. Others are read-only. A connection you remove stays removed, even after a restart.

## Setting the defaults for a project

Policy for an agent comes from its own settings first, then its persona's front-matter, then the **Orchestrator** persona, then the built-in defaults. To ship a policy with a project, add `.clubhouse/personas/orchestrator.md` with an `orchestration` line in its front-matter:

```
---
orchestration: {"orchestrate": true, "access": "same", "control": "hands-off", "maxHelpers": 5}
---
```

| Key | Values |
|-----|--------|
| `orchestrate` | `true` or `false`. From the Orchestrator persona, it only applies to agents using that persona. |
| `access` | `same`, `standard`, `auto` or `bypass` |
| `control` | `hands-off`, `ask-before-start` or `ask-everything` |
| `maxHelpers` | How many helpers at once |
