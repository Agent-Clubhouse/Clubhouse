# Agents

Agents are AI-powered assistants that work directly on your code inside Clubhouse. Each agent is backed by an orchestrator — the CLI backend (such as Claude Code) that drives the AI model, manages tool calls, and handles file operations. Clubhouse provides the visual layer: you see what the agent is doing, approve or deny sensitive operations, and manage the agent's lifecycle from a unified desktop interface.

## Agent Types

Clubhouse supports two distinct types of agents, each suited to different workflows.

| Type | Purpose | Lifespan | Use Cases |
|------|---------|----------|-----------|
| **Durable** | Long-lived, persistent agents with dedicated configuration | Survives app restarts; runs until you stop or delete it | Feature development, multi-day refactors, ongoing code review, complex research |
| **Quick** | One-shot task runners that execute a single mission | Runs once and exits automatically | Small bug fixes, code generation, one-off questions, quick research tasks |

Durable agents live in the explorer list under your project and can be paused, resumed, and reconfigured at any time. Quick agents are launched from a lightweight prompt, produce a summary when finished, and then appear as dismissible review cards.

See the dedicated **Durable Agents** and **Quick Agents** help topics for full details on each type.

## Agent Lifecycle

Every agent moves through a set of lifecycle states. The explorer list shows a colored ring around each agent's avatar to indicate its current state at a glance.

### Primary States

| State | Visual Indicator | Description |
|-------|-----------------|-------------|
| **Running** | Green ring with pulse animation | The agent is actively processing its mission. The ring pulses to indicate ongoing activity. |
| **Sleeping** | Gray ring (no animation) | The agent has finished its current work or was manually paused. It can be resumed at any time. Durable agents enter this state between missions. |
| **Error** | Red ring | The agent encountered a fatal error and stopped. Check the terminal output or transcript for details. |

### Detailed Status Indicators

While an agent is running, Clubhouse monitors its activity in real time and may display more specific status indicators.

| Status | Visual Indicator | Description |
|--------|-----------------|-------------|
| **Working** | Green ring with pulse | The agent is executing normally — reading files, writing code, running commands. |
| **Needs Permission** | Orange ring | The agent is waiting for you to approve or deny a sensitive operation such as a file edit or shell command. An action prompt appears in the terminal view. |
| **Tool Error** | Yellow ring | A tool call failed (for example, a shell command returned a non-zero exit code). The agent is still running and may recover on its own, but you may want to check the output. |

These indicators update in real time as Clubhouse monitors the stream of tool calls, permission requests, and errors from the orchestrator.

## Hook Events

Clubhouse subscribes to events emitted by the orchestrator during an agent's session. These hook events power the real-time status indicators, permission prompts, and transcript logging. The events Clubhouse monitors include:

- **Tool calls** — every file read, file write, shell command, or search the agent performs
- **Permission requests** — when the agent wants to perform a sensitive operation and needs your approval
- **Errors** — tool failures, orchestrator crashes, and other unexpected conditions
- **Completion** — when the agent finishes its mission or exits

You do not need to configure hook events manually. They are handled automatically by the integration between Clubhouse and the orchestrator.

## Model Selection

Agents use AI models provided by the project's configured orchestrator. When you create or configure an agent, the model picker displays all models available through that orchestrator. The set of available models depends on your orchestrator setup and API keys.

You can change an agent's model at any time from the agent's configuration panel. The new model takes effect the next time the agent starts or resumes.

## Agent Reordering

Durable agents appear in a list in the project explorer. You can drag agents up or down in this list to reorder them. The order is saved per project and persists across restarts. Use this to keep your most active agents at the top or group related agents together.
