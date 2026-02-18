# Safe Mode

Safe mode is an emergency startup option that disables all plugins, allowing you to diagnose and recover from problems that prevent Clubhouse from starting normally.

## What Is Safe Mode?

When Clubhouse starts in safe mode, **all plugins are disabled**. The core application loads normally -- you can access your projects, agents, and settings -- but no plugin code is executed. This isolates plugin-related issues from the rest of the application.

Safe mode is designed for situations where a plugin causes Clubhouse to crash or behave incorrectly during startup. By removing plugins from the equation, you can determine whether a plugin is the root cause of the problem and take corrective action.

## When Safe Mode Triggers

Clubhouse includes **crash loop detection** that monitors startup behavior. Each time Clubhouse launches, it writes a startup marker to track whether the application initialized successfully. If Clubhouse detects repeated startup failures -- meaning the app crashed before it could fully start multiple times in a row -- it triggers the safe mode prompt on the next launch.

### The Safe Mode Dialog

When crash loop detection activates, Clubhouse presents a dialog with two options:

| Option | Description |
|--------|-------------|
| **Start in Safe Mode** | Launches Clubhouse with all plugins disabled. The application will start without loading any plugin code. |
| **Try Again Normally** | Attempts a normal startup with all plugins enabled. Use this if you believe the crash was a one-time issue (e.g., caused by a transient system condition). |

The dialog also displays a **list of plugins that were enabled at the time of the last crash**. This information helps you identify which plugin may be causing the problem.

## Working in Safe Mode

Once Clubhouse is running in safe mode:

1. **All plugins are disabled.** Plugin tabs, sidebar panels, and plugin-generated badges will not appear.
2. **Core features work normally.** You can open projects, start agents, use Git integration, and access settings.
3. **Investigate the problem.** Open **Settings > Plugins** and review the list of plugins. Look for any plugin that was recently installed, updated, or that appeared in the safe mode dialog's crash list.
4. **Disable the problematic plugin.** Toggle off the plugin you suspect is causing the crash. You can disable plugins one at a time to isolate the issue.
5. **Restart normally.** Close and reopen Clubhouse. With the problematic plugin disabled, the app should start without triggering safe mode.

If you are unsure which plugin is at fault, disable all plugins, restart, and then re-enable them one at a time until the crash reoccurs.

## Reset Project

If a project's `.clubhouse/` configuration directory has become corrupted -- for example, due to a failed write, a version mismatch, or manual editing -- you can reset it.

1. Open **Settings > Project** (within the affected project).
2. Click **Reset Project**.
3. Confirm the action.

**What this does:**

- Deletes the `.clubhouse/` directory for that project, removing all Clubhouse-specific configuration, agent definitions, plugin settings, and cached data.
- Your **source files on disk are not touched**. Only the `.clubhouse/` metadata is removed.
- The project will appear as a fresh addition the next time you interact with it. You will need to reconfigure agents, plugins, and project-level settings.

Use this as a last resort when project-level configuration is in a broken state and other troubleshooting steps have not resolved the issue.

## Close Project

If you want to remove a project from Clubhouse without affecting the files on disk:

1. Right-click the project icon in the Project Rail.
2. Select **Close Project**.

This removes the project from the Clubhouse sidebar and stops tracking it. The project folder and all its files -- including the `.clubhouse/` directory -- remain untouched on disk. You can re-add the project at any time by using the `+` button in the Project Rail and selecting the same folder.

## Using Logs for Diagnosis

When troubleshooting startup problems or plugin issues, Clubhouse's logging system is your primary diagnostic tool.

1. Open **Settings > Logging**.
2. Ensure logging is **enabled**.
3. Set the log level to **Debug** for maximum detail.
4. Enable relevant namespaces, particularly `core:startup`, `plugins:loader`, and `plugins:api`.
5. Restart Clubhouse and reproduce the problem.
6. Open the log file (the path is shown in the Logging settings with a direct link) and look for error messages, stack traces, or warnings that indicate the cause of the failure.

Logs can reveal which plugin failed to load, which API call caused an exception, or where in the startup sequence the crash occurred. This information is invaluable when reporting issues or deciding which plugin to disable.
