# Keyboard Shortcuts

On macOS, shortcuts use `Cmd`. On Windows/Linux, substitute `Ctrl`.

All shortcuts except the feedback capture shortcut are customizable in **Settings > Keyboard Shortcuts**.

## Global Shortcuts

These work even when focus is in a text input:

| Shortcut | Action |
|----------|--------|
| `Cmd+K` | Open Command Palette |
| `Cmd+Shift+N` | New Quick Agent |

## Command Palette Filters

Open `Cmd+K`, then type a prefix:

| Prefix | Filters To |
|--------|-----------|
| `@` | Agents |
| `/` | Projects |
| `#` | Canvases |
| `>` | Commands & Settings |

## App Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+,` | Toggle Settings |
| `Cmd+Shift+/` | Toggle Help |
| `Cmd+Shift+H` | Go to Home |
| `Cmd+B` | Toggle Sidebar |
| `Cmd+Shift+B` | Toggle Accessory Panel |

## Agents & Projects

| Shortcut | Action |
|----------|--------|
| `Cmd+1` – `Cmd+9` | Switch to Agent 1–9 |
| `Cmd+Option+1` – `Cmd+Option+9` | Switch to Project 1–9 |
| `Cmd+Shift+O` | Add Project |
| `Cmd+Shift+T` | Focus Active Terminal — an escape hatch for terminal-focus issues under Copilot CLI's mouse tracking |
| `Cmd+Shift+W` | Close Project |
| `Cmd+Enter` | Submit Quick Agent dialog |

## Standard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Z` / `Shift+Cmd+Z` | Undo / Redo |
| `Cmd+X` / `Cmd+C` / `Cmd+V` | Cut / Copy / Paste |
| `Cmd+A` | Select All |
| `Cmd+W` | Close Window |
| `Ctrl+Cmd+F` | Toggle Fullscreen |

## Feedback

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+2` | Capture a feedback screenshot of every Clubhouse window, then review it |

This one lives in the app menu (**Help > Capture Feedback Screenshot**), so it captures before anything on screen reacts to the key: tooltips and hover states stay in the screenshot. It works from pop-out windows, only while Clubhouse is focused, and only once feedback is set up. It can't be changed in **Settings > Keyboard Shortcuts** yet. On Windows/Linux, `Ctrl+Shift+2` won't reach an agent terminal while Clubhouse is focused.

## Notes

- **Agent terminals** capture keyboard input — app shortcuts like `Cmd+K` still work, but typing goes to the terminal process.
- Changes to keybindings take effect immediately.
