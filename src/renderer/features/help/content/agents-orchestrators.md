# Orchestrators

An **orchestrator** is the CLI backend that powers your agents. Clubhouse uses an orchestrator provider system to support multiple backends.

## Available Orchestrators

| Orchestrator | Description |
|-------------|-------------|
| **Claude Code** | Anthropic's official CLI for Claude — the default orchestrator |
| **Copilot CLI** | GitHub Copilot's CLI interface |
| **OpenCode** | Open-source alternative (Beta) |

## Configuring Orchestrators

1. Open **Settings** (gear icon in the Project Rail)
2. Navigate to the **Orchestrators** section
3. Enable or disable orchestrators as needed
4. Each orchestrator may require its own binary and API key setup

## Per-Project Orchestrator

Each project can use a different orchestrator:

1. Select the project
2. Go to project settings
3. Choose the orchestrator from the dropdown

## Model Selection

Each orchestrator provides its own set of available models. The model picker in the agent creation flow shows models from the project's configured orchestrator.

## Binary Detection

Clubhouse automatically searches for orchestrator binaries in common locations. If the binary isn't found, you'll see a setup prompt in the orchestrator settings.
