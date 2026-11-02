# Project settings

Open a project's settings from its menu in the sidebar (**Project settings**), or open Settings with `⌘,` and pick the project under **Projects**. Each project has these pages:

| Page | What's there |
|------|--------------|
| **General** | Name, icon, color, launch wrapper, blueprint bundle, and closing or resetting the project |
| **Agents & providers** | The project's default agent provider and agent defaults |
| **Notifications & alerts** | Badge and sound overrides for this project |
| **Plugins** | Which plugins are on in this project |

## General

| Setting | What it does |
|---------|--------------|
| **Name** | Changes the name shown in Clubhouse. The folder is not renamed. |
| **Icon** | Upload a PNG, JPG or SVG and crop it. Clear it to go back to the letter icon. |
| **Color** | The project's color in the sidebar and title bar. |
| **Launch wrapper** | Runs agents through a wrapper command, when your setup needs one. |
| **Blueprint bundle** | **Export canvases** saves every canvas in the project as one bundle, for sharing or backup. |

## Agents & providers

Each setting here can follow the app-wide value or override it for this project:

- **Agents run on**, the CLI for new agents. Only CLIs that are turned on and installed are listed.
- **Quick agent mode**: interactive or headless.
- **Free agent permission mode**: Auto or skip all permissions.
- **Clubhouse Mode**, which keeps durable agents in sync with project defaults. See **Clubhouse mode**.
- **MCP override** and **Session name on quit**.

## Plugins

Turn plugins on or off for this project. A plugin has to be on in **Settings > Plugins** first. Changes apply right away.

## Close and reset

| Action | Effect |
|--------|--------|
| **Close project** | Removes the project from Clubhouse. Files on disk are untouched, and you can add it again any time. `⇧⌘W` closes the active project. |
| **Reset project** | Deletes the `.clubhouse/` folder: agent definitions, skills, personas, plugin data, and every durable agent's worktree. Work an agent hasn't committed and pushed is lost. Your main checkout is not touched. This can't be undone. |
