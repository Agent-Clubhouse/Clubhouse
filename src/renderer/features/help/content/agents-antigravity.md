# Antigravity CLI

Antigravity CLI is Google's `agy` command line agent. Clubhouse runs it in chat, through its Agent Client Protocol (ACP) server, or in a terminal (the CLI view), as you choose for each agent. It is experimental and off by default. It never becomes your default agent provider, and the Dispatcher does not offer it.

This page paraphrases Google's documentation as read on 2026-11-23. Google changes these pages without dated notes, so follow the links when a detail matters to you.

## Set it up

1. **Install it.** Follow Google's [getting started guide](https://antigravity.google/docs/getting-started/), then run `agy --version` in a terminal to check that it works.
2. **Sign in once.** Run `agy` in a terminal and finish its sign-in. Chat reuses that sign-in. Over SSH or on a computer without a browser, run `agy acp --login` instead. Clubhouse does not sign in for you, and it never reads, copies or stores your Antigravity credentials.
3. **Turn it on.** It takes two steps. First switch on **Antigravity CLI** in **Settings > Experimental** and restart Clubhouse. Until then Antigravity CLI is hidden. Then open **Settings > Agents & CLIs**, where it shows an Experimental badge, and switch it on once Clubhouse finds the `agy` command. A project or agent chooses it through its **Runs on** setting like any other CLI. With both switches on, its agents open in chat; switch an agent to the CLI view if you'd rather use the terminal. Clubhouse never turns it on or picks it for you.

Clubhouse does not change Antigravity's trust list. The first time `agy` opens a folder it has not seen, it asks whether you trust that folder. A new agent folder counts as a new folder, so answer the prompt in the agent's CLI view.

## What each view needs

| View | Needs | Notes |
|------|-------|-------|
| CLI view | `agy` installed and signed in | The `agy` terminal app runs as it does in your own terminal. |
| Chat | `agy` with ACP support and a cached sign-in | Google's changelog shows `agy acp` added in 1.5.0. Chat needs 1.5.10 or newer, because earlier releases have documented ACP cancel and permission fixes, and Clubhouse checks the version before it opens chat. |
| Headless | Not offered | See **Why headless is not offered**. |

In chat, `agy` reports some errors from Google's service as an ordinary reply that ends the turn normally. Such a turn can show as finished, with the error in its text. Clubhouse does not read Antigravity's own session files to tell these apart, because their format is not documented.

Chat and the CLI view never stand in for each other. If chat can't start, the agent says so and you choose whether to retry or open it in the CLI view. Clubhouse does not replay a message into a different view.

## Why headless is not offered

Antigravity has a headless mode, `agy -p`. Google's [FAQ](https://antigravity.google/docs/faq/) says it is for direct scripting and CI, and that wrapping `agy` in third-party coding agents or applications is "not supported under consumer plans". No page we found says what other plans allow. Clubhouse does not use headless mode with Antigravity, so features that run a provider headless, such as a headless quick agent, do not run on it.

## Terms and plans

Google's pages say different things about third-party clients, and Clubhouse does not decide which one covers you. Read on 2026-11-23:

- The [FAQ](https://antigravity.google/docs/faq/) says using third-party software to access Antigravity breaks Google's Terms of Service and can lead to account suspension or termination, and recommends a Gemini Enterprise or Google AI Studio API key for third-party coding agents.
- The [ACP guide](https://antigravity.google/docs/ide/extensions/acp/) says any ACP client can launch `agy acp` in the project folder, and that it reuses the sign-in cached by an interactive `agy` session.

Clubhouse runs your own `agy`. Chat through `agy acp` is the primary way, and the CLI view is the fallback you can pick for any agent. Clubhouse does not use headless mode.

Clubhouse makes no promise about which plans, models or quotas you can use here. Read both pages and decide for yourself. Clubhouse does not rotate or switch accounts.

## Your Antigravity profile

Antigravity keeps its settings, sign-in, conversations and global customizations under `~/.gemini`. Clubhouse does not isolate them, so every Antigravity agent shares your account, your quota and your global rules, skills, hooks and MCP servers. Clubhouse never writes to `~/.gemini`.

What Clubhouse adds goes in the agent's own folder:

| File | Used for |
|------|----------|
| `AGENTS.md` | The agent's managed instructions |
| `.agents/skills/` | Managed skills |
| `.agents/mcp_config.json` | The Clubhouse MCP connection |
| `.agents/hooks.json` | Status hooks, on macOS and Linux |

On Windows Clubhouse writes no hooks. Google does not say which shell runs a hook command there, so terminal status comes only from the terminal app until that is checked, and a resumed agent always continues the most recent conversation in its folder.

Resume uses the conversation id a hook reports, and otherwise the most recent conversation in the agent's folder. Clubhouse does not list or read your Antigravity conversations or transcripts, and nothing under `~/.gemini` is scanned.

Your own entries in these files are kept, and Clubhouse restores them when the agent stops. If one of these files already has a `clubhouse` MCP server or a `clubhouse-status` hook that Clubhouse did not add, or your global Antigravity MCP settings name a `clubhouse` server, the agent does not start and says why. An agent also stops with a reason if its Clubhouse MCP connection does not sign in to Clubhouse soon after it starts. Antigravity also reads rules from parent folders, so a rules file above the agent's folder can apply too.

## Models and effort

Clubhouse shows the models the `agy` server offers your account. Google's pages disagree on one point. The ACP guide says third-party models are offered only to certain editors, and the 1.5.1 changelog says `agy acp` now offers every model your account has to every ACP client. Clubhouse shows what the server returns and does not filter it. See [models](https://antigravity.google/docs/models/).

## Access levels and Auto

Antigravity agents offer Plan, Ask first, Auto-accept edits and Full access, in chat and in the CLI view. There is no Auto level. Antigravity has its own Auto mode, which Google's [CLI reference](https://antigravity.google/docs/cli/reference/) says is not available for business or enterprise accounts, and Clubhouse does not map an Access level to it.

Smart routing never picks Antigravity today. Ask for it by name when an agent starts a helper.

## Using an API key

Antigravity can use a Gemini API key. Google's [install guide](https://antigravity.google/docs/install/) says you must set `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` and export `GEMINI_API_KEY` yourself. A key on its own has no effect, and `GOOGLE_API_KEY` or a `.env` file is not read. Clubhouse does not edit that file and does not store or pass on your key.

## If something goes wrong

- **Not found in Settings.** Make sure `agy --version` works in a terminal, then press **Check again**.
- **Chat says sign-in is needed.** Run `agy` once in a terminal, or `agy acp --login` over SSH, then retry.
- **Chat won't start.** Update `agy`. Google's changelog lists ACP fixes in most releases.
- **More detail.** `agy --version` shows the version. Antigravity writes ACP logs to `~/.gemini/antigravity-cli/log/acp-*.log`. A feedback report does not include the version, these paths or any log contents, so attach a log yourself if it helps. See **Logging and diagnostics**.

Antigravity may update itself. Google documents `AGY_CLI_DISABLE_AUTO_UPDATE=true` to turn that off, and Clubhouse does not set it.
