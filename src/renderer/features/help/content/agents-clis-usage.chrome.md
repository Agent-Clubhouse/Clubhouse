# CLIs and usage

A CLI is the coding tool an agent runs on, such as Claude Code, Codex CLI or GitHub Copilot CLI. Each agent's **Runs on** setting picks its CLI. Turn CLIs on and off in **Settings > Agents & CLIs**. See [Agents and CLIs](#help:orchestrators) for what each one supports.

## Your account

Clubhouse uses the account each CLI is signed in to on this computer, with the environment Clubhouse starts in. There's one account per CLI. To use another account, sign the CLI in to it, or start Clubhouse with that CLI's own settings folder, such as `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `COPILOT_HOME`. After signing in again, press **Check again** in **Settings > Smart routing** to update the CLI's models and limits.

## Model, effort and context

Each agent has a model and, where its CLI offers them, a reasoning effort and a context size. They're in the agent's settings and on its **Settings** card in **Details**.

- A change applies the next time the agent starts or wakes. While a managed agent runs, its settings say "Applies when it restarts".
- When what runs now differs from what it gets next, both show, such as "300K, compacts at 267K. Next start: 500K".
- Picking another model or CLI puts effort back to the CLI's default.
- The model list comes from the CLI itself, without spending tokens, and is kept for about ten minutes.

When a CLI adds models, or stops offering one a preset uses, Clubhouse tells you, with **Review Smart routing**.

## Changing an agent's CLI

Stop the agent first, then change **Runs on** in its settings. Clubhouse asks you to confirm, because the agent starts a new session on the other CLI the next time it wakes. Its conversation can't move to another CLI.

If an agent couldn't start, for example because its CLI isn't installed, its pane offers **Change CLI**.

## Versions

Clubhouse checks each CLI's version when chat starts. A CLI older than chat supports shows a note to update it, and its agents use Terminal until you do. A CLI newer than the version chat was tested with is noted only when something else goes wrong, to help explain it.

## Usage

**Settings > Usage** shows plan limits as each CLI reports them, and the tokens your agents used. It reads files on this computer only and spends no tokens.

- **Plan limits** shows each plan's limits for Claude Code and Codex CLI. Clubhouse can't read the plan for Copilot CLI or Antigravity CLI.
- **Tokens used** covers **Today** or the **Last 7 days**.
- **By role** splits that between the Dispatcher, orchestrators, helpers, quick agents and other agents.

Usage is recorded while **Record locally** is on in **Settings > Logging**, with the `core:usage` namespace on and **Minimum level** at info or debug. Terminal runs are read from Claude Code and Codex session files, so Copilot and Antigravity runs in Terminal aren't counted.

## Experimental CLIs

Antigravity CLI is experimental. Turn it on with **Antigravity CLI** in **Settings > Experimental**, then restart Clubhouse. Clubhouse never turns it on or picks it for you. See [Antigravity CLI](#help:agents-antigravity).

See also [Agents and CLIs](#help:orchestrators), [Durable agents](#help:agents-durable)
