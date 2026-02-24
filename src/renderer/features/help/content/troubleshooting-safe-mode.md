# Safe Mode & Recovery

Safe mode disables all plugins so you can diagnose and fix startup problems.

## When Safe Mode Triggers

Clubhouse detects **crash loops** — repeated startup failures. When detected, a dialog appears:

| Option | Effect |
|--------|--------|
| **Start in Safe Mode** | Launch with all plugins disabled |
| **Try Again Normally** | Attempt normal startup (use if crash was one-time) |

The dialog lists plugins that were enabled at the time of the last crash.

## Working in Safe Mode

1. All plugins are disabled — no plugin tabs, sidebars, or badges
2. Core features work normally (projects, agents, Git, settings)
3. Open **Settings > Plugins** — identify the suspect plugin (recently installed/updated, or listed in the crash dialog)
4. Disable the problematic plugin
5. Restart Clubhouse normally

**Not sure which plugin?** Disable all, restart, then re-enable one at a time until the crash reoccurs.

## Recovery Options

### Reset Project

Deletes the `.clubhouse/` directory for a project — all agent definitions, skills, templates, and plugin config are removed. Source code is unaffected.

**Project Settings > Danger Zone > Reset Project**

Use as a last resort when project configuration is corrupted.

### Close Project

Removes a project from Clubhouse without touching files on disk. The `.clubhouse/` directory stays intact. Re-add anytime with the `+` button.

**Right-click project icon > Close Project**

## Using Logs

When troubleshooting:
1. **Settings > Logging** — enable logging
2. Set level to **Debug**
3. Enable `core:startup`, `plugins:loader`, `plugins:api` namespaces
4. Reproduce the problem
5. Open the log file (link in Logging settings) and look for errors

Logs reveal which plugin failed, which API call caused an exception, and where in the startup sequence the crash occurred.

## Reporting Issues

If you can't resolve the problem, report it at [github.com/Agent-Clubhouse/Clubhouse/issues](https://github.com/Agent-Clubhouse/Clubhouse/issues) with:
- Steps to reproduce
- Relevant log output
- Clubhouse version (**Settings > About**)
