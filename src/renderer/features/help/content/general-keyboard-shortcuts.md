# Keyboard Shortcuts

Clubhouse provides keyboard shortcuts for common actions. These shortcuts apply to the application frame. Agent terminal sessions handle their own keyboard input independently -- standard shortcuts like Cmd+C inside an agent terminal interact with the terminal, not the app.

On macOS, shortcuts use the `Cmd` key. On Windows and Linux, substitute `Ctrl` for `Cmd`.

## Application Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+,` | Open Settings |
| `Cmd+1` through `Cmd+9` | Switch to the 1st through 9th project in the Project Rail |

## Edit Menu Shortcuts

These are standard system edit shortcuts provided by the application menu:

| Shortcut | Action |
|----------|--------|
| `Cmd+Z` | Undo |
| `Shift+Cmd+Z` | Redo |
| `Cmd+X` | Cut |
| `Cmd+C` | Copy |
| `Cmd+V` | Paste |
| `Cmd+A` | Select All |

## View Menu Shortcuts

These are standard system view shortcuts provided by the application menu:

| Shortcut | Action |
|----------|--------|
| `Cmd+R` | Reload the window |
| `Cmd+Shift+I` | Toggle Developer Tools (available in development mode) |
| `Ctrl+Cmd+F` | Toggle full screen |
| `Cmd+M` | Minimize the window |

## Window Menu Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+W` | Close the window |

## Notes

- **Agent terminals**: When an agent terminal has focus, keyboard input goes to the terminal process, not to Clubhouse. Standard app shortcuts like `Cmd+,` still work because they are handled at the application menu level, but text input and editing shortcuts apply to the terminal.
- **Platform differences**: On Windows and Linux, replace `Cmd` with `Ctrl` in all shortcuts listed above. Some view menu shortcuts may differ slightly based on the platform.
