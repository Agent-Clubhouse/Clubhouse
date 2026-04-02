# Clubhouse Assistant — Design Document

**Issue:** #1046 (refined)
**Date:** 2026-03-25
**Status:** Draft

---

## 1. Vision

Replace the static help documentation browser with an interactive **Clubhouse Assistant** — a
built-in AI agent that understands Clubhouse deeply enough to not just answer questions, but
actually configure the app on behalf of the user.

The assistant lives behind the help button (now a robot icon) in the bottom-left rail. It is
**not** a canvas agent and **not** a plugin. It is a **built-in, special-case feature** with
its own chat UI and direct access to Clubhouse internals via a dedicated API surface. This API
does not need to be generic or reusable — it exists solely for the assistant and can take
whatever shape is most effective.

The assistant must work with all three orchestrators: **claude-code**, **copilot-cli**, and
**codex-cli**. Since the conversation backend calls the Claude API directly (not through an
orchestrator), this means the assistant works the same way regardless of which orchestrator
the user's agents are configured to use. The orchestrator choice only matters when the
assistant creates agents — it should respect the user's preference or let them choose.

### What it does

| Layer | Example |
|-------|---------|
| **Explain** | "What are durable agents?" -> concise answer drawn from help content |
| **Advise** | "I have a monorepo with three services" -> recommends project structure, agent setup |
| **Do** | "Set that up for me" -> creates the project, agents, canvas, and wires |

The leap from "here's a help article" to "let me build it for you" is the core value
proposition. Users learn by watching the assistant use the app, then customize from there.

### What it does NOT do

- Debug user code or act as a general-purpose coding assistant
- Appear on the canvas or participate in agent-to-agent MCP communication
- Replace the existing help content (classic help remains accessible)

---

## 2. UX Design

### 2.1 Entry Point

The existing help button (question-mark icon) in the `ProjectRail` footer is replaced with a
**robot icon**. The button behavior changes:

- **Click** -> opens the Assistant chat view (replaces the current `explorerTab = 'help'`)
- The settings gear button remains unchanged below it

### 2.2 Assistant View Layout

When the assistant is active (`explorerTab = 'assistant'`), the explorer panel shows:

```
+---------------------------------------------+
|  +- Header --------------------------------+|
|  |  [robot] Clubhouse Assistant  [Classic ?]||
|  +-----------------------------------------+|
|                                              |
|  +- Message Feed --------------------------+|
|  |                                          |
|  |  assistant: Hi! I can help you set       |
|  |  up projects, agents, canvases, and      |
|  |  more. What are you working on?          |
|  |                                          |
|  |  user: I have a Next.js app at           |
|  |  ~/code/my-app                           |
|  |                                          |
|  |  assistant: I found a git repo at        |
|  |  that path. Want me to add it as a       |
|  |  project?                                |
|  |                                          |
|  |  +- Action Card --------------------+    |
|  |  | [check] Created project "my-app" |    |
|  |  +----------------------------------+    |
|  |                                          |
|  +-----------------------------------------+|
|                                              |
|  +- Input Bar -----------------------------+|
|  |  [Message...                      ][Send]||
|  +-----------------------------------------+|
+----------------------------------------------+
```

### 2.3 Component Breakdown

| Component | Description |
|-----------|-------------|
| **AssistantView** | Top-level container. Manages conversation state, Claude API calls, tool dispatch. |
| **AssistantHeader** | Title bar with robot icon, "Clubhouse Assistant" label, and a "Classic Help" button (question-mark icon) that switches to the existing `HelpView`. |
| **AssistantFeed** | Scrollable message list. Auto-scrolls on new messages unless user has scrolled up. Renders user messages, assistant messages (streaming markdown), and action cards. |
| **AssistantMessage** | Single message bubble. User messages are right-aligned, minimal styling. Assistant messages are left-aligned with markdown rendering via `renderMarkdownSafe()`. |
| **AssistantActionCard** | Inline card showing a tool execution: icon, description, status (pending/running/done/error). Expandable to show details. Reuses patterns from `ToolCard`. |
| **AssistantInput** | Bottom-docked input bar. Text input + Send button. Enter to send, Shift+Enter for newline. Disabled while assistant is responding. Reuses patterns from `ActionBar`. |

### 2.4 Classic Help Toggle

The `AssistantHeader` includes a button to switch to Classic Help. This sets
`explorerTab = 'help'` and renders the existing `HelpView`. The `HelpView` gets a
reciprocal link back: a small "Ask Assistant" button in its header that returns to the chat.

### 2.5 Welcome State

On first open (no conversation history), the feed shows:

- A welcome message from the assistant
- 3-4 **suggested prompts** as clickable chips:
  - "Help me set up a new project"
  - "Create a canvas for my workflow"
  - "What can Clubhouse do?"
  - "I need help debugging across services"

Clicking a chip populates and sends it as the first user message.

### 2.6 Action Confirmation

When the assistant wants to perform a destructive or significant action (creating a project,
deleting an agent, changing settings), it should **describe what it will do and ask for
confirmation** before executing. The confirmation can be conversational ("Want me to go ahead?")
rather than a modal dialog — the chat format naturally supports this.

Non-destructive reads (listing projects, checking paths) do not require confirmation.

---

## 3. Architecture

### 3.1 Overview

The assistant is a **special built-in headless agent** — not a plugin, not a canvas agent.
It spawns via the existing agent infrastructure using whatever orchestrator the user has
configured (claude-code, copilot-cli, or codex-cli) and uses their own API credentials.

```
Renderer                                Main Process
+---------------+                       +------------------+
| AssistantView |  structured mode /    | Agent Process    |
| (Chat UI)     |<--- PTY messages --->| (headless, any   |
|               |                       |  orchestrator)   |
+---------------+                       +--------+---------+
                                                 |
                                        +--------v---------+
                                        | Clubhouse MCP    |
                                        | (app config      |
                                        |  tools)          |
                                        +------------------+
```

### 3.2 Agent Lifecycle

- When the user opens the assistant for the first time in a session, a headless agent
  process is spawned using the user's configured orchestrator
- The agent's instructions (CLAUDE.md) are loaded with help content and workflow recipes
  compiled from source files at build time
- The agent receives app-configuration MCP tools via the Clubhouse MCP system
- The chat UI communicates with the agent via structured mode or PTY
- The agent persists for the app session — subsequent opens reuse the same agent
- On app restart, the agent is re-spawned fresh (ephemeral for v1)

### 3.3 Orchestrator Support

The assistant must work with all three orchestrators:
- **claude-code** — structured mode available, cleanest integration
- **copilot-cli** — PTY-based, requires output parsing
- **codex-cli** — PTY-based, requires output parsing

The chat UI abstracts over these differences. The assistant feature detects the
orchestrator and uses the appropriate communication channel.

### 3.4 MCP Tool Delivery

App configuration tools are contributed to the Clubhouse MCP as a built-in tool set
(not via the plugin tool contribution API). They are registered when the assistant
agent is spawned and scoped exclusively to it.

---

## 4. Tool API

The assistant gets a curated set of MCP tools organized by domain. These are registered as
built-in tools in the Clubhouse MCP system, scoped exclusively to the assistant agent.
They map to existing IPC calls and store methods.

### 4.1 Filesystem Tools

| Tool | Description | Maps to |
|------|-------------|---------|
| `find_git_repos` | Scan a directory (1-2 levels deep) for git repositories | `fs.readdir` + `fs.stat` for `.git` |
| `check_path` | Check if a path exists and whether it's a file or directory | `fs.stat` |
| `list_directory` | List contents of a directory | `fs.readdir` |

### 4.2 Project Tools

| Tool | Description | Maps to |
|------|-------------|---------|
| `list_projects` | List all projects with their paths and status | `IPC.PROJECT.LIST` |
| `add_project` | Add a directory as a Clubhouse project | `IPC.PROJECT.ADD` |
| `remove_project` | Remove a project | `IPC.PROJECT.REMOVE` |
| `update_project` | Update project name, color, icon | `IPC.PROJECT.UPDATE` |
| `open_project` | Navigate to a project in the UI | `uiStore.setActiveProject` |
| `check_git` | Check if a project path has git initialized | `IPC.PROJECT.CHECK_GIT` |
| `init_git` | Initialize git in a project directory | `IPC.PROJECT.GIT_INIT` |

### 4.3 Agent Tools

| Tool | Description | Maps to |
|------|-------------|---------|
| `list_agents` | List durable agents in a project | `IPC.AGENT.LIST_DURABLE` |
| `create_agent` | Create a durable agent with name, model, color, worktree, orchestrator | `IPC.AGENT.CREATE_DURABLE` |
| `update_agent` | Update agent configuration | `IPC.AGENT.UPDATE_DURABLE_CONFIG` |
| `delete_agent` | Delete a durable agent | `IPC.AGENT.DELETE_DURABLE` |
| `get_model_options` | List available models | `IPC.AGENT.GET_MODEL_OPTIONS` |
| `get_orchestrators` | List available orchestrators | `IPC.AGENT.GET_ORCHESTRATORS` |
| `write_agent_instructions` | Write CLAUDE.md for an agent | `IPC.AGENT_SETTINGS.WRITE_CLAUDE_MD` |

### 4.4 Canvas Tools

| Tool | Description | Maps to |
|------|-------------|---------|
| `list_canvases` | List all canvases | `canvasStore.getState()` |
| `create_canvas` | Create a new canvas | `canvasStore.addCanvas()` |
| `add_card` | Add a card to a canvas (agent, browser, zone, anchor) | `canvasStore.addView()` |
| `move_card` | Position a card on the canvas | `canvasStore.moveView()` |
| `resize_card` | Resize a card | `canvasStore.resizeView()` |
| `remove_card` | Remove a card from the canvas | `canvasStore.removeView()` |
| `connect_cards` | Create a wire between two cards | MCP binding creation IPC |
| `layout_canvas` | Auto-arrange cards in a layout pattern | Computed positions -> batch `moveView` |

### 4.5 Settings Tools

| Tool | Description | Maps to |
|------|-------------|---------|
| `get_settings` | Read current app settings | Settings store `get()` |
| `update_settings` | Update one or more settings | Settings store `update()` |

### 4.6 Plugin Tools

| Tool | Description | Maps to |
|------|-------------|---------|
| `list_plugins` | List installed plugins and their status | Plugin store `getPlugins()` |
| `enable_plugin` | Enable a plugin (app-wide or per-project) | Plugin store enable methods |
| `disable_plugin` | Disable a plugin | Plugin store disable methods |

### 4.7 Informational Tools

| Tool | Description | Maps to |
|------|-------------|---------|
| `search_help` | Search help content by query | `searchHelp()` from `help-search.ts` |
| `read_help_topic` | Read a specific help topic | Help content registry lookup |
| `get_app_state` | Get current app state: active project, open canvases, running agents | Aggregation of multiple stores |

---

## 5. System Prompt

The system prompt has three sections:

### 5.1 Identity and Boundaries

```
You are the Clubhouse Assistant, a built-in helper for the Clubhouse desktop app.
You help users understand Clubhouse, set up their projects and workflows, and
configure the app to match their needs.

You can:
- Answer questions about Clubhouse features and concepts
- Help users set up projects, agents, canvases, and workflows
- Configure settings and enable plugins
- Create complex multi-agent setups from high-level descriptions

You cannot:
- Write or debug user code
- Act as a general-purpose AI assistant
- Access the internet or external services
- Modify files inside user projects (only Clubhouse configuration)

Always confirm before performing destructive actions (deleting projects, agents, etc.).
For non-destructive actions (listing, reading), proceed directly.
```

### 5.2 Help Content (injected)

All 25+ help topic markdown files are concatenated and injected into the system prompt under
a `<help-content>` block. This gives the assistant deep knowledge of every feature without
needing to call `search_help` for basic questions.

Total size estimate: ~15-20K tokens. Well within system prompt budget.

### 5.3 Workflow Recipes

Structured recipes that map abstract user problems to concrete configurations:

```markdown
## Workflow Recipes

### Multi-service debugging
When a user has multiple services (e.g., client + server, or microservices) and
struggles with cross-service issues:

1. Create a project for each service (if not already added)
2. Create a canvas
3. Add an agent card for each service, positioned side by side
4. Add a group project card in the center
5. Wire each agent to the group project
6. Add a zone around the setup and label it
7. Explain to the user how to use the group project bulletin board
   for coordinating debugging across services

### Monorepo setup
When a user has a monorepo with multiple packages/services:

1. Add the monorepo root as a single project
2. Create durable agents scoped to different areas (e.g., one for frontend,
   one for backend, one for shared libs)
3. Give each agent focused instructions in their CLAUDE.md
4. Create a canvas with agent cards and a group project for coordination

### First project onboarding
When a user is new and wants to get started:

1. Help them find their project on disk (use find_git_repos on common paths)
2. Add it as a project
3. Create a first durable agent with sensible defaults
4. Explain what the agent can do and how to interact with it

[... more recipes to be authored ...]
```

---

## 6. Conversation Examples

### Example 1: Simple question (explain layer)

```
User: What's the difference between durable and quick agents?

Assistant: Durable agents are persistent -- they have their own git worktree,
maintain session history, and survive app restarts. They're ideal for ongoing
work on a specific part of your codebase.

Quick agents are ephemeral -- they spin up for a single task and disappear
when done. Great for one-off questions or small tasks you don't need to track.

Would you like me to set up a durable agent for one of your projects?
```

### Example 2: Abstract problem to concrete setup (advise + do layers)

```
User: I have two projects -- a React frontend at ~/code/client and a Go API
at ~/code/server. I keep running into issues where the client sends requests
the server does not expect, and debugging across both is painful.

Assistant: That sounds like a great use case for a multi-agent canvas setup.
Here is what I would recommend:

1. Add both projects to Clubhouse
2. Create a canvas with dedicated agents for each
3. Set up a group project so the agents can coordinate

I can see ~/code/client is a Next.js project and ~/code/server is a Go module.
Want me to set this up?

User: Yes please.

  [Action Card: checking ~/code/client... found git repo]
  [Action Card: checking ~/code/server... found git repo]
  [Action Card: Created project "client"]
  [Action Card: Created project "server"]
  [Action Card: Created canvas "Client + Server"]
  [Action Card: Added agent card "client-agent" at (100, 200)]
  [Action Card: Added agent card "server-agent" at (500, 200)]
  [Action Card: Added group project card at (300, 200)]
  [Action Card: Connected client-agent -> group project]
  [Action Card: Connected server-agent -> group project]
  [Action Card: Added zone "API Debugging" around all cards]

Assistant: All set! Here is what I created:

- Two projects: client and server
- A canvas called "Client + Server" with:
  - An agent card for each project
  - A group project in the center connecting both agents
  - A zone labeled "API Debugging" wrapping everything

The group project lets both agents share context via a bulletin board.
When you hit an API mismatch, tell one agent about the issue and it can
post to the bulletin board so the other agent sees it too.

You can open the canvas now from the left sidebar. Want me to walk you
through how to use the bulletin board?
```

---

## 7. Implementation Plan

### Phase 1: Chat UI Shell
- New `explorerTab = 'assistant'` state
- Robot icon in ProjectRail footer
- AssistantView, AssistantHeader, AssistantFeed, AssistantInput components
- Classic Help toggle (bidirectional)
- Welcome state with suggested prompts
- No AI backend yet -- just the UI chrome

### Phase 2: Agent Backend
- Spawn/manage a headless built-in agent using the user's configured orchestrator
- Wire chat UI to the agent via structured mode or PTY
- Agent instructions (CLAUDE.md) loaded with help content compiled from source files
- Support all 3 orchestrators: claude-code, copilot-cli, codex-cli
- Basic conversation flow (no MCP tools yet)

### Phase 3: Read-Only MCP Tools
- MCP tool registration framework for assistant-scoped tools
- Informational tools: search_help, read_help_topic, get_app_state
- Filesystem tools: find_git_repos, check_path, list_directory
- Read-only app tools: list_projects, list_agents, list_canvases
- AssistantActionCard component for tool execution display

### Phase 4: Write MCP Tools (Projects and Agents)
- Project tools: add_project, remove_project, update_project, open_project
- Agent tools: create_agent, update_agent, delete_agent, write_agent_instructions
- Settings tools: get_settings, update_settings
- Plugin tools: list_plugins, enable_plugin, disable_plugin

### Phase 5: Write MCP Tools (Canvas and Wiring)
- Canvas tools: create_canvas, add_card, move_card, resize_card, connect_cards
- Layout engine: layout_canvas with horizontal, vertical, grid, hub-spoke patterns
- Programmatic MCP binding creation for connect_cards

### Phase 6: Recipes and Polish
- Author workflow recipes for common patterns (compiled source files)
- Content management: easy-to-edit markdown source files for instructions/recipes
- Error handling, "new conversation" button
- Refine agent instructions based on testing

---

## 8. Open Questions

1. **Structured mode vs PTY** -- Structured mode gives cleanest integration for
   claude-code but may not be available for copilot-cli or codex-cli. PTY is
   universal but requires output parsing. May need both paths.

2. **Canvas wiring** -- `connect_cards` needs to create MCP bindings
   programmatically. Need to expose binding creation as an API (may already
   exist via `binding-manager.ts`).

3. **Conversation persistence** -- v1 is ephemeral (resets on restart). Worth
   persisting conversation history in future?
