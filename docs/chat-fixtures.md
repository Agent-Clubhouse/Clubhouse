# Chat protocol fixtures

Native chat drives three CLI protocols over stdio:

| Fixture folder | `protocol` | CLI and mode |
|---|---|---|
| `test/chat-fixtures/claude/` | `claude-stream-json` | `claude -p --input-format stream-json --output-format stream-json` plus the control protocol (what the Agent SDK spawns) |
| `test/chat-fixtures/codex/` | `codex-app-server` | `codex app-server` v2 JSON-RPC (no `jsonrpc` field) |
| `test/chat-fixtures/copilot/` | `acp` | `copilot --acp` (Agent Client Protocol v1) |

CI never sends a real prompt (docs/structured-chat-research.md §8, decision 4). Drivers are tested by replaying fixtures through a fake CLI instead. This page covers the format, the tools, and how to record a new fixture.

## Tools

- `scripts/chat-fixtures/fake-cli.mjs` replays a fixture over stdio. It behaves like the real CLI process: drivers spawn it, write requests to its stdin and read its stdout.
- `scripts/chat-fixtures/record.mjs` captures a session with a real CLI into a fixture.
- `scripts/chat-fixtures/fixture-format.mjs` holds the format, matching and redaction code both share.
- `src/main/orchestrators/adapters/testing/fake-cli.ts` is the vitest helper: `createFakeCli`, `writeFakeCliShims`, `EventLog` and `NdjsonPeer`.
- `src/main/orchestrators/adapters/fixture-replay.test.ts` drives `AcpClient`, `CodexAppServerClient`, a stream-json peer and the `copilot_acp` `ChatDriver` through the committed fixtures. `src/main/chat/claude/fixture-replay.test.ts` does the same for `ClaudeStreamTransport` and its normalizer. Start there for examples.
- `e2e/chat-fake-cli.ts` installs fake `claude`/`codex`/`copilot` executables on the app's PATH for Playwright.
- `src/main/orchestrators/adapters/testing/chat-script.ts` builds fixtures from scripted turns at run time (tool images, Copilot binary results and their session journal, Markdown with paths, AskUserQuestion, held turns). The rich chat E2E specs use it; see docs/testing/chat-e2e-plan.md.

## Format

A fixture is JSONL. The first line is a header:

```json
{"kind":"header","format":"clubhouse-chat-fixture","version":1,"protocol":"codex-app-server","cli":{"name":"codex","version":"0.159.3","versionOutput":"codex-cli 0.159.3"},"source":"recorded","recordedAt":"2026-10-16T20:00:00.000Z","args":["app-server"],"description":"One turn with a file change approval."}
```

Every other line is an entry, in wire order:

```json
{"from":"client","t":5,"msg":{"id":1,"method":"initialize","params":{}}}
{"from":"cli","t":125,"msg":{"id":1,"result":{"userAgent":"…"}}}
{"from":"cli","t":130,"raw":"WARN something that is not JSON"}
{"from":"cli","t":131,"stderr":"text written to stderr"}
{"from":"cli","t":900,"exit":{"code":1}}
{"from":"client","t":40,"msg":{"id":0,"result":{"decision":"accept"}},"match":{"result":{"decision":"accept"}}}
{"kind":"note","text":"Free-form comment, ignored by replay."}
```

- `from: "client"` is what the driver writes to the CLI's stdin. `from: "cli"` is what the CLI writes.
- `t` is milliseconds since the session started. It is optional in hand-made fixtures.
- A CLI entry carries exactly one of `msg` (a JSON line on stdout), `raw` (a non-JSON stdout line), `stderr`, or `exit`.
- `cli.versionOutput` is what `--version` prints, so version probes see the recorded CLI.
- `synthesized` (optional) lists the shapes in a hand-made fixture that no capture backs. A recording that covers them should replace the fixture.

## Replay rules

The fake CLI walks the entries in order:

- **CLI entries** are written immediately. With `--fake-speed 1` the recorded gaps are kept (capped by `--fake-max-delay-ms`); the default of 0 replays instantly.
- **Client entries** block until the driver sends a message, which must match:
  - The protocol-level key must be equal: the JSON-RPC method, or "response" for an answer to a CLI request; for Claude, the `type` plus the control `subtype`.
  - If the entry has `match`, that partial object must also be contained in what was sent. Use it to pin the decision in an approval (approve vs deny fixtures), not to pin prompt text.
- **Ids are remapped.** Drivers number their own requests. When a client request matches, its live id (JSON-RPC `id`, or Claude's `request_id`) replaces the recorded one in the response. Requests the CLI starts keep their recorded ids, since the driver echoes those back.
- **A mismatch** writes `fake-cli: fixture mismatch at <file>:<line>: <reason>` to stderr and exits with code 3. `--fake-lenient` skips non-matching client messages instead.
- When the fixture runs out without an `exit` entry, the fake stays up until stdin closes, like a real CLI between turns. Messages sent after that are listed in the report as `unexpected`.
- Unknown arguments (`app-server`, `--acp`, `-p …`) are accepted and listed in the report's `argv`, so a test can check how the CLI was launched.

`--fake-report <file>` (or `CLUBHOUSE_FAKE_CLI_REPORT`) gets a JSON progress report, rewritten after every step: `consumed`/`total`, `complete`, `mismatch`, `unexpected`, `argv`, `exitCode`. Tests should assert `complete` and a null `mismatch` at the end, otherwise a driver that stops early still passes.

Every option also has an environment variable (`CLUBHOUSE_FAKE_CLI_FIXTURE`, `_SPEED`, `_MAX_DELAY_MS`, `_LENIENT=1`), for launchers such as the Agent SDK's `pathToClaudeCodeExecutable` that don't let you add arguments.

## Using it in tests

```ts
const fake = await createFakeCli(chatFixturePath('codex', 'permission-deny'), { cliArgs: ['app-server'] });
const client = new CodexAppServerClient({ binary: fake.binary, args: fake.args, onServerRequest, onNotification });
await client.start();
// …drive the turn…
const report = await fake.waitForReport();
expect(report.mismatch).toBeNull();
expect(report.complete).toBe(true);
await fake.dispose();
```

A chat driver test can assert on what the driver emits rather than on raw protocol traffic. `EventLog.fromAsyncIterable` collects a `ChatDriverSession`'s `events` in the background:

```ts
const drafts = EventLog.fromAsyncIterable(session.events);
await session.send(/* … */);
await drafts.waitFor({ type: 'turn_ended' });
expect(drafts.types()).toContain('protocol_unknown'); // schema-drift fixtures
```

`waitFor` resumes after its previous match, and fails at once if the stream ends without a match.

`writeFakeCliShims(dir, { codex: { fixture } })` writes an executable named `codex` (`codex.cmd` on Windows) for code that finds the CLI on PATH. On Windows that also exercises the cmd.exe route real npm installs take.

## Committed fixtures

Each CLI has seven hand-made fixtures, plus two Claude-only ones, shaped on the probe captures and generated schemas from the research (Claude Code 2.1.300, Codex 0.159.3, Copilot 1.0.92):

| Name | Covers |
|---|---|
| `multi-turn` | Handshake, then two turns with streamed text and usage |
| `interrupt` | A running tool call stopped by the client (`interrupt`, `turn/interrupt`, `session/cancel`) |
| `permission-approve-edit` | An edit approval that the client allows, with the resulting diff |
| `permission-deny` | A shell command approval that the client denies |
| `turn-error` | A failed request or turn, then recovery |
| `schema-drift` | Unknown event types and fields, an unknown CLI→client request the driver must refuse, and a stray non-JSON stdout line |
| `session-info` | Session metadata: Claude's `system/init` (after the first prompt, then again with a new model), Codex `thread/name/updated` on two turns, ACP `session_info_update` titles and `session/close` |
| `ask-user-question` (Claude) | `AskUserQuestion` with two questions, the second `multiSelect`, answered through `can_use_tool` with `answers` in `updatedInput` |
| `subagent-task` (Claude) | A `Task` subagent: `task_started`/`task_progress`/`task_notification`, and its messages, partials and tool calls tagged with `parent_tool_use_id` |

Hand-made fixtures are approximations: field sets were taken from real captures, but they weren't recorded end to end. Replace them with recordings as each driver lands, and keep the hand-made `schema-drift` ones, since no real session produces those on purpose.

### Synthesized, not recorded

Some shapes in the hand-made fixtures have no capture behind them at all; they come from SDK types and docs. Each fixture lists them in its header's `synthesized` field. Record a real session for these first, and replace the fixture when you do:

| Fixture | Synthesized |
|---|---|
| `claude/ask-user-question` | The `updatedInput.answers` format (keyed by question text, multiSelect labels joined with `", "`), the tool_result text and the `tool_use_result` shape |
| `claude/subagent-task` | The `task_started` / `task_progress` / `task_notification` field sets and the Task `tool_use_result` shape |

If the recording disagrees, change the driver to match the recording. The fixture and the replay test that encode the old guess change with it.

## Recording a fixture

Recording spends real tokens on your own login. Keep sessions tiny: the cheapest model, one-word answers, one or two turns. Never record in CI.

The recorder runs in one of two modes.

**Script mode** (`--script steps.jsonl`): the recorder is the driver. Steps are:

```json
{"send": <message>}
{"await": <partial message>, "save": "name", "timeoutMs": 120000}
{"sleep": 500}
{"close": true}
```

`"{{name.path}}"` in a sent message is filled from a saved message. A string that is only a placeholder keeps the value's type, so `"{{ask.id}}"` stays a number. `last` always refers to the most recent `await`.

**Proxy mode** (no `--script`): the recorder sits between any driver and the CLI, passing traffic through and recording it. Point a client's binary at it, or wrap it for the Agent SDK:

```sh
#!/bin/sh
# record-claude.sh (use as pathToClaudeCodeExecutable)
exec node /path/to/Clubhouse/scripts/chat-fixtures/record.mjs \
  --protocol claude-stream-json --cli-version "$(claude --version)" \
  --out /tmp/claude-session.jsonl -- claude "$@"
```

### Codex

```jsonl
{"send":{"id":1,"method":"initialize","params":{"clientInfo":{"name":"clubhouse","title":"Clubhouse","version":"1.0.0"},"capabilities":{}}}}
{"await":{"id":1}}
{"send":{"method":"initialized"}}
{"send":{"id":2,"method":"thread/start","params":{"cwd":"/path/to/scratch/repo","model":"<cheapest model from model/list>","approvalPolicy":"on-request","sandbox":"workspace-write"}}}
{"await":{"id":2},"save":"thread"}
{"send":{"id":3,"method":"turn/start","params":{"threadId":"{{thread.result.thread.id}}","input":[{"type":"text","text":"Reply with the word ok.","text_elements":[]}]}}}
{"await":{"method":"turn/completed"}}
```

```sh
node scripts/chat-fixtures/record.mjs --protocol codex-app-server --cli-name codex \
  --cli-version "$(codex --version)" --description "One turn, plain reply" \
  --out test/chat-fixtures/codex/one-turn.jsonl --script steps.jsonl -- codex app-server
```

For an approval, add `{"await":{"method":"item/commandExecution/requestApproval"},"save":"ask"}` and `{"send":{"id":"{{ask.id}}","result":{"decision":"decline"}}}`.

### Copilot

Launch it the way the driver does, `copilot --acp --stdio` without `--no-auto-update`: that flag makes the Homebrew/WinGet shim run its bundled runtime instead of the installed Copilot (#2154), so `--cli-version` would be wrong. Pick the cheapest model in the `session/new` result (each entry's `_meta.copilotUsage` is its premium-request multiplier) and set it with `session/set_config_option` (`configId: "model"`) before the prompt. Approvals arrive as `session/request_permission`; answer with `{"outcome":{"outcome":"selected","optionId":"allow_once"}}` or `reject_once`.

```sh
node scripts/chat-fixtures/record.mjs --protocol acp --cli-name copilot \
  --cli-version "$(copilot --version)" --out test/chat-fixtures/copilot/one-turn.jsonl \
  --script steps.jsonl -- copilot --acp --stdio
```

### Claude Code

Pass `--permission-mode default` so every ask reaches `can_use_tool`, and `--model haiku`. The handshake is an `initialize` control request.

```jsonl
{"send":{"type":"control_request","request_id":"req_1","request":{"subtype":"initialize"}}}
{"await":{"type":"control_response"}}
{"send":{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"Reply with the word ok."}]},"parent_tool_use_id":null}}
{"await":{"type":"result"}}
```

```sh
node scripts/chat-fixtures/record.mjs --protocol claude-stream-json --cli-name claude \
  --cli-version "$(claude --version)" --out test/chat-fixtures/claude/one-turn.jsonl \
  --script steps.jsonl -- claude -p --input-format stream-json --output-format stream-json \
  --verbose --permission-prompt-tool stdio --permission-mode default --model haiku
```

Approvals arrive as `{"type":"control_request","request":{"subtype":"can_use_tool",…}}`; answer with a `control_response` carrying `{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny","message":"…"}` under the same `request_id`.

### Free recordings

A handshake-only script (initialize, then close) should send no model request. The credential-free handshake spike (docs/structured-chat-research.md §8) confirms this per CLI; until it has, check your usage page after the first one. Use these to refresh handshake fields after a version bump.

### Before committing

By default the recorder replaces the current directory with `/workspace/project`, your home directory with `/home/user` and the temp directory with `/tmp`, each both as given and as its resolved real path (`/private/var/…` on macOS). It also scrubs key-, token- and email-shaped strings (`SECRET_REDACTIONS` in `fixture-format.mjs`). Add `--redact <from>=<to>` or `--redact-regex <pattern>=<to>` for anything else. Pattern matching can't catch everything, so read the file. Things that come from your machine:

- Claude's `initialize` response includes your account email, organization and plan, plus your slash commands, agents, skills and MCP servers.
- Copilot's `authMethods` can include the CLI install path, and its command list includes your skills.
- Codex's `userAgent` and `codexHome`, and any MCP server names.
- Session titles and file contents from the scratch repo.

Trim long lists (commands, models) to a few entries, and add `match` to client entries where the fixture's point is a decision (approve vs deny). Run `npx vitest run --project main scripts/chat-fixtures` to check the fixture parses and passes the leak guard. The guard fails on home paths other than `/home/user`, Anthropic keys, GitHub and bearer tokens, and email addresses outside `example.com`. Then write a test that replays it.

### Refreshing after a CLI version bump

Re-record the fixtures for that CLI with the new pinned version, diff them against the old ones, and update drivers for any shape changes. New fields and event types usually show up here first; keep a `schema-drift` case for anything a driver must tolerate.
