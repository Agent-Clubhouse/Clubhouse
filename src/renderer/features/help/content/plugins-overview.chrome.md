# Installing and using plugins

Plugins add views, commands and tools to Clubhouse.

## Where plugins appear

| Scope | Where it shows up | Works with |
|-------|-------------------|------------|
| **Project** | A tab in the title bar, in each project where it's turned on | That project's files, Git and agents |
| **App** | The row under Search, beside Canvas and Review, or an icon in the sidebar footer | Everything, not tied to a project |
| **Dual** | Both | Either |

A project tab with its own list, such as Files or Git, swaps the sidebar to that list while it's open. Tabs that fill the pane, such as Canvas, keep the agent tree. App plugins that don't fit beside Canvas and Review go in that row's **More** menu.

## Built-in plugins

| Plugin | What it does |
|--------|--------------|
| **Terminal** | A shell for the selected agent's worktree or the project root |
| **Files** | A file browser with an editor, Markdown preview and images |
| **Git** | Status, diffs, commits and branches for the selected agent or project |
| **Browser** | A web browser inside the pane |
| **Canvas** | A board for laying out agents and notes, per project or app-wide |
| **Review** | Go through agents one at a time, starting with the ones that need you |
| **Group Project** and **Sticky Notes** | Cards on a canvas. They're listed while Canvas is on. |

## Turning plugins on

1. **For the app**: open Settings with `⌘,`, pick **Plugins**, and turn the plugin on.
2. **For a project**: open the project's settings, pick **Plugins**, and turn it on there. It has to be on for the app first.

## Installing external plugins

External plugins load from `~/.clubhouse/plugins/`. Loading them is off by default.

1. In **Settings > Plugins**, turn on **Allow external plugins** under **From the marketplace**.
2. Put the plugin's folder in `~/.clubhouse/plugins/`.
3. Click **Reload** under **Local plugins** in **Settings > Plugins**.
4. Turn it on for the app, then for each project that needs it.

To uninstall, delete its folder from `~/.clubhouse/plugins/` or click its uninstall button in **Settings > Plugins**.

## Trust

| Label | Meaning |
|-------|---------|
| **Built-in** | Ships with Clubhouse |
| **Official** | Reviewed by the Clubhouse team |
| **Community** | From someone else and not reviewed. Use your judgment. |

## When a plugin doesn't load

A plugin's row in **Settings > Plugins** says why it isn't running, such as "Doesn't work with this version of Clubhouse." or the error it hit, with **View details**. For more, check the `core:plugins` and `plugin:<id>` diagnostic lines.

Clubhouse loads plugins built for API 0.7, 0.8 or 0.9. A plugin built for 0.5 or 0.6, which were removed in 1.0, doesn't load, and Clubhouse tells you once which plugins those are.

An update that needs more permissions than the plugin has says so, with **Reject**.

## Retired plugins

The Lounge, KanBoss and Bug Report plugins, and the Hub, were retired in 1.0. Clubhouse no longer loads them and removes them and their data at startup. Files git tracks in a project, such as a committed KanBoss board, stay where they are.

## Plugins that add agent parts

A plugin that adds instructions or MCP servers for agents adds them as parts in the library, in **Settings > Managed agents**, marked with the plugin's id. The plugin keeps them up to date, so make your own copy to change one. Uninstalling the plugin removes its parts.

## Badges

Plugins can put a count or a dot on their title-bar tab. Turn plugin badges off in **Settings > Notifications & alerts**.

## Plugin settings

Some plugins have settings of their own. In **Settings > Plugins**, click the gear button on the plugin's row.
