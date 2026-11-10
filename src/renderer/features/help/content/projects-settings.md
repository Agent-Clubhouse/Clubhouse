# Project Settings

Configure how a project appears, which orchestrator it uses, and manage plugins.

**Access:** Click the gear icon in the project header, or open Settings and switch to the project's **Project Settings** page.

## Appearance

| Setting | Description |
|---------|-------------|
| **Display name** | Override the folder name. Cosmetic only — doesn't rename the folder. |
| **Accent color** | Choose from 10+ colors for the project icon and UI accents. |
| **Custom icon** | Upload a PNG, JPG, or SVG. Supports cropping during upload. Clear to revert to the default letter icon. |

## Orchestrator

Select which AI backend powers agents in this project:

| Orchestrator | Status |
|-------------|--------|
| **Claude Code** | Stable |
| **Copilot CLI** | Stable |
| **Codex CLI** | Beta |

The selected orchestrator applies to new and restarted agents. Only orchestrators enabled in global settings and detected on your system appear as options.

## Agent environment and legacy defaults

**Agent environment** holds what every agent in the project runs under, managed or not: the source control provider, a command prefix run before the agent's CLI, and turning off Auto provider for helpers here.

**Legacy defaults** shows the instructions, permission rules, MCP servers and build, test and lint commands a project could set for new agents before Clubhouse-managed agents. They're read-only now and kept as they are:

- Clubhouse-managed agents never get them. A managed agent's setup comes from its parts, template and own settings.
- A new plain agent gets them only when **Copy this project's legacy defaults** is on when you create it. The form lists what would be copied first.
- Plain agents without an MCP file of their own still get the project's MCP servers when they start, as before.
- **Import as parts** turns the instructions and MCP servers into parts in your library. **Copy to a plain agent** puts them into one plain agent's own files. Each shows what it will do before anything changes. Permission rules can't be parts, since each CLI writes them its own way.

## Per-Project Plugin Enablement

Toggle plugins on/off for this specific project. A plugin must first be enabled at the app level. Changes take effect immediately.

## Danger Zone

| Action | Effect |
|--------|--------|
| **Close Project** | Removes from Clubhouse. Files on disk are untouched. Re-add anytime. |
| **Reset Project** | Deletes the `.clubhouse/` directory — all agents, skills, templates, and plugin config. Source code is unaffected. Cannot be undone. |
