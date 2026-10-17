# Safe mode and recovery

Safe mode starts Clubhouse with every plugin off, so you can find and fix what's making it crash.

## When it appears

If Clubhouse failed to start properly last time, it offers:

| Option | Effect |
|--------|--------|
| **Start in Safe Mode** | Starts with all plugins off |
| **Try Again Normally** | Starts as usual, for a one-off crash |

The dialog lists the plugins that were on when it last crashed.

## In safe mode

1. There are no plugin tabs, sidebar items or badges.
2. Projects, agents, Git and settings work as usual.
3. Open **Settings > Plugins** and find the likely plugin: one you installed or updated recently, or one the dialog listed.
4. Turn it off.
5. Restart Clubhouse.

Not sure which one? Turn them all off, restart, then turn them back on one at a time until the crash comes back.

## Recovery

### Reset a project

Deletes the project's `.clubhouse/` folder: agents, skills, templates and plugin config. Source code is untouched. Use it as a last resort when a project's setup is broken.

Open the project's settings from its menu in the sidebar, then click **Reset project** at the bottom of the first page.

### Close a project

Removes the project from Clubhouse without touching anything on disk, `.clubhouse/` included. Add it again any time with **Add project**.

Click **Close project** at the bottom of the project's settings, or select the project and press `⇧⌘W`.

## Using logs

1. Open **Settings > Logging** and turn logging on.
2. Set the level to **Debug**.
3. Turn on `core:startup`, `plugins:loader` and `plugins:api`.
4. Reproduce the problem.
5. Open the log file from the link on that page and look for errors.

The log shows which plugin failed, which call threw, and how far startup got.

## Reporting a problem

If you can't fix it, report it at [github.com/Agent-Clubhouse/Clubhouse/issues](https://github.com/Agent-Clubhouse/Clubhouse/issues) with the steps, the relevant log lines, and your version from **Settings > About**.
