# Chat protocol fixtures

These JSONL files are replayed by `scripts/chat-fixtures/fake-cli.mjs` in place of the real CLIs, so chat tests spend no tokens. The format, replay rules and recording recipes are in [docs/chat-fixtures.md](../../docs/chat-fixtures.md).

Every fixture here is hand-made (`"source": "hand-made"` in its header). Shapes with no capture behind them are listed in the header's `synthesized` field and are **synthesized, not recorded**:

- `claude/ask-user-question.jsonl`: the `updatedInput.answers` format (keyed by question text, multiSelect labels joined with `", "`) and the tool result shapes.
- `claude/subagent-task.jsonl`: the `task_*` system event field sets and the Task tool result shape.

Replace these with real recordings as soon as one is available. Keep the `schema-drift` fixtures hand-made: no real session produces them on purpose.

A test in `scripts/chat-fixtures/chat-fixtures.test.ts` fails if any file here contains a home path, API key, token or real email address.
