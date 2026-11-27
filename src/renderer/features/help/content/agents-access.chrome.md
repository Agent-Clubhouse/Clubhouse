# Access and Clubhouse permissions

Two settings decide what an agent may do. **Access** covers what its CLI may do on your computer, like editing files and running commands. **Clubhouse permissions** cover what it may do through Clubhouse, like messaging or waking other agents.

## Access

| Level | What the CLI does |
|-------|-------------------|
| **Plan** | Reads and plans. Makes no changes. |
| **Ask first** | Asks before edits and commands. |
| **Auto-accept edits** | Makes file edits without asking. Asks before commands. |
| **Auto** | A check decides what needs your approval. It can be wrong. |
| **Full access** | Runs everything without asking. |

New agents and quick agents start at **Default access** in **Settings > Agents & CLIs**, which is Ask first until you change it. Set another level when you create an agent, or later in its settings while it's stopped.

Each CLI lists only the levels it can start at.

| CLI | In Chat | In Terminal |
|-----|---------|-------------|
| Claude Code | All five | All five |
| Codex CLI | All five | Ask first, Auto, Full access |
| Copilot CLI | Plan, Ask first, Auto-accept edits, Full access | Ask first, Full access |
| Antigravity CLI | Plan, Ask first, Auto-accept edits, Full access | Plan, Ask first, Auto-accept edits, Full access |

An agent whose level its CLI doesn't have starts at the nearest lower level it does have. Its settings show the saved level as not available for that CLI.

Auto isn't a promise of safety. The check can let through something you would have stopped.

### For one session

**Access** in a chat's composer changes the level for that session only, and the agent's saved level stays as it is. It lists only the levels the CLI can switch to mid-session. Claude Code, for example, offers Full access there only when the session started at Full access. When the two differ, the agent's **Settings** card shows both, like "Auto now, starts at Ask first".

### Quick agents

A quick agent keeps the level it was started with. The tools it may use without asking follow that level. Plan and Ask first get read-only tools, Auto-accept edits adds edits, and Auto and Full access get the full default list.

### Codex sandbox and approvals

For Codex CLI, two more settings sit under Access in the agent's settings and in templates. **Approval policy** is **Ask for untrusted commands**, **Ask when needed** or **Never ask**. **Sandbox** is **Read only**, **Workspace write** or **No sandbox**. Each starts at **Existing level default**, which follows the Access level. Set either one and it replaces that part of the level. Changes apply at the agent's next start. Other CLIs show these settings turned off.

### No agent goes above its own level

An agent can't give another agent more access than it runs at. Creating an agent, pushing a template or starting a helper at a higher level is refused, and the agent is told both levels. That's true for the Dispatcher too. You can set any level yourself.

## Clubhouse permissions

Clubhouse permissions are on the **Clubhouse permissions** page in the agent's settings, grouped by what they reach, such as **Itself**, **Its helpers**, **Connected agents**, **Its project** and **The app**. Each one is **Off**, **Ask first** or **Allow**. Each row says where its value came from, such as **Default for all agents**, **From its template** or **Set by you**. **Reset to defaults** clears the changes you made.

Expand **MCP tools** under a permission to see the Clubhouse tools it covers.

### What agents can do by default

- Every agent can read, message and wake the agents it's connected to, notify you, read app settings, and run its own Actions.
- An orchestrator can also start, wake, message and put its helpers to sleep. Whether it asks before it creates or deletes helpers follows its **Approvals** setting on its **Helpers** page.
- The Dispatcher can do the most. It can manage the agents connected to it, create agents in any project, and create and run Actions. It asks first before it adds or opens a project, deletes an agent, connects to an agent it isn't connected to yet, changes project defaults or app settings, or manages your devices.

Connected agents also need the connection to allow the tool in that direction. Each agent's connections are on its **Connections** card in **Details**.

### When an agent asks

When an agent calls a tool whose permission is **Ask first**, it doesn't wait. The request goes to **Needs you** with what the call would do, and the agent is told it's waiting.

- **Allow** runs that one call when the agent tries again. Its permissions stay as they are.
- **Decline** refuses it.

Your answer goes to exactly the request you clicked. Requests expire after 24 hours, and they're gone if Clubhouse quits. To allow something every time, set it to **Allow** on the agent's page.

An agent can also ask for a permission it doesn't have, with its reason. Allowing that adds it to the agent's page, marked as set by you, where you can turn it off again.

With Annex Network, requests from agents on your other computers can show in the Dispatcher's chat with that computer's name. Answering there answers on the computer the request came from, and the first answer wins.

### Templates

A template can set Clubhouse permissions under **Clubhouse permissions** in its settings. Agents made from it show those as **From its template**. Your own changes on an agent stay on top of them. Saving a change to the template offers to push it to the agents made from it. In **New agent**, **Copy another agent** brings that agent's permissions with it.

## Allow and deny rules

Claude Code and Codex CLI also read lists of tools to allow or deny without asking, kept in the CLI's settings file in the agent's folder, such as `.claude/settings.local.json`. The new layout doesn't edit these lists, and the classic layout still does. Copilot CLI and Antigravity CLI don't support them, so use their own access controls.

## Plugin permissions are different

Plugins declare what they may use in the app, such as files or the network. That's separate from what agents may do. See [Plugin permissions](#help:plugins-permissions).

These permissions are a guardrail on Clubhouse, not a sandbox. Other programs running as you aren't limited by them.

See also [Durable agents](#help:agents-durable), [Orchestrated helpers](#help:agents-orchestrated-helpers)
