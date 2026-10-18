# ACP fixtures

## `schema-v1.26.0/`

`schema.json` and `meta.json` from
[agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)
`schema/v1/` at tag `schema-v1.26.0` (commit `3fdcc2cb717e1dfa50f2efcaeae88cb69a6504cd`), unmodified.

- `schema.json` sha256 `4bcd1d2051ff7ed379bd9b234fb9b09c5ab9245478698e9fab805bd9b52a33a6`
- `meta.json` sha256 `061edb6efa8fb2aa2792459a86ec7268de5fe665bba48b2ffe7939df01481f88`

`acp-schema.test.ts` checks the constants in `acp-schema.ts` against these files. To move to a new
schema version, replace both files, update `ACP_SCHEMA_VERSION`, and fix whatever the test reports.

## `copilot-cli/`

Real `copilot --acp` transcripts recorded on 2026-10-16 for docs/structured-chat-research.md, one
JSON-RPC message per line: `{"dir":"out"|"in","msg":{...}}`. `out` is client → agent. The probes
ran without `--no-auto-update`, so the brew shim moved from 1.0.92 to 1.0.98 between recordings.
The driver doesn't pass that flag either (#2154): with it, the Homebrew/WinGet shim runs the runtime
bundled in the shim instead of the installed Copilot, so chat and Terminal would differ.
The version column is what each handshake reports.

| File | Copilot | What it covers |
|---|---|---|
| `handshake-list-close.jsonl` | 1.0.92 | `initialize`, `session/new`, `session/list`, an invalid `set_mode`, an unknown method, `session/close` |
| `method-coverage.jsonl` | 1.0.98 | `set_config_option`, legacy `set_model`, `set_mode`, the unsupported `resume` / `fork` / `$/cancel_request`, `list` with `cwd`, `authenticate`, `close`, `load` of an unpersisted session |
| `one-prompt.jsonl` | 1.0.98 | One paid prompt on `gpt-5-mini`: thought and message chunks, an edit `tool_call` with a diff, `session/request_permission`, `tool_call_update`, `usage_update`, and the prompt result with token usage |
| `load-replay.jsonl` | 1.0.98 | A fresh process running `session/load` on the session above, which replays its history |
| `delete-unsupported.jsonl` | 1.0.98 | `session/delete` answering -32601 |
| `autopilot-task-complete.jsonl` | 1.0.98 | Recorded 2026-10-18 (#2191), `claude-haiku-4.5`. `set_mode` to autopilot, then one prompt that creates three files: the whole autopilot loop runs inside `session/prompt`, ends with a `task_complete` tool call, and nothing arrives after the answer |
| `background-agent.jsonl` | 1.0.98 | Recorded 2026-10-18 (#2191), `claude-haiku-4.5`. The agent starts a background subagent (`sleep 30; ls`), says STARTED, and is told to report when notified. 1.0.98 holds `session/prompt` open until the subagent finishes and the follow-up (`read_agent`, a file edit, two permission requests) is done |

For #2191, tests also replay `background-agent.jsonl` with the prompt's answer moved to right after
STARTED (`promptAnsweredEarly` in `acp-replay.ts`). That is the order Copilot 1.0.82 used: it answered
`end_turn` while the background subagent ran, then worked on its own when it finished, with no end
signal. The edited order comes from 1.0.82's own session log, not a wire recording.

Edits made when committing:

- Local paths are replaced with `/workspace/project`, and the Copilot install path with `/usr/local/bin/copilot`.
- `session/list` results listed every Copilot session on the recording machine. They are replaced
  with three synthetic sessions (two in `/workspace/project`, one in `/workspace/other`).
- Timestamps are dropped, and the one-prompt recording is split at its respawn into
  `one-prompt.jsonl` and `load-replay.jsonl`.

Re-recording costs a real prompt, so it is a manual maintainer step on their own login (CI never
sends prompts). The probe scripts live with the research notes, not in the repo.
