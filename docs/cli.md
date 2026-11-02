# The clubhouse command

Lets scripts list projects and agents and change how they look while Clubhouse is open. It covers a project's display name, color, emoji and image, and an agent's color, emoji and image. It can't rename agents or change anything else.

The Dispatcher is an agent here too. While it's on, `clubhouse agents` lists it with the project `__dispatcher__`, and `clubhouse agent set` changes its color, emoji and image. `--project` only covers registered projects, so it leaves the Dispatcher out.

## Install

In Clubhouse, go to **Settings > About > Command line tool** and choose **Install**. It needs Node.js on your PATH and no admin rights.

- **macOS and Linux:** adds a link in the first writable folder on your PATH from `~/.local/bin`, `~/bin`, `/usr/local/bin` and `/opt/homebrew/bin`. If none fits, it uses `~/.local/bin` and tells you to add that to your PATH.
- **Windows:** adds `%USERPROFILE%\.clubhouse\bin` to your user PATH. Open a new terminal afterwards.

The files live in `~/.clubhouse/bin` and update when Clubhouse starts.

On Linux the app's own program is also called `clubhouse`. The command passes anything that isn't one of its commands, including no arguments, to the app.

## Use

```sh
clubhouse projects
clubhouse agents --project "My App"
clubhouse project set "My App" --display-name "Shiny" --color rose --image ./logo.png
clubhouse agent set <agent-id> --emoji 🦊
clubhouse agent set <agent-id> --emoji ""    # an empty value clears it
```

Add `--json` for JSON output, errors included. A relative image path starts from your current folder.

A development build uses a separate folder: add `--dev` or set `CLUBHOUSE_CLI_DEV=1`. Installing is only for packaged builds, so in development run `node .webpack/main/cli/clubhouse-cli.js --dev projects`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | Something unexpected went wrong |
| 2 | The command line is wrong |
| 3 | Clubhouse isn't running |
| 4 | Clubhouse refused the change |
| 5 | No such project or agent |
| 6 | The token was refused or can't be read |
| 127 | Node.js isn't on your PATH |

## How it connects

The command talks to the running app on `127.0.0.1`, on the port of the app's local hook server. At each start the app writes the port and a new token to `cli-endpoint.json` in the Clubhouse folder, readable only by your user on macOS and Linux. On Windows the file relies on the normal permissions of your user profile folder. The file is removed when the app quits. The command never edits config files itself.

Any program running as you can read that file, including agents. That gives them nothing new, since they could already edit the same settings files.
