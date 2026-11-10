# Project settings

Open a project's settings from its menu in the sidebar (**Project settings**), or open Settings with `⌘,` and pick the project under **Projects**. Each project has these pages:

| Page | What's there |
|------|--------------|
| **General** | Name, icon, color, launch wrapper, blueprint bundle, and closing or resetting the project |
| **Agents & providers** | The project's default agent provider, its agent environment and its legacy defaults |
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
- **Session name on quit**.

New agents start at **Default access** in **Settings > Agents & providers**. Projects don't override it.

**Agent environment** holds what every agent in the project runs under, managed or not: the source control provider, a command prefix run before the agent's CLI, and turning off Auto provider for helpers here.

**Legacy defaults** shows the instructions, permission rules, MCP servers and build, test and lint commands a project could set for new agents before Clubhouse-managed agents. They're read-only now and kept as they are:

- Clubhouse-managed agents never get them. A managed agent's setup comes from its parts, template and own settings.
- A new plain agent gets them only when **Copy this project's legacy defaults** is on when you create it. The form lists what would be copied first.
- Plain agents without an MCP file of their own still get the project's MCP servers when they start, as before.
- **Import as parts** turns the instructions and MCP servers into parts in your library. **Copy to a plain agent** puts them into one plain agent's own files. Each shows what it will do before anything changes. Permission rules can't be parts, since each CLI writes them its own way.

## Plugins

Turn plugins on or off for this project. A plugin has to be on in **Settings > Plugins** first. Changes apply right away.

## Close and reset

| Action | Effect |
|--------|--------|
| **Close project** | Removes the project from Clubhouse. Files on disk are untouched, and you can add it again any time. `⇧⌘W` closes the active project. |
| **Reset project** | Deletes the `.clubhouse/` folder: agent definitions, skills, personas, plugin data, and every durable agent's worktree. Work an agent hasn't committed and pushed is lost. Your main checkout is not touched. This can't be undone. |
