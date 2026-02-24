# Command Palette

The Command Palette (`Cmd+K`) is a fuzzy-search launcher for navigating anywhere in Clubhouse. It works even when your cursor is in a text input.

## Filter Modes

Type a prefix to filter results:

| Prefix | Filters To | Example |
|--------|-----------|---------|
| *(none)* | Everything | `auth` — finds agents, projects, commands matching "auth" |
| `@` | Agents | `@feature` — jump to an agent named "feature-auth" |
| `/` | Projects | `/my-app` — switch to a project |
| `#` | Hubs | `#monitoring` — open a hub workspace |
| `>` | Commands | `>theme` — navigate to settings, run actions |

## Navigation

- **Arrow keys** — move up/down through results
- **Enter** — select the highlighted item
- **Escape** — close the palette

## Recently Used

When you open the palette with no query, it shows your most recently used items (up to 20). Recent items also get a ranking boost in search results.

## Shortcut Display

Each result shows its keyboard shortcut (if one exists), so you can learn shortcuts as you use the palette.

> **Example:** Type `Cmd+K` then `>key` to quickly jump to **Settings > Keyboard Shortcuts**.
