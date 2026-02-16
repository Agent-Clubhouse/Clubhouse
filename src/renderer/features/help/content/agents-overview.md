# Agents

Agents are AI-powered assistants that work on your code. Clubhouse supports two types of agents.

## Durable Agents

**Durable agents** are long-lived and persistent:

- They have their own name, color, and emoji
- They can be assigned a dedicated Git worktree and branch
- They persist across app restarts
- They can be paused (sleeping) and resumed
- Ideal for ongoing feature development or complex tasks

### Creating a Durable Agent

1. Select a project in the Project Rail
2. Click **New Agent** in the explorer
3. Configure name, color, branch, and model
4. Launch with an initial mission

## Quick Agents

**Quick agents** are one-shot task runners:

- They execute a single mission and exit
- Results are captured as a summary with modified files
- They appear as "ghosts" after completion for review
- Ideal for small fixes, code generation, or research tasks

### Running a Quick Agent

1. Use the quick agent launcher in the explorer
2. Enter a mission description
3. The agent runs and produces a summary upon completion

## Agent Lifecycle

| State | Description |
|-------|-------------|
| **Running** | Agent is actively processing |
| **Sleeping** | Agent has finished or was paused |
| **Error** | Agent encountered a fatal error |

## Models

Agents use AI models provided by the configured orchestrator. Available models depend on your orchestrator setup and API keys.
