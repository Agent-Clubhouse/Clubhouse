# Navigation & Layout

Clubhouse uses a multi-pane layout. The number of visible columns adapts to your current context.

## Standard Layout

| Pane | Purpose |
|------|---------|
| **Project Rail** | Global nav: project icons, `+` add, `?` help, gear for settings. Always visible. |
| **Explorer Rail** | Agent list, plugin tabs for the active project. |
| **Accessory Panel** | Agent config, file browsers, Git info, plugin sidebars. |
| **Main Content View** | Agent output, plugin panels, settings pages. |

Some plugins use a "full" layout that hides the Accessory Panel for more space.

## Project Rail

From top to bottom: app-scoped plugins, project icons, `+` (add project), `?` (help), gear (settings).

- **Reorder** — Drag and drop project icons
- **Switch projects** — Click an icon or press `Cmd+Option+1` through `Cmd+Option+9`

## Explorer Rail

Context-sensitive: shows the **Agents** tab by default, plus tabs for enabled project-scoped plugins. Hidden in app-scoped plugin views.

## Quick Navigation

| Action | How |
|--------|-----|
| Switch project | `Cmd+Option+1–9` or click in Project Rail |
| Switch agent | `Cmd+1–9` or click in Explorer |
| Open anything | `Cmd+K` (Command Palette) |
| Toggle sidebar | `Cmd+B` |
| Toggle accessory panel | `Cmd+Shift+B` |

Project state (selected agent, scroll position) is preserved when switching — you pick up exactly where you left off.
