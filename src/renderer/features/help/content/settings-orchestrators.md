# Agent providers

An agent provider is the CLI that runs your agents. It handles AI communication, tool calls, file operations, and output streaming. Each agent's **Runs on** setting picks the CLI it uses.

An orchestrator agent is a different thing. It's an agent that starts and manages helper agents. See **Orchestrated helpers**.

## Available agent providers

| Provider | Description | Status |
|----------|-------------|--------|
| **Claude Code** | Anthropic's CLI for Claude. Most complete Clubhouse integration. | Stable |
| **Copilot CLI** | GitHub Copilot's CLI. Best for GitHub-centric workflows. | Stable |
| **Codex CLI** | OpenAI's Codex CLI. Sandbox-based permissions, `--full-auto` mode. | Beta |

## Setup

1. Open **Settings > Agents & providers**
2. Enable/disable agent providers with toggles
3. Clubhouse auto-detects installed binaries via PATH

**Status indicators:**
- **Green checkmark**: binary found, ready to use
- **Red indicator**: binary not found. Follow the setup prompt to install.

You cannot disable the last remaining agent provider.

## Capability matrix

| Capability | Claude Code | Copilot CLI | Codex CLI |
|-----------|:-----------:|:-----------:|:---------:|
| Headless mode | Yes | Yes | Yes |
| Structured output | Yes | Yes | Yes |
| Hooks | Yes | Yes | Yes |
| Session resume | Yes | Yes | Yes (`--last` / most recent only; no resume-by-ID) |
| Permissions | Yes | Yes | Yes (sandbox) |

## Per-project selection

Each project can use a different agent provider. To choose it, set **Agents run on** on the project's **Agents & providers** settings page. Only enabled providers with detected binaries appear as options.

## Model selection

Each agent provider has its own model list. If models are missing:
- Update the provider's CLI to the latest version
- Check that API keys are valid and have the required permissions
