# Orchestrators

An **orchestrator** is the CLI backend that powers your agents. It handles communication between Clubhouse and the AI model -- sending prompts, executing tool calls, managing file operations, and streaming output back to the Clubhouse interface. Clubhouse uses an orchestrator provider system that supports multiple backends, so you can choose the CLI that best fits your workflow.

## Available Orchestrators

| Orchestrator | Description | Status |
|-------------|-------------|--------|
| **Claude Code** | Anthropic's official CLI for Claude. This is the default orchestrator and provides the most complete integration with Clubhouse. | Stable |
| **Copilot CLI** | GitHub Copilot's CLI interface. Use this if your workflow is centered on GitHub's ecosystem. | Stable |
| **OpenCode** | An open-source orchestrator alternative. Community-maintained with growing feature support. | Beta |

## Configuring Orchestrators

1. Open **Settings** (gear icon in the Project Rail, or press `Cmd+,`).
2. Navigate to the **Orchestrators** section.
3. Each orchestrator is listed with a toggle to **enable** or **disable** it.

You can enable multiple orchestrators simultaneously. Different projects can use different orchestrators, so having several enabled gives you flexibility.

**Important:** You cannot disable the last remaining enabled orchestrator. At least one orchestrator must be active at all times for Clubhouse to function.

## Binary Detection

Clubhouse automatically searches for orchestrator binaries in common installation locations when the app starts and when you enable an orchestrator. The detection covers:

- Standard PATH locations
- Common installation directories (e.g., `/usr/local/bin`, `~/.local/bin`, Homebrew paths)
- Version-managed tool directories (e.g., npm global, Cargo bin)

### Status Indicators

Each orchestrator displays a status indicator in the settings:

| Indicator | Meaning |
|-----------|---------|
| **Green checkmark** | The orchestrator binary was found and is available for use. |
| **Red indicator** | The orchestrator binary was not found. A setup prompt will guide you through installation or manual path configuration. |

If an orchestrator's binary is not found, Clubhouse displays a setup prompt with instructions for installing the required CLI tool.

## Per-Project Orchestrator

Each project can use a different orchestrator, allowing you to tailor the AI backend to the needs of each codebase:

1. Select the project in the Project Rail.
2. Open the project's settings.
3. Choose the desired orchestrator from the dropdown.

Only orchestrators that are enabled in the global settings and have their binary detected will appear as options.

## Model Selection

Each orchestrator provides its own set of available AI models. When you create or configure an agent, the **model picker** displays the models from the project's configured orchestrator.

The models available depend on:

- Which orchestrator the project is using
- The orchestrator CLI version installed on your system
- Your API key configuration and account permissions

If you do not see expected models, check that your orchestrator CLI is up to date and that your API keys are valid.

## Orchestrator Capabilities

Different orchestrators support different feature sets. Clubhouse adapts its interface based on the capabilities reported by each orchestrator.

| Capability | Description |
|-----------|-------------|
| **Headless mode** | Running the agent without an interactive terminal, using structured input/output instead. Required for background agent operation. |
| **Structured output** | The orchestrator can emit structured JSON events (tool calls, permission requests, errors) that Clubhouse uses to power real-time status indicators and the transcript view. |
| **Hooks** | Event hooks that allow Clubhouse to subscribe to agent lifecycle events such as tool calls, permission requests, and completion. |
| **Session resume** | The ability to pause an agent session and resume it later, preserving conversation context. Essential for durable agents. |
| **Permissions** | Support for permission-gated operations where the agent must request approval before performing sensitive actions like file writes or shell commands. |

Not all orchestrators support every capability. The orchestrator settings page indicates which capabilities each orchestrator provides.
