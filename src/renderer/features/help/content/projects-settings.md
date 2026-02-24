# Project Settings

Configure how a project appears, which orchestrator it uses, and manage plugins.

**Access:** Click the gear icon in the project header, or open **Settings > Project**.

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
| **OpenCode** | Beta |
| **Codex CLI** | Beta |

The selected orchestrator applies to new and restarted agents. Only orchestrators enabled in global settings and detected on your system appear as options.

## Clubhouse Mode

When enabled, project-level agent defaults (instructions, permissions, MCP config, skills) are automatically synced to durable agents on wake. See the **Clubhouse Mode** help topic for details.

## Per-Project Plugin Enablement

Toggle plugins on/off for this specific project. A plugin must first be enabled at the app level. Changes take effect immediately.

## Danger Zone

| Action | Effect |
|--------|--------|
| **Close Project** | Removes from Clubhouse. Files on disk are untouched. Re-add anytime. |
| **Reset Project** | Deletes the `.clubhouse/` directory — all agents, skills, templates, and plugin config. Source code is unaffected. Cannot be undone. |
