# Agent Overview

Agents are AI assistants that work directly on your code. Each is backed by an orchestrator (e.g., Claude Code) that drives the AI model and handles tool calls.

## Agent Types

| Type | Lifespan | Best For |
|------|----------|----------|
| **Durable** | Persistent — survives restarts, can be paused/resumed | Feature branches, multi-day refactors, ongoing work |
| **Quick** | One-shot — runs a task and exits | Bug fixes, code generation, quick questions |

## Lifecycle States

The explorer shows a colored ring around each agent's avatar:

| State | Ring | Meaning |
|-------|------|---------|
| **Working** | Green (pulsing) | Actively processing — reading files, writing code, running commands |
| **Needs Permission** | Orange | Waiting for you to approve/deny a sensitive operation |
| **Tool Error** | Yellow | A tool call failed; agent may recover on its own |
| **Sleeping** | Gray | Paused or between missions — resume anytime |
| **Error** | Red | Fatal error — check terminal output or transcript |

## Dashboard Monitoring

The Dashboard home screen aggregates agent stats across all projects: working count, attention needed, and completed today. The **Needs Attention** box lists agents requiring action with clickable links.

## Agent Pop-Out

Any agent can be detached into an independent OS window for multi-monitor workflows. The pop-out stays fully synchronized with the main window.

## Model Selection

Models are provided by the project's orchestrator. Change an agent's model from its config panel — takes effect on next start or resume.

## Reordering

Drag agents in the explorer list to reorder. The order persists per project across restarts.
