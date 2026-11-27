# Managed agents

A Clubhouse managed agent is built from parts. A part is an instruction block, a skill or an MCP server. Parts live in a library, and agents use them by reference, so one edit to a part reaches every agent that uses it.

Clubhouse writes a managed agent's instructions, skills and MCP servers into its folder each time it starts. A plain agent keeps its own files, and Clubhouse doesn't change them.

## Making one

In **New agent**, leave **Clubhouse managed** on. It remembers your last choice. Then pick how to start.

| Option | What you get |
|--------|--------------|
| **Start with template** | A built-in template or one of yours, with its parts and settings. **Customize** opens the builder first. |
| **Build from scratch** | The builder with no parts chosen yet |
| **Copy another agent** | That agent's parts and settings. The agent you copy doesn't change. |

A managed agent always gets its own worktree and branch, or its own folder outside git. Clubhouse managed isn't available yet for a project on another computer.

## The builder

The builder is on the agent's settings pages. **Open builder** on the agent's **Settings** card in **Details** takes you there.

| Page | What it holds |
|------|---------------|
| **Instructions** | The agent's blocks, in the order it reads them. Drag a block or use the arrow keys to move it. **Add blocks from the library** adds more. |
| **Skills** | A switch for each skill in the library |
| **MCP servers** | A switch for each MCP server in the library. The Clubhouse MCP server is always on. |
| **Preview** | Exactly what the agent gets at its next start |

## How instructions are put together

Clubhouse joins the agent's blocks in order, with a blank line between each one, and adds no text of its own. Then it fills in three wildcards for that agent.

| Wildcard | Becomes |
|----------|---------|
| `@@AgentName` | The agent's name |
| `@@Path` | The agent's folder |
| `@@StandbyBranch` | The agent's branch |

Any other `@@` word stays as you wrote it. **Preview** shows the result, with each block marked, and **Show wildcards** shows the text before the wildcards are filled in. Preview also lists the skills, MCP servers and settings the agent gets, and any instruction files its CLI reads besides the ones Clubhouse writes.

## Where each CLI gets its setup

Each CLI reads its setup from its own files in the agent's folder.

| CLI | Instructions | Skills | MCP servers |
|-----|--------------|--------|-------------|
| Claude Code | `CLAUDE.md` | `.claude/skills/` | `.mcp.json` |
| Codex CLI | `AGENTS.md` | `.agents/skills/` | Given to Codex when it starts |
| Copilot CLI | `.github/copilot-instructions.md` | `.github/skills/` | `.github/mcp.json` |
| Antigravity CLI | `AGENTS.md` | `.agents/skills/` | `.agents/mcp_config.json` |

Every CLI gets the same MCP servers when it starts, in Chat or Terminal. Antigravity CLI is experimental and only shows when you turn it on in **Settings > Experimental**.

Clubhouse keeps a list of the skill folders it wrote, so a later start replaces only those. A skill folder that git tracks stays where it is, and the CLI loads it too. Preview lists those under **Also loaded from the repo**. Any other skill folder there is moved out to Clubhouse's app data, so the agent gets only the skills you chose. When the skills folder is a link, or git can't say what it tracks, Clubhouse leaves everything there, and Preview lists those folders under **Also loaded**.

For Claude Code, `CLAUDE.md` files in folders above the agent's folder would also be read. Clubhouse tells Claude Code not to read them, and Preview lists them under **Instruction files above its folder**.

## When you edit a shared part

Saving a part that more than one agent or template uses opens a dialog first. It names each agent that uses the part, with its project and whether it's running, and each template that lists it.

Each agent gets the new version at its next session start. A running agent keeps what it started with until then. Tick **Restart** beside a running agent to apply it now, and the button becomes **Save and restart**. Restart keeps the conversation, and the new setup applies from the next turn. An agent in the middle of a turn restarts when that turn ends.

Agents made from those templates later get the new version too.

If the part was saved somewhere else while you were editing it, by you in another window or by an agent, Clubhouse shows their version against yours. **Keep mine** saves yours over theirs, and **Take theirs** drops your edit.

## Setup changed

When a running agent's setup changes after its session started, a bar says what changed. It sits above the composer in Chat and under the toolbar in Terminal.

- **Restart** applies the new setup. It keeps the conversation, unless the CLI changed, which starts a new one.
- **What changed** opens Preview, with what it runs now beside what it gets at its next start.
- **Dismiss**, the X, hides the bar until the next change.

A sleeping agent gets no bar. It wakes with the new setup.

## Forking a part

Agents that use the same part stay in step. To change a part for one agent only, use **Fork** on that part in the agent's builder. While you edit a block other agents use, the editor and the save dialog also offer **Fork for reviewer instead**, with your agent's name in it. The agent gets its own copy, named after the part and the agent, like "Coding standards, reviewer", and the other agents keep the original. **Back to shared** puts the agent on the original again.

**Fork** in the library in Settings makes a copy that no agent uses yet. The library hides parts only one agent uses, such as these forks, until you turn on **Show parts used by one agent**.

## Built-in parts and templates

Built-in blocks, skills, MCP servers and templates come with Clubhouse and update with it. You can't edit them. **Make your copy** gives you one you can edit.

When Clubhouse stops shipping a built-in, the agents and templates that use it switch to a copy of yours with the same name and text. The library marks it **Custom, from a retired built-in**.

## The library

The library is in **Settings > Managed agents**, under **Agent parts**, with a page each for **Instruction blocks**, **Skills** and **MCP servers**. Each part shows who uses it. **Rename** renames it everywhere it's used.

Deleting a part that agents use asks what happens to them. **Give each agent its own copy** leaves them with what it says now. **Remove it from those agents** takes it out at their next start.

MCP servers get their sign-in from your environment. A server's **Environment** holds variable names only, and the values come from your environment when the agent starts. Clubhouse stores no secrets.

## Templates

Templates are starting points for new agents and helpers, in **Settings > Managed agents > Templates**. A template holds parts and settings, such as the CLI, model, Access, Clubhouse permissions and helper limits.

An agent made from a template isn't linked to it. When you save a template, Clubhouse lists the agents made from it, and you pick the ones that get the change. **Save template only** leaves them as they are.

To make a template from an agent, use **Save as template** in the agent's settings, under **General > Setup**.

## Parts from a repository

A project can offer parts by checking them in under `.clubhouse/parts/`.

- `skills/<folder>/SKILL.md`, with any files beside it, for each skill
- `instructions/<name>.md` for each instruction block
- `mcp.json` with an `mcpServers` list, for MCP servers
- `templates/<file>.json` for templates

They show in the builder for agents in that project, and templates show under **From project repositories** on the Templates page. Clubhouse only reads these files. Nothing in them runs, and none is used until you review it and add it. If the repository's copy changes later, Clubhouse shows the difference, and you pick **Update the part** or **Keep mine**.

## Plain agents and switching

A plain agent uses the instructions, skills and MCP setup in its own folder. To switch one to managed, use **Switch to managed** in its settings under **General > Setup**, or switch several at once in **Settings > Managed agents > Switch agents**. Switching keeps what the agent has now. Its instructions file becomes a block for that agent only, and its skills and MCP servers become parts.

**Switch to plain** in **General > Setup** goes the other way. It shows what stays and can bring back the files the agent had before it was managed.

## If you used personas or Clubhouse Mode

Agents that used a persona or Clubhouse Mode switched to managed at their next start and kept what they had. Their **General > Setup** says where Clubhouse kept their earlier files.

See also [Durable agents](#help:agents-durable), [Orchestrated helpers](#help:agents-orchestrated-helpers), [Quick agents](#help:agents-quick)
