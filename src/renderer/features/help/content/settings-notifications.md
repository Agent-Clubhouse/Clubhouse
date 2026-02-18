# Notifications

Clubhouse provides a configurable notification system that keeps you informed about agent activity, permission requests, and other important events -- even when the app is in the background.

## Notification Settings

To configure notifications:

1. Open **Settings** (gear icon in the Project Rail, or press `Cmd+,`).
2. Navigate to the **Notifications** section.

### Master Toggle

At the top of the Notifications settings is a **master enable/disable toggle**. When disabled, Clubhouse will not send any system notifications regardless of individual event settings. Badge indicators may still appear within the app.

### Event-Based Notifications

Each notification event can be toggled independently. The available events are:

| Event | Description |
|-------|-------------|
| **Permission Request** | An agent is waiting for you to approve or deny a sensitive operation. This is often the most important notification to keep enabled, since a blocked permission request can stall an agent's progress. |
| **Agent Stopped** | An agent has finished its mission or exited. Useful for knowing when a long-running task completes. |
| **Agent Idle** | An agent has been idle for an extended period without producing output. May indicate the agent is stuck or waiting for input. |
| **Agent Error** | An agent encountered a fatal error and stopped unexpectedly. |

### Sound Control

Notification sounds can be toggled independently from visual notifications. Use the **Enable notification sounds** toggle to control whether Clubhouse plays an audio alert when a notification fires. When disabled, notifications still appear as system banners but without sound.

## macOS Notification Permission

Clubhouse uses the macOS notification system to deliver alerts. On first launch, macOS may prompt you to grant notification permission. If you dismissed this prompt or need to change the setting later:

1. Open **System Settings > Notifications** on your Mac.
2. Find **Clubhouse** in the application list.
3. Enable or configure notifications as desired.

A **Test Notification** button is available in Clubhouse's notification settings. Use it to verify that notifications are working correctly and that macOS permissions are properly configured.

## Badge Settings

Badges are small indicator dots that appear on icons in the Clubhouse interface to signal pending items or activity. Badge settings are located in **Settings > Notifications**, under the **Badges** section.

### Plugin Badges

Plugins can generate badge indicators to draw your attention -- for example, a plugin might show a badge when there is unread content. Use the **Show plugin badges** toggle to enable or disable badge indicators from all plugins.

### Project Rail Badges

When enabled, **project rail badges** appear as small indicators on project icons in the Project Rail sidebar. These badges aggregate information from all sources within that project (agents, plugins, and other events), giving you an at-a-glance summary of which projects need attention.

### Per-Project Badge Overrides

You can customize badge behavior for individual projects:

1. Right-click a project icon in the Project Rail, or open the project's settings.
2. Find the **Badge** configuration.
3. Override the default badge behavior for that specific project -- for example, you may want to suppress badges for a project you are not actively working on.

### Clear All Badges

If badge indicators have accumulated and you want a fresh start, use the **Clear All Badges** button in the badge settings. This resets all badge indicators across all projects and plugins. It is a one-time action; new badges will appear again as events occur.

## Dock Badge

Clubhouse displays a **dock badge** on the application icon in the macOS Dock. The badge shows a count of pending items that need your attention, such as permission requests waiting for approval. This allows you to see at a glance whether any agents need input, even when Clubhouse is not the foreground application.

The dock badge count updates in real time and clears automatically when you address the pending items.
