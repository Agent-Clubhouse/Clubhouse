# Helpers and Smart routing

An orchestrator is an agent that takes a larger piece of work and starts helper agents to do parts of it. It gives each helper a task, talks to it, accepts its work and deletes it when it's done.

Helpers are full durable agents. Each has its own worktree and branch, runs in Chat or Terminal, and can be opened and talked to like any other agent. A helper's view has a **Helper of** line at the top that links to its orchestrator.

## Helpers in the sidebar

Helpers sit under their orchestrator, joined by a thin guide line. The caret on the orchestrator's row folds them away. A folded orchestrator shows how many helpers it has, with a dot when one needs you or is working.

While its worktree is being made, a helper's row says **starting**. If that fails, the row says **couldn't start**, and its hover card shows the reason.

A helper in another project sits in that project's list. A line under its name says which orchestrator it helps.

## Making an orchestrator

The quickest way is the built-in Orchestrator template in **New agent**. Its blocks tell the agent how to plan, start helpers, review their work and hand it off.

For any durable agent, turn on **Let this agent orchestrate** on the **Helpers** page of its settings, or in the **Orchestration** card in its **Details**. In a template, the same switch is **Orchestration**, and in New agent it's **Can start helpers**. When it's on, the agent gets the helper tools at its next start. An agent that used the Orchestrator persona keeps the switch on when it switches to managed.

If you turn it off while the agent has helpers, Clubhouse asks whether to keep them as normal agents or delete them.

## The orchestrator's settings

| Setting | What it does |
|---------|--------------|
| **Approvals** | **Hands-off**, **Ask before starting** or **Ask for everything**. See below. Hands-off is the default. |
| **Helpers at once** | The most helpers it can have. The default is 5. |
| **Cross-project helpers** | Lets it start helpers in your other projects. Off by default. |
| **Smart routing** | Whether it may let Clubhouse pick the CLI for a helper. It follows the app setting unless you set it here. |
| **Access**, under **Defaults for new helpers** | The level helpers start at. **Same as** the orchestrator is the default. |

In a template, **Helper selection** sets the same choice as **Smart routing**. **App setting** follows Settings, **Auto** lets Clubhouse pick, and **Fixed** keeps the CLI the agent names. **Helper template** picks the template its helpers start from.

## Starting helpers

The orchestrator calls `start_helper` with a name and a task. It can also name a CLI, a model, a reasoning effort, a difficulty, an access level and a branch to start from. A helper runs on the same CLI as its orchestrator unless the orchestrator picks another.

Every helper is a Clubhouse managed agent built from a template. Without one named, it gets the **Default helper template** from **Settings > Managed agents > Helpers**, which starts as the built-in **Helper** template. Turn on **Let orchestrators choose helper templates** there to let an orchestrator name another template, or add and leave out parts for one helper.

Creating a worktree can take up to a minute on a large repository, so `start_helper` returns at once with the helper starting. Clubhouse starts the helper with its task when it's ready, and tells the orchestrator. If it fails, the orchestrator is told why.

The orchestrator keeps track of its helpers with `list_helpers`, and can pause one with `sleep_helper` and resume it with `wake_helper`. `list_models` lists the models each CLI accepts, without spending tokens.

## Difficulty and presets

With a difficulty of easy, medium or hard, the model and effort come from the presets in **Settings > Smart routing**. Each CLI has five levels, **Minimum**, **Easy**, **Medium**, **Hard** and **Maximum**, and each one maps to a model and an effort. Minimum shows **Same as Easy** and Maximum shows **Same as Hard** until you pick a model for them.

| CLI | Easy | Medium | Hard |
|-----|------|--------|------|
| Claude Code | Haiku, low effort | Sonnet, medium effort | Opus, high effort |
| Codex CLI | gpt-6-luna, low effort | gpt-6.1-terra, medium effort | gpt-6.1-sol, high effort |
| GitHub Copilot CLI | Claude Haiku 5.5, low effort | Claude Sonnet 5.5, medium effort | Claude Opus 5.5, high effort |

These are starting choices, so change them to suit your work. **Reset** puts one level back, and **Reset all** puts back a CLI's whole list. A difficulty never changes the helper's CLI. Anything the orchestrator names itself wins. If a preset's model is no longer offered, the built-in preset is used and the helper says so.

After signing in to a CLI again, press **Check again** to update its models and limits. When a CLI adds models or stops offering one a preset uses, Clubhouse tells you, with **Review Smart routing**.

## Smart routing

Smart routing lets an orchestrator pass `cli: "auto"` and have Clubhouse pick the CLI for each helper. Turn on **Let orchestrators use Smart routing for helpers** in **Settings > Smart routing**. It's off by default, but orchestrators made from the built-in Orchestrator template ask for it. An orchestrator's own setting wins, and a project can turn it off but not on.

Smart routing picks between Claude Code and Codex, favoring the CLI that has used less of its plan limit. It chooses once, for the helper's whole task, and the helper keeps that CLI and model.

- A CLI that has used 80% of a limit is picked after the CLIs with more room.
- A CLI at 95% or more, or out, isn't picked.
- A limit Clubhouse can't read never counts as having room.

Clubhouse can't read Copilot's plan, so Copilot is picked only when no other CLI can be. Turn off **Allow Copilot as a last resort** and Smart routing never picks Copilot, though an orchestrator can still name it. Antigravity CLI isn't one of its choices.

**Prefer useful work before quota resets** is optional. With it on, Smart routing favors a plan whose limit resets within 48 hours, more strongly in the last 24, so that use isn't lost. **Keep for me (%)** holds back part of each plan for your own work. It's 10% unless you change it. This setting doesn't turn Smart routing on.

Smart routing balances use of your plans, not cost.

## Access

A helper never gets more access than its orchestrator has right now. Under an orchestrator at **Plan**, a helper starts at Plan too. If the orchestrator isn't running, or its level isn't known, the most a helper gets is **Ask first**.

When an orchestrator asks for a level above its own, the start is refused and both levels are given. A level from **Defaults for new helpers** is lowered to fit instead, since you chose it. A helper's level is also lowered to one its CLI can start at.

## Approvals

| Approvals | What needs you |
|-----------|----------------|
| **Hands-off** | Nothing. Helpers start and are deleted without asking. |
| **Ask before starting** | Starting a helper |
| **Ask for everything** | Starting a helper, and every delete |

Under **Hands-off**, a question a helper asks goes to its orchestrator, and the helper waits for the answer. The orchestrator answers it or passes it to you, and then it shows under **Needs you**. If the orchestrator is asleep, the question comes to you. Under the other levels, and for helpers in Terminal, helpers' questions always come to you.

When a start needs you, nothing is created until you answer. The request shows under **Needs you** and as **Waiting for approval** in the orchestrator's **Clubhouse helpers** list. **Approve** starts the helper and **Decline** drops it. Each orchestrator can have up to 3 requests waiting, and a request expires after 24 hours.

## Limits

- **Helpers at once** caps one orchestrator. The default is 5.
- **Helpers running at once** in **Settings > Managed agents > Helpers** caps every orchestrator together. The default is 20, and no agent can be set above it.

Running helpers count against your plan limits, and every message between agents costs a turn on both sides. Put helpers to sleep while they wait, and delete them when their work is in.

## Helpers in other projects

With **Cross-project helpers** on, the orchestrator can start a helper in another project you've added to Clubhouse. The helper is created there like any of that project's agents, and counts against the orchestrator's limit. A project in the same repository as the orchestrator's, a project on another computer, a group project, and a folder that isn't a git repository can't take helpers.

A helper in another project can't merge into the orchestrator's branch, so it pushes its branch or opens a pull request. Turning the switch off stops new starts there. Helpers already started keep running.

## Accepting work

When a helper is done, the orchestrator checks its work and records whether it was pushed, merged into its branch, or copied. The helper then shows as **Handed off**, and its row in **Clubhouse helpers** offers **Review**. Clubhouse never merges on its own. The agents use ordinary git.

## Deleting helpers

Deleting a helper stops it, then deletes its worktree folder and its local branch. The copy of the branch on the remote is never touched.

Clubhouse checks first. Uncommitted files and commits that weren't pushed hold the delete, and so does a check that couldn't run. Commits not merged into the orchestrator's branch are reported but don't hold it.

When a check holds it, nothing is deleted. The orchestrator is told why and can finish the work, ask you, or force the delete when the only problem is work at risk. Under **Ask for everything**, a delete always comes to you in **Needs you** instead.

Deleting a helper yourself from **Clubhouse helpers** runs the same checks. Deleted helpers move to a list at the end of Clubhouse helpers, where **Remove** clears them for good. Helpers left without an orchestrator are listed in **Settings > Managed agents > Helpers**.

When you delete an orchestrator that still has helpers, Clubhouse asks whether to delete them too, with the same checks, or keep them as normal agents.

## Connections

Each helper gets a two-way connection to its orchestrator when it starts. The helper replies with `message_parent`. Helpers aren't connected to each other, but the orchestrator can connect two of its helpers, or put them in a group project. Each connection shows on the agent's **Connections** card in **Details**.

See also [Durable agents](#help:agents-durable), [Dispatcher](#help:agents-dispatcher), [Agents and CLIs](#help:orchestrators)
