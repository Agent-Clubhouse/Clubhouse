# Navigation

Clubhouse uses a multi-pane layout to organize your workspace. The interface is divided into up to four columns, each serving a distinct purpose. The number of visible columns depends on context: the Home dashboard and Help view use a simplified two-column layout, while the main project view uses three or four columns.

## Multi-Pane Layout Overview

From left to right, the standard project view contains:

| Pane | Width | Purpose |
|------|-------|---------|
| **Project Rail** | 60px (fixed) | Global navigation: projects, home, help, settings |
| **Explorer Rail** | 200px | Context-specific navigation: agent lists, plugin tabs |
| **Accessory Panel** | 280px | Detail views: agent config, file browsers, sidebars |
| **Main Content View** | Remaining space | Primary content: terminal output, plugin panels, settings |

Some plugin layouts use a "full" mode that hides the Accessory Panel and gives the Main Content View more space.

## Project Rail

The Project Rail is the leftmost column (60px wide). It is always visible regardless of which view is active. It contains the following items from top to bottom:

- **Home** -- Returns to the Home dashboard, which shows an overview of all projects and agents.
- **Project icons** -- One icon per registered project. Click an icon to switch to that project. Icons can be **reordered by dragging and dropping** them within the rail.
- **+ (Add project)** -- Opens a folder picker to register a new project.
- **? (Help)** -- Opens this help system.
- **Gear (Settings)** -- Opens the application settings panel.

App-scoped plugins that contribute a rail item also appear in the Project Rail.

## Explorer Rail

The Explorer Rail is the second column (200px wide). Its contents change depending on the active project and selected tab:

- **Agents tab** -- Lists all durable agents and the quick agent launcher for the active project. This is the default tab when you select a project.
- **Plugin tabs** -- Project-scoped plugins that contribute a tab appear here. For example, a file browser plugin or a wiki plugin each get their own tab in the Explorer Rail.

The Explorer Rail does not appear on the Home dashboard or when viewing app-scoped plugin content.

## Accessory Panel

The Accessory Panel is the third column (280px wide). It provides detail and configuration views related to the current selection in the Explorer Rail:

- **Agent configuration and status** -- When an agent is selected, this panel shows its name, color, branch, model, mission, and current status.
- **File browsers** -- Plugin-provided file tree views appear here.
- **Git information** -- Branch status, uncommitted changes, and other Git details for the active project.
- **Plugin sidebars** -- Plugins that contribute a sidebar panel render their content in this column.

The Accessory Panel is hidden when a plugin uses "full" layout mode, giving the Main Content View the extra horizontal space.

## Main Content View

The Main Content View is the largest pane, occupying all remaining horizontal space. It displays the primary content for the current context:

- **Agent terminal output** -- When a running or sleeping agent is selected, the Main Content View shows its terminal session with full scrollback.
- **Plugin main panels** -- Plugins that contribute a main panel (such as a kanban board or document editor) render here.
- **Settings pages** -- When settings is open, the various settings sub-pages (General, Updates, About, etc.) are displayed here.

## Help View

When help is open (via the `?` icon in the Project Rail), the Help View takes over the space to the right of the Project Rail. It replaces the Explorer Rail, Accessory Panel, and Main Content View with a three-column help layout:

| Column | Width | Content |
|--------|-------|---------|
| **Section Nav** | 200px | Lists help sections (General, Projects, Agents & Plugins, plus any plugin help sections) |
| **Topic List** | 240px | Lists topics within the selected section |
| **Content Pane** | Remaining space | Displays the selected help topic content |

Click any project icon or the Home button in the Project Rail to exit the Help View and return to the normal layout.

## Switching Between Projects

There are two ways to switch between projects:

- **Click** a project icon in the Project Rail.
- **Keyboard shortcut**: Press `Cmd+1` through `Cmd+9` (or `Ctrl+1` through `Ctrl+9` on non-Mac platforms) to switch to the first through ninth project in the rail, based on their current display order.

When you switch projects, Clubhouse restores the navigation state you left off with, including which Explorer tab was active and which agent was selected.
