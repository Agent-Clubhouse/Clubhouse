# Test plan — Codex CLI argv parity batch

Verified against **codex-cli 0.153.4**, claude 2.1.261, copilot 1.0.82 (darwin arm64).

## Ground truth established against the real binary

| Invocation | Result |
|---|---|
| `codex resume <SESSION_ID> [flags] <prompt>` | parses (`resume [OPTIONS] [SESSION_ID] [PROMPT]`) |
| `codex resume --last [flags] <prompt>` | parses; positional binds to PROMPT, not SESSION_ID |
| `codex resume` accepts `-s`, `-a`, `-m`, `--dangerously-bypass-approvals-and-sandbox` | yes |
| `codex exec resume` accepts `--json`, `-m`, `-c`, `--dangerously-bypass-approvals-and-sandbox` | yes |
| `codex exec resume` accepts `-s/--sandbox` or `-a/--ask-for-approval` | **no** — `error: unexpected argument '-s' found` |
| `codex debug models` | `{ "models": [ { slug, display_name, visibility, priority, … } ] }` |

## Test cases

### TP-1 buildSpawnCommand — session resume
- resume=true, no sessionId → args start `['resume', '--last']`
- resume=true, sessionId set → args start `['resume', '<id>']`, no `--last`
- resume=false → no resume args
- resume + mission → prompt stays in `trailingArgs`, after injected flags

### TP-2 buildSpawnCommand — permissionMode
- freeAgentMode + 'skip-all' → `--dangerously-bypass-approvals-and-sandbox`; no `--sandbox`/`--ask-for-approval`
- freeAgentMode + 'auto' → `--sandbox workspace-write --ask-for-approval never`
- freeAgentMode + undefined → same as 'auto' (back-compat with #1714)
- no freeAgentMode → none of the above

### TP-3 buildHeadlessCommand — session resume
- no resume → `['exec', prompt, '--json', '--sandbox', 'workspace-write']`
- resume, no sessionId → `['exec', 'resume', '--last', prompt, '--json']`; **must not** contain `--sandbox`
- resume + sessionId → `['exec', 'resume', '<id>', prompt, '--json']`
- resume + skip-all → adds `--dangerously-bypass-approvals-and-sandbox` (valid on `exec resume`)

### TP-4 buildHeadlessCommand — permissionMode (fresh session)
- 'skip-all' → `--dangerously-bypass-approvals-and-sandbox`, no `--sandbox`
- 'auto' / undefined → `--sandbox workspace-write`

### TP-5 model discovery
- `codex debug models` JSON parsed: `visibility !== 'list'` filtered out, sorted by `priority` asc, `slug`→id, `display_name`→label, `default` prepended
- malformed / empty / non-JSON stdout → `null` → static fallback used
- static fallback refreshed to models that currently exist

### TP-6 headless resume is provider-owned (cross-provider)
- `assistant-handlers.ts` no longer appends a bare `--continue` to every provider's headless args
- Claude Code headless with `resume` → `--continue` present (no behaviour change)
- Copilot headless with `resume` → `--continue` present (no behaviour change)
- Codex headless with `resume` → `exec resume --last`, never `--continue`

## Acceptance criteria
1. Every argv combination the provider can emit parses against codex 0.153.4 (manually verified, recorded in the PR).
2. `npm run typecheck`, `npm test`, `npm run lint` all clean.
3. No change to Claude Code or Copilot emitted argv (regression-guarded by TP-6).
