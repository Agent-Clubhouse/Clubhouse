# Durable agents

Durable agents are for ongoing work. Each keeps its own Git worktree and branch, survives restarts, and can sleep and wake again later.

## Creating one

1. Click **New** at the top of the sidebar and choose **Durable agent…**. Or hover a project and click its **+** button.
2. Set the **Name** and **Color**. With **Clubhouse managed** on, choose **Start with template** or **Build from scratch** to pick its instructions, skills and MCP servers. Turn it off for a plain agent: set its **Runs on** and **Model**, and optionally its **MCP servers** and **Access**. A plain agent keeps its own files, so Clubhouse Mode is off for it.
3. Leave **Use git worktree** on to give the agent its own branch.
4. Click **Create agent**. The agent appears under its project and starts right away. Select it to give it work.

Templates are in **Settings > Managed agents > Templates**. A template can set the agent's **Access**. Otherwise a new agent starts at your **Default access**. See [Access and Clubhouse permissions](#help:agents-access).

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
| **View** | Chat or Terminal. Hidden when **Chat view** is off in **Settings > Agents & CLIs**. |
| **Access** | The level the agent starts at. See **Access and Clubhouse permissions** below. |
| **Instructions**, **Skills** and **MCP servers** | A Clubhouse managed agent's parts: the blocks it reads in order, the skills copied into its folder and the MCP servers it gets |
| **Helpers** | Whether the agent orchestrates, and how it starts and deletes helpers |
| **Quick agents** | What quick agents started from this agent inherit |
| **Preview** | What a Clubhouse managed agent gets at its next start |

A plain agent has only **General**, **Helpers** and **Quick agents** here. It keeps its instructions, skills, MCP servers and permissions in its own files, and the classic layout still edits them in the app.

An agent that used Clubhouse Mode or a persona switches to managed on its own at its next start, keeping what it has now, and says so in its settings under **General > Setup**. Any other agent made before Clubhouse-managed agents can switch there, or with others in **Settings > Managed agents > Switch agents**.

## Access and Clubhouse permissions

Each agent has an **Access** level for what its CLI may do on your computer, and **Clubhouse permissions** for what it may do through Clubhouse, such as messaging other agents. New agents start at your **Default access** in **Settings > Agents & CLIs**, which is Ask first until you change it. See [Access and Clubhouse permissions](#help:agents-access).

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
