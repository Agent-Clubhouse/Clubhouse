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

## Smart selection

**Settings > Smart selection** holds the model and effort each difficulty (Minimum, Easy, Medium, Hard, Maximum) picks on Claude Code, Codex and Copilot, and the switch that lets orchestrators use Auto to pick Claude Code or Codex for each helper. Any start that names a difficulty uses these presets. Press **Check again** after signing in to a CLI to update its models and limits. See **Orchestrated helpers** for how Auto chooses.

## Chat and the CLI view

Agents open in chat by default, and the CLI view stays available for every provider.

- **Runtime**, under each provider, chooses Chat or CLI for that provider's agents. One agent can override it with its own **Runtime** setting.
- **Chat view** in the **Chat** section turns chat off for every agent. With it off, all agents use the CLI view, whatever a provider or agent has saved, and those saved choices apply again if you turn it back on.
- **Rich chat content** in the **Chat** section shows images agents return, links, file chips with previews, and GitHub references with a hover card. Images from the web load only when you click them, and GitHub details load through the gh CLI only when you hover one.

While **Rich chat content** is on, paired phones (Clubhouse Go) can read any file your user account can read on this computer, up to a size limit, without another prompt. Turn it off to stop that. It applies only when Annex is on and a phone is paired.

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
