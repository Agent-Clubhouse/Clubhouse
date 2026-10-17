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

## Turning plugins on

1. **For the app**: open Settings with `⌘,`, pick **Plugins**, and turn the plugin on.
2. **For a project**: open the project's settings, pick **Plugins**, and turn it on there. It has to be on for the app first.

## Installing external plugins

External plugins load from `~/.clubhouse/plugins/`. Loading them is off by default.

1. In **Settings > Plugins**, turn on **Allow external plugins** under **From the marketplace**.
2. Put the plugin's folder in `~/.clubhouse/plugins/`.
3. Restart Clubhouse.
4. Turn it on for the app, then for each project that needs it.

To uninstall, delete its folder from `~/.clubhouse/plugins/` or click its uninstall button in **Settings > Plugins**.

## Trust

| Label | Meaning |
|-------|---------|
| **Built-in** | Ships with Clubhouse |
| **Official** | Reviewed by the Clubhouse team |
| **Community** | From someone else and not reviewed. Use your judgment. |

## Plugin states

| State | Meaning |
|-------|---------|
| **Registered** | Found, but not turned on |
| **Enabled** | On, ready to start |
| **Activated** | Running |
| **Disabled** | Turned off, by you or automatically after a permission violation |
| **Errored** | Failed to start or crashed. Check the logs. |
| **Incompatible** | Needs a newer plugin API than this version of Clubhouse has |

## Badges

Plugins can put a count or a dot on their title-bar tab. Turn plugin badges off in **Settings > Notifications & alerts**.

## Plugin settings

Some plugins have settings of their own. In **Settings > Plugins**, click the gear button on the plugin's row.
