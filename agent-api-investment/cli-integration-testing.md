# CLI Integration Testing Strategy

## Problem

We construct CLI invocations for multiple orchestrators (Claude Code, Copilot CLI, OpenCode) using flags discovered from docs, `--help` output, or experimentation. These assumptions break silently:

| What broke | Provider | How we found out |
|---|---|---|
| `--permission-mode dontAsk` | Claude Code | Process crashed on spawn, no output, headless agent stuck on "Starting..." |
| `--system-prompt` (missing flag) | Copilot CLI (gh copilot) | Flag doesn't exist; system prompt has to be baked into `-p` prompt |
| `--output-format stream-json` event shape | Claude Code | `content_block_stop` doesn't repeat block type; our mapper missed post_tool events |
| `--verbose` changes output format entirely | Claude Code | With `--verbose`, events are conversation-level (`assistant`/`user`/`result`) not streaming (`content_block_start`/`delta`/`stop`). Tool use is nested in `assistant.message.content[]` as `{type:"tool_use", name, input}`. Text is `{type:"text", text}`. Our parser expected the streaming format and found 0 matching events despite 48+ events in the transcript. |
| `CLAUDECODE` env var blocks nested sessions | Claude Code | Spawned process inherits env from parent Electron app (which runs inside Claude Code during dev). Claude Code detects `CLAUDECODE` and refuses to start: "cannot be launched inside another Claude Code session". 0 bytes written to stdout, process exits silently. Transcript files created but empty. |
| `--output-format stream-json` requires `--verbose` | Claude Code | Process exits immediately with error: "When using --print, --output-format=stream-json requires --verbose". Added in a newer Claude Code version — previously stream-json worked without --verbose. |

Unit tests mock `child_process.spawn` and never actually invoke the binary, so these bugs survive CI and only surface during manual testing on a real machine.

---

## What We're Assuming Works

### Claude Code (`claude`)

**PTY mode (interactive terminal):**
```bash
claude --model sonnet \
  --allowedTools Read --allowedTools Write --allowedTools Edit \
  --append-system-prompt "You are a quick agent..." \
  "Fix the login bug"
```

**Headless mode (`-p` print/pipe):**
```bash
CLAUDE_AUTO_ACCEPT_PERMISSIONS=1 \
claude -p "Fix the login bug" \
  --output-format stream-json \
  --verbose \
  --model sonnet \
  --allowedTools Read --allowedTools Write \
  --disallowedTools Bash \
  --append-system-prompt "You are a quick agent..." \
  --max-turns 30 \
  --max-budget-usd 1.00 \
  --no-session-persistence
```

**Assumptions about stream-json output format:**
- Events are JSONL (one JSON object per line on stdout)
- Event types include: `system`, `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `result`
- `content_block_start` for tool_use has `{ content_block: { type: "tool_use", name: "Read", ... } }`
- `content_block_stop` does NOT repeat the `content_block` — only has `{ index: N }`
- `result` has `{ result: "...", cost_usd: N, duration_ms: N, is_error: bool }`
- `CLAUDE_AUTO_ACCEPT_PERMISSIONS=1` env var skips all permission prompts

**Environment variable assumptions:**
- `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` must be UNSET before spawning — Claude Code refuses to start if it detects it's inside another Claude Code session. Our Electron app inherits these from the dev environment (running under Claude Code). Fix: `delete env.CLAUDECODE` before `spawn()`.

**Config file assumptions:**
- `.claude/settings.local.json` — hooks config written here
- `.claude/CLAUDE.local.md` — local instructions (falls back to `CLAUDE.md`)
- Hook events arrive via HTTP POST to our hook server (PreToolUse, PostToolUse, Stop, etc.)

### Copilot CLI (`gh copilot`)

**PTY mode:**
```bash
gh copilot --model gpt-4o -p "System instructions here\n\nFix the login bug"
```

**Assumptions:**
- No `--system-prompt` flag; system prompt must be prepended to `-p` prompt
- No `--allowedTools` equivalent; permissions not configurable
- No headless/stream-json support
- No hook system
- Model flag: `--model`

### OpenCode (`opencode`)

**PTY mode:**
```bash
opencode "Fix the login bug"
```

**Assumptions:**
- Mission is a positional argument
- No model flag, no permission flags, no output format flag
- No headless support
- No hook system
- Config at `.opencode/config.json`, instructions at `.opencode/instructions.md`

---

## Testing Strategy

### Tier 1: Flag Validation (no API key needed)

Run each binary with `--help` or `--version` and parse the output to verify flags exist. This catches "flag doesn't exist" errors without making any API calls.

```typescript
// Pseudocode
describe('Claude Code flag validation', () => {
  it('supports -p flag', async () => {
    const { stdout } = await exec('claude --help');
    expect(stdout).toContain('-p');
  });

  it('supports --output-format', async () => {
    const { stdout } = await exec('claude --help');
    expect(stdout).toContain('--output-format');
  });

  it('supports --allowedTools', async () => {
    const { stdout } = await exec('claude --help');
    expect(stdout).toContain('--allowedTools');
  });

  // etc. for each flag we use
});
```

**Implementation notes:**
- Skip if binary not found (CI won't have these installed)
- Tag tests as `@integration` so they don't run in normal `npm test`
- Run via `npm run test:integration` or a CI job with the binaries installed
- Cache `--help` output per binary to avoid repeated spawns

### Tier 2: Dry-Run / Minimal Invocation

Invoke the binary with a trivial prompt and verify the output format, without doing real work. For Claude Code:

```bash
# Verify stream-json format structure with a no-op prompt
claude -p "Reply with just the word OK" \
  --output-format stream-json \
  --max-turns 1 \
  --no-session-persistence
```

Parse the output and verify:
- First event is `system` or `message_start`
- At least one `content_block_start` with `type: "text"`
- Ends with a `result` event
- `result` has `cost_usd`, `duration_ms`, `is_error` fields

For env poisoning (nested session detection):
```bash
# Simulate the Electron app environment where CLAUDECODE is set
CLAUDECODE=1 claude -p "Reply with just the word OK" \
  --output-format stream-json \
  --max-turns 1 \
  --no-session-persistence
# Expected: exits with error about nested sessions, 0 bytes on stdout
# This is what our app hits when dev-testing inside Claude Code

# Verify our fix works: unset the var
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
  claude -p "Reply with just the word OK" \
  --output-format stream-json \
  --max-turns 1 \
  --no-session-persistence
# Expected: stream-json events on stdout, exits cleanly
```

For tool use verification:
```bash
claude -p "Read the file ./README.md and reply with its first line" \
  --output-format stream-json \
  --max-turns 2 \
  --allowedTools Read \
  --no-session-persistence
```

Verify:
- At least one `content_block_start` with `type: "tool_use"` and `name: "Read"`
- Corresponding `content_block_stop` has matching `index` but NO `content_block`
- This is the exact event shape our `mapToHookEvent` relies on

### Tier 3: Permission / Env Var Verification

Test that permission-skipping mechanisms work:

```bash
# Should succeed without prompting
CLAUDE_AUTO_ACCEPT_PERMISSIONS=1 \
claude -p "Create a file called /tmp/clubhouse-test-$RANDOM and delete it" \
  --output-format stream-json \
  --max-turns 3 \
  --no-session-persistence
```

Verify the process completes without hanging (set a timeout).

### Tier 4: Config File Tests

Write config files and verify the binary reads them:

```bash
# Write a hooks config, spawn with a prompt that triggers a tool,
# verify our hook server receives the HTTP POST
mkdir -p /tmp/test-project/.claude
echo '{"hooks":{"PreToolUse":[...]}}' > /tmp/test-project/.claude/settings.local.json
claude -p "Read README.md" --no-session-persistence
# Check hook server received the event
```

---

## Scaffolding Design

```
src/
  main/
    orchestrators/
      __integration__/           # Integration test directory
        helpers.ts               # Binary detection, skip logic, temp dirs
        claude-code.test.ts      # Tier 1-4 for Claude Code
        copilot-cli.test.ts      # Tier 1-2 for Copilot
        opencode.test.ts         # Tier 1 for OpenCode
        stream-json-schema.ts    # JSON schema for stream-json event validation
```

### helpers.ts

```typescript
import { execFile } from 'child_process';
import { findBinaryInPath } from '../shared';

export function skipIfMissing(binaryName: string) {
  try {
    findBinaryInPath([binaryName], []);
  } catch {
    return true; // skip
  }
  return false;
}

export async function captureStreamJson(
  binary: string,
  args: string[],
  opts?: { timeout?: number; env?: Record<string, string> }
): Promise<{ events: any[]; exitCode: number; stderr: string }> {
  // Spawn process, collect JSONL lines from stdout, return parsed events
  // Timeout default: 30s
}

export function assertEventShape(event: any, type: string, extraChecks?: (e: any) => void) {
  expect(event.type).toBe(type);
  extraChecks?.(event);
}
```

### Running

```bash
# Only runs if binaries are installed; skips gracefully otherwise
npm run test:integration

# In CI: install binaries first, set API keys as secrets
# ANTHROPIC_API_KEY=sk-... npm run test:integration
```

### vitest config addition

```typescript
// vitest.integration.config.ts
export default defineConfig({
  test: {
    include: ['src/**/__integration__/**/*.test.ts'],
    testTimeout: 60_000, // CLI calls can be slow
  },
});
```

---

## What This Would Have Caught

| Bug | Which tier catches it | How |
|---|---|---|
| `--permission-mode dontAsk` invalid | Tier 1 (help parsing) or Tier 2 (dry-run exits with error) | Help output wouldn't list `dontAsk` as valid value |
| Copilot missing `--system-prompt` | Tier 1 (help parsing) | Flag absent from `gh copilot --help` |
| `content_block_stop` shape mismatch | Tier 2 (tool use invocation) | Parse actual events, assert shape |
| `CLAUDE_AUTO_ACCEPT_PERMISSIONS` not working | Tier 3 | Process hangs → timeout |
| `CLAUDECODE` env var blocks nested spawn | Tier 2 (env poisoning test) | Spawn with `CLAUDECODE=1` produces 0 stdout bytes and non-zero exit |
| Hooks config format wrong | Tier 4 | Hook server never receives event |
| `stream-json` requires `--verbose` | Tier 2 (dry-run) | Process exits with error instead of producing stream-json events |

---

## Open Questions

- **API cost**: Tier 2+ tests make real API calls. Budget ~$0.01-0.05 per run. Could use cheapest model (`haiku`) and `--max-turns 1` to minimize.
- **CI environment**: Need binaries installed. Could use Docker images or install scripts. Claude Code installs via npm (`npm i -g @anthropic-ai/claude-code`), Copilot via `gh extension install github/gh-copilot`.
- **Rate limits**: Running many tests sequentially could hit rate limits. Add delays or parallelize carefully.
- **Versioning**: Flags change between versions. Tests should log the binary version (`claude --version`) so failures can be correlated with updates. Could also pin versions in CI.
- **Snapshot testing**: Capture the `--help` output as a snapshot. When it changes, the diff shows which flags were added/removed/renamed — an early warning that our assumptions may need updating.
