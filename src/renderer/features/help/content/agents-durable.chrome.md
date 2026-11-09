# Durable agents

Durable agents are for ongoing work. Each keeps its own Git worktree and branch, survives restarts, and can sleep and wake again later.

## Creating one

1. Click **New** at the top of the sidebar and choose **Durable agent…**. Or hover a project and click its **+** button.
2. Set the **Name** and **Color**. With **Clubhouse managed** on, choose **Start with template** or **Build from scratch** to pick its instructions, skills and MCP servers. Turn it off for a plain agent: set its **Runs on** and **Model**, and optionally its **MCP servers** and **Access**. A plain agent keeps its own files, so Clubhouse Mode is off for it.
3. Leave **Use git worktree** on to give the agent its own branch.
4. Click **Create agent**. The agent appears under its project and starts right away. Select it to give it work.

Templates are in **Settings > Managed agents > Templates**. A template can set the agent's **Access**. Otherwise a new agent starts at your **Default access**. See **Access** below.

## Waking a sleeping agent

- Select the project's name. On the start page, choose the agent under **Wake a sleeping agent**, type what it should do, and press `⌘Enter`.
- Or use **Wake** in the agent's row menu or hover card, then type in its pane.

**Stop** in the row menu puts it back to sleep. Its worktree and branch stay as they are.

## Worktrees

Each durable agent works in its own worktree on its own branch:

- Its file changes stay in its worktree. Your main checkout isn't touched.
- Several agents can work on different branches at once.
- Bring the work back with ordinary Git: merge, a pull request or cherry-pick. Clubhouse never merges on its own.

Selecting the agent points the Terminal, Files and Git tabs at its worktree.

## Configuration

Open **Settings** from the agent's row menu or hover card.

| Setting | What it does |
|---------|--------------|
| **Appearance** | Name, color and icon |
| **Runs on** and **Model** | The CLI and model the agent uses. Changes apply the next time it starts or wakes. |
| **Runtime** | Chat or CLI. Hidden when **Chat view** is off in **Settings > Agents & providers**. |
| **Access** | The level the agent starts at. See **Access** below. |
| **Instructions**, **Skills** and **MCP servers** | A Clubhouse managed agent's parts: the blocks it reads in order, the skills copied into its folder and the MCP servers it gets |
| **Helpers** | Whether the agent orchestrates, and how it starts and disposes of helpers |
| **Quick agents** | What quick agents started from this agent inherit |
| **Preview** | What a Clubhouse managed agent gets at its next start |

A plain agent has only **General**, **Helpers** and **Quick agents** here. It keeps its instructions, skills, MCP servers and permissions in its own files, and the classic layout still edits them in the app.

An agent that used Clubhouse Mode or a persona switches to managed on its own at its next start, keeping what it has now, and says so in its settings under **General > Setup**. Any other agent made before Clubhouse-managed agents can switch there, or with others in **Settings > Managed agents > Switch agents**.

## Access

Each agent has one **Access** setting: the level its CLI starts at.

| Level | What the agent does |
|-------|---------------------|
| **Plan** | Reads and plans. Makes no changes. |
| **Ask first** | Asks before edits and commands. |
| **Auto-accept edits** | Makes file edits without asking. Asks before commands. |
| **Auto** | A check decides what needs your approval. It can be wrong. |
| **Full access** | Runs everything without asking. |

New agents start at **Default access** in **Settings > Agents & providers**. It starts at Ask first until you change it. You can pick another level when you create an agent, and change it later in the agent's settings or its details card while it sleeps. The hover card and details card show the level as plain text.

Each CLI only lists the levels it can start at. Claude Code has all five. In the terminal, Codex CLI has Ask first, Auto and Full access, and Copilot CLI has Ask first and Full access. In chat, each CLI offers the levels its chat connection supports. If an agent's level isn't one its CLI can start at where it runs, it starts at the nearest lower level that it can.

Auto isn't a promise of safety. The check can let through something you would have stopped.

Changing the level in a chat's composer applies to that session only. The agent's saved Access doesn't change, and when the two differ the details card shows both, for example "Auto now, starts at Ask first".

## Clubhouse permissions

Access governs what an agent's CLI does on your machine. Clubhouse permissions govern what it can do through Clubhouse: read or message other agents, start helpers, change app settings, run Actions. They're on the **Clubhouse permissions** page in the agent's settings, grouped by what they reach. Each one is **Off**, **Ask first** or **Allow**.

When a call needs a permission set to Ask first, the agent doesn't wait. The request goes to **Needs you** with what the call would do, and the agent is told it's waiting. Select it to see the request, then choose **Allow** or **Decline**. Allow runs that one call when the agent tries again; the agent's permissions don't change. To allow it every time, set the permission to Allow on the agent's page. Requests expire after 24 hours, and the agent is told your answer either way.

An agent can also ask for a permission it doesn't have, with its reason. Allowing that adds it to the agent's page, marked as set by you, where you can turn it off again.

Your templates can set permissions too, under **Clubhouse permissions** in the template's settings. Agents made from the template get them, marked "From its template", and saving a change offers to push it to the agents made from it. Your own changes on an agent stay on top, and **Reset to defaults** clears only yours. A helper template's permissions never give a helper more than its orchestrator has. In **New agent**, each template says in one line what agents made from it can do through Clubhouse, and **Copy another agent** brings its permissions with it.

For an orchestrator, **Create agents** and **Delete agents and remove helpers** follow its approval setting on the Helpers page, and changing either here changes that setting.

A connection between two agents goes each way on its own: in each direction, the agent that sends is limited to the tools that direction allows. Open a connection with **Manage** on the agent's **Connections** card to see both directions side by side, turn tools on or off for each, and use **Make two-way** when it only goes one way. A canvas wire's tool permissions change the same settings, for that wire's direction. A new connection lets the sender read the other agent and message it; **Clear** and **Compact** start off. That goes for the connections Clubhouse makes too: a helper can't clear or compact its orchestrator, and neither the Dispatcher nor an agent connected to it can do that to the other, until you turn them on. An orchestrator can still clear or compact its own helpers. Connections from before this get the same start, unless you changed their tools.

**Wake it** is the last switch in each direction. When it's on, the sender can wake the other agent while it's asleep, so a message can reach it. It starts off for every connection, older ones included. Waking also needs the agent's **Wake** permission on **Connected agents with Wake it on**, which is Allow by default; set it to Ask first or Off on the agent's Clubhouse permissions page. Putting an agent to sleep stays with you and the Dispatcher. A wire with the Dispatcher has no Wake it switch, since a message already wakes the Dispatcher, and neither does a helper's link with its orchestrator, which wake each other with their helper tools.

The Dispatcher can do the most by default. It can read, message, wake, put to sleep, reset, rename and configure the agents connected to it, create agents in any project, change an agent's setup up to its own level, make and remove connections, and create and run Actions. It asks first before it adds or opens a project (**Add or open projects**), changes project defaults or changes app settings. Its Clubhouse permissions page works like any other agent's, so you can set each of these to Off, Ask first or Allow.

No agent sets Access above the level it runs at, the Dispatcher included. Creating an agent, pushing a template that changes the level, or starting a helper at a higher level is refused, and the agent is told both levels. That holds when the level comes from a template or from the Default access for new agents, too. You can set any level yourself.

These permissions are a guardrail on Clubhouse, not a sandbox. Other programs running as you aren't limited by them.

## Deleting

Stop the agent first, then choose **Delete** in the row menu. What the dialog offers depends on the agent's worktree:

- **No worktree**: **Remove** takes it out of Clubhouse.
- **Worktree with nothing uncommitted or unpushed**: **Delete** removes the agent and its worktree, and **Leave files** keeps the worktree on disk.
- **Worktree with uncommitted or unpushed work**: you choose what happens to that work:

| Option | What happens |
|--------|--------------|
| **Commit & push** | Commits every change to the agent's branch and pushes, then deletes the agent |
| **Cleanup branch** | Saves the work to a `<name>/cleanup` branch and pushes it, then deletes the agent |
| **Save as patch** | Exports the changes to a `.patch` file, then deletes the agent |
| **Force delete** | Deletes everything at once. Uncommitted work is lost. |
| **Leave files** | Removes the agent from the sidebar. Its worktree and files stay on disk. |
