# Clubhouse Assistant — Issue Breakdown

These issues refine #1046 into implementable work items.

---

## Issue 1: Clubhouse Assistant — Chat UI shell

**Labels:** `feature`, `help-system`

### Summary
Build the chat UI for the Clubhouse Assistant that replaces the help button
experience. This is the front-end shell with no AI backend — just the UI
chrome, layout, and navigation between assistant and classic help views.

### Details

**Entry point changes:**
- Replace the question-mark icon in `ProjectRail` footer with a robot icon
- Change the button's `onClick` to set `explorerTab = 'assistant'`
- Add `'assistant'` to the `explorerTab` union type in `uiStore`

**New components (in `src/renderer/features/assistant/`):**
- `AssistantView` — top-level container with header, feed, and input bar
- `AssistantHeader` — title bar with robot icon, "Clubhouse Assistant" label,
  and "Classic Help" button that switches to `explorerTab = 'help'`
- `AssistantFeed` — scrollable message list with auto-scroll behavior
  (reuse pattern from `StructuredAgentView`)
- `AssistantMessage` — renders a single message (user or assistant) with
  markdown support via `renderMarkdownSafe()`
- `AssistantActionCard` — inline card for tool execution display with
  status indicator (reuse pattern from `ToolCard`)
- `AssistantInput` — bottom-docked text input + send button
  (reuse pattern from `ActionBar`)

**Welcome state:**
- When no conversation exists, show a welcome message and 3-4 clickable
  suggested prompt chips

**Classic Help reciprocal link:**
- Add an "Ask Assistant" button to the `HelpView` header that navigates
  back to `explorerTab = 'assistant'`

### Acceptance Criteria
- [ ] Robot icon in ProjectRail opens assistant view
- [ ] Assistant view renders with header, empty feed, and input bar
- [ ] "Classic Help" button in header switches to existing HelpView
- [ ] "Ask Assistant" button in HelpView switches back to assistant
- [ ] Welcome state shows suggested prompt chips
- [ ] Clicking a chip populates the input (no send yet — no backend)
- [ ] Typing in input and pressing Enter adds a user message to the feed
- [ ] Feed auto-scrolls on new messages
- [ ] All components use existing Catppuccin theme variables

---

## Issue 2: Clubhouse Assistant — Conversation backend

**Labels:** `feature`, `help-system`
**Blocked by:** Issue 1

### Summary
Wire up the Claude API as the conversation backend for the assistant. This
includes IPC handlers for streaming responses, the conversation manager in
the renderer, and the system prompt with help content.

### Details

**Main process — Claude API proxy:**
- New IPC channel `IPC.ASSISTANT.SEND_MESSAGE`:
  - Receives: system prompt + messages array
  - Calls Claude API with streaming enabled
  - Relays `content_block_delta` events back to renderer via IPC push
  - Returns complete response (text blocks + tool_use blocks)
- New IPC channel `IPC.ASSISTANT.CANCEL`:
  - Aborts the in-flight API request
- Uses the user's configured API key and default model
- Add new IPC constants to `src/shared/ipc-channels.ts`

**Renderer — AssistantCore (conversation manager):**
- New module `src/renderer/features/assistant/assistant-core.ts`
- Maintains conversation history as a messages array
- Exposes `sendMessage(text)` that:
  1. Appends user message to history
  2. Calls IPC.ASSISTANT.SEND_MESSAGE with system + history
  3. Streams response tokens into a pending assistant message
  4. On completion, finalizes the assistant message in history
- Exposes `cancel()` to abort current response
- Manages state: `idle | streaming | tool_executing | error`

**System prompt construction:**
- New module `src/renderer/features/assistant/system-prompt.ts`
- Concatenates: identity/boundaries section + all help content markdown +
  workflow recipes
- Help content loaded from the existing `help-content.ts` registry
- Total estimated size: ~15-20K tokens

**UI integration:**
- Connect `AssistantInput` send action to `AssistantCore.sendMessage()`
- Render streaming assistant responses in `AssistantFeed` with typing
  indicator
- Disable input while streaming
- Show error state if API call fails (missing key, network error, etc.)

### Acceptance Criteria
- [ ] User can type a message and receive a streaming response from Claude
- [ ] Assistant responds knowledgeably about Clubhouse features (using
      injected help content)
- [ ] Response streams token-by-token with a typing indicator
- [ ] User can cancel a streaming response
- [ ] Error state shown when API key is missing or request fails
- [ ] Input is disabled while assistant is responding
- [ ] Conversation persists across tab switches within the same session
- [ ] Conversation resets on app restart (ephemeral for v1)

---

## Issue 3: Clubhouse Assistant — Read-only tool API

**Labels:** `feature`, `help-system`
**Blocked by:** Issue 2

### Summary
Add the first set of tools the assistant can use: read-only operations for
understanding the user's current app state, filesystem, and help content.
Includes the tool executor framework.

### Details

**Tool executor framework:**
- New module `src/renderer/features/assistant/tool-executor.ts`
- Registry of tool name -> handler function mappings
- Each handler: receives args, calls IPC/store methods, returns result string
- Integrates with AssistantCore's tool_use block handling:
  1. AssistantCore receives tool_use block from Claude
  2. Dispatches to tool-executor
  3. Feeds tool_result back into conversation
  4. Continues the agentic loop until Claude responds with text

**Tool definitions** (Claude API tool format):
- `src/renderer/features/assistant/tools/` directory with one file per domain

**Informational tools:**
- `search_help(query)` — calls `searchHelp()` from help-search.ts
- `read_help_topic(sectionId, topicId)` — looks up topic content
- `get_app_state()` — aggregates: active project, open canvases, running
  agents, enabled plugins

**Filesystem tools:**
- `find_git_repos(directory, depth?)` — scans for .git directories
  (new IPC handler, max depth 2 for safety)
- `check_path(path)` — checks existence, returns file/dir/not-found
- `list_directory(path)` — lists directory contents with types

**Read-only app tools:**
- `list_projects()` — all projects with paths, git status, agent counts
- `list_agents(projectId)` — durable agents in a project with config
- `list_canvases()` — all canvases with card counts
- `get_model_options()` — available models
- `get_orchestrators()` — available orchestrators
- `list_plugins()` — installed plugins with enabled status
- `get_settings()` — current settings values

**UI — AssistantActionCard:**
- Wire up the action card component to show tool executions inline
- Show: tool name, status spinner, result summary
- Expandable to show full input/output

### Acceptance Criteria
- [ ] Assistant can call tools and incorporate results into responses
- [ ] Tool executions appear as inline action cards in the feed
- [ ] Action cards show status (running spinner, success check, error X)
- [ ] Action cards are expandable to show details
- [ ] `find_git_repos` correctly discovers repos at common paths
- [ ] `list_projects` returns accurate project data
- [ ] `get_app_state` reflects current app state
- [ ] Tool loop works: Claude can call multiple tools before responding
- [ ] Tool errors are handled gracefully (shown in card, non-fatal)

---

## Issue 4: Clubhouse Assistant — Write tools (projects and agents)

**Labels:** `feature`, `help-system`
**Blocked by:** Issue 3

### Summary
Add write tools that let the assistant create and configure projects and
agents on behalf of the user.

### Details

**Project write tools:**
- `add_project(path)` — adds a directory as a Clubhouse project
- `remove_project(projectId)` — removes a project
- `update_project(projectId, updates)` — updates name, color, icon
- `open_project(projectId)` — navigates to project in UI
- `check_git(path)` — checks if path has git
- `init_git(path)` — initializes git in directory

**Agent write tools:**
- `create_agent(projectId, name, model, color?, worktree?, orchestrator?)`
  — creates a durable agent
- `update_agent(projectId, agentId, updates)` — updates agent config
- `delete_agent(projectId, agentId)` — deletes a durable agent
- `write_agent_instructions(worktreePath, content)` — writes CLAUDE.md

**Confirmation pattern:**
- The system prompt instructs the assistant to describe what it will do and
  ask for user confirmation before executing write operations
- This is conversational, not a system-level gate — the tools themselves
  execute immediately when called
- Destructive operations (delete) should always be confirmed
- Creation operations should be confirmed when multiple steps are involved

### Acceptance Criteria
- [ ] Assistant can add a project from a filesystem path
- [ ] Assistant can create a durable agent with specified configuration
- [ ] Assistant can write CLAUDE.md instructions for an agent
- [ ] Assistant asks for confirmation before destructive actions
- [ ] Created projects appear immediately in the ProjectRail
- [ ] Created agents appear immediately in the project's agent list
- [ ] Error handling for invalid paths, duplicate names, etc.

---

## Issue 5: Clubhouse Assistant — Write tools (canvas and wiring)

**Labels:** `feature`, `help-system`
**Blocked by:** Issue 4

### Summary
Add canvas manipulation tools so the assistant can create canvases, add
cards, position them, and wire them together. This is the capstone that
enables the full "describe your workflow and I will build it" experience.

### Details

**Canvas tools:**
- `create_canvas(name)` — creates a new canvas tab
- `add_card(canvasId, type, options)` — adds a card
  - type: 'agent' | 'browser' | 'zone' | 'anchor'
  - options: position, size, displayName, agentId (for agent cards),
    url (for browser cards)
- `move_card(canvasId, viewId, position)` — repositions a card
- `resize_card(canvasId, viewId, size)` — resizes a card
- `remove_card(canvasId, viewId)` — removes a card
- `rename_card(canvasId, viewId, name)` — renames a card
- `connect_cards(canvasId, sourceViewId, targetViewId)` — creates a wire
  (MCP binding) between two cards
- `layout_canvas(canvasId, pattern)` — auto-arranges cards
  - pattern: 'horizontal' | 'vertical' | 'grid' | 'hub-spoke'
  - computes positions based on card count and pattern, batch moves

**Canvas wiring (connect_cards):**
- This requires programmatic MCP binding creation
- Investigate `binding-manager.ts` for existing API
- May need new IPC handler: `IPC.MCP_BINDING.CREATE_FROM_VIEWS`
  that takes two viewIds and creates the appropriate binding
- Should mirror what happens when a user drags a wire in the canvas UI

**Layout engine:**
- Simple deterministic layouts, not a full graph layout library
- `horizontal`: cards in a row with equal spacing
- `vertical`: cards in a column
- `grid`: cards in a grid (sqrt(n) columns)
- `hub-spoke`: center card with others arranged in a circle around it
- Zone cards auto-sized to contain their children

### Acceptance Criteria
- [ ] Assistant can create a canvas and add multiple cards
- [ ] Cards are positioned correctly on the canvas
- [ ] Assistant can wire two cards together (creates MCP binding)
- [ ] layout_canvas arranges cards in the specified pattern
- [ ] Zones correctly wrap their contained cards
- [ ] The full workflow works end-to-end: user describes a setup,
      assistant creates canvas with cards, agents, and wires
- [ ] Canvas is navigable after creation (cards are visible, wires render)

---

## Issue 6: Clubhouse Assistant — Settings, plugins, and workflow recipes

**Labels:** `feature`, `help-system`
**Blocked by:** Issue 3

### Summary
Add settings and plugin management tools, author workflow recipes for the
system prompt, and polish the overall experience.

### Details

**Settings tools:**
- `get_settings()` — returns current settings (theme, sound, notifications, etc.)
- `update_settings(updates)` — updates one or more settings

**Plugin tools:**
- `enable_plugin(pluginId, scope?)` — enables a plugin (app or project scope)
- `disable_plugin(pluginId, scope?)` — disables a plugin

**Workflow recipes (system prompt content):**
Author structured recipes for common patterns:
- First project onboarding
- Multi-service debugging (client + server)
- Monorepo with multiple packages
- Canvas-based team coordination
- Plugin discovery and setup
- Agent instruction writing guide
- Migration from single-agent to multi-agent workflow

**Polish:**
- Refine system prompt based on real usage testing
- Handle edge cases: missing API key gracefully (show setup instructions),
  rate limit errors, model not available
- "New conversation" button to clear history
- Keyboard shortcut for opening assistant (reuse Meta+Shift+/ or new binding)

### Acceptance Criteria
- [ ] Assistant can read and update settings
- [ ] Assistant can enable/disable plugins
- [ ] Workflow recipes produce correct configurations when followed
- [ ] Error states are handled gracefully with helpful messages
- [ ] "New conversation" button works
- [ ] System prompt stays under 30K tokens total
