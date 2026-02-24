# Orchestrators

An orchestrator is the CLI backend powering your agents — it handles AI communication, tool calls, file operations, and output streaming.

## Available Orchestrators

| Orchestrator | Description | Status |
|-------------|-------------|--------|
| **Claude Code** | Anthropic's CLI for Claude. Most complete Clubhouse integration. | Stable |
| **Copilot CLI** | GitHub Copilot's CLI. Best for GitHub-centric workflows. | Stable |
| **OpenCode** | Open-source AI coding backend. Community-maintained. | Beta |
| **Codex CLI** | OpenAI's Codex CLI. Sandbox-based permissions, `--full-auto` mode. | Beta |

## Setup

1. Open **Settings > Orchestrators**
2. Enable/disable orchestrators with toggles
3. Clubhouse auto-detects installed binaries via PATH

**Status indicators:**
- **Green checkmark** — Binary found, ready to use
- **Red indicator** — Binary not found. Follow the setup prompt to install.

You cannot disable the last remaining orchestrator.

## Capability Matrix

| Capability | Claude Code | Copilot CLI | OpenCode | Codex CLI |
|-----------|:-----------:|:-----------:|:--------:|:---------:|
| Headless mode | Yes | Yes | Yes | Yes |
| Structured output | Yes | — | — | — |
| Hooks | Yes | Yes | — | — |
| Session resume | Yes | — | — | Yes |
| Permissions | Yes | Yes | Yes | Yes (sandbox) |

## Per-Project Selection

Each project can use a different orchestrator: **Project Settings > Orchestrator**. Only enabled orchestrators with detected binaries appear as options.

## Model Selection

Each orchestrator provides its own model list. If models are missing:
- Update the orchestrator CLI to the latest version
- Check that API keys are valid and have the required permissions
