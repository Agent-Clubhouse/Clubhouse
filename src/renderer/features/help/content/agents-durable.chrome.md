# Durable agents

Durable agents are for ongoing work. Each keeps its own Git worktree and branch, survives restarts, and can sleep and wake again later.

## Creating one

1. Click **New** at the top of the sidebar and choose **Durable agent…**. Or hover a project and click its **+** button.
2. Set the **Name**, **Color**, **Runs on** and **Model**. Optionally pick a **Persona**, **MCPs** and **Free Agent Mode**.
3. Leave **Use git worktree** on to give the agent its own branch.
4. Click **Create agent**. The agent appears under its project and starts right away. Select it to give it work.

To start from a saved setup, choose **Agent from a template…** under **New**.

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
| **Runtime** | Chat or CLI. Shown only when the experimental Chat feature is on. |
| **Persona** | A role the agent takes on, such as reviewer or researcher |
| **Instructions** | Markdown that guides the agent: style, limits, how to work |
| **Permissions** | Tools the agent may use without asking, and tools it's always denied |
| **MCP** | The agent's Model Context Protocol servers |
| **Quick agent defaults** | What quick agents started from this agent inherit |

With **Clubhouse mode** on, project defaults sync to the agent when it wakes. See **Clubhouse mode**.

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
