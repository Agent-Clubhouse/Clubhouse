# Usage attribution

Where token use goes, per agent, from what providers report. Two parts:

- **In the app, going forward:** `core:usage` log lines
  (`src/main/services/agent-runtime/usage-attribution-log.ts`). Every chat
  agent writes one line per finished turn: the Dispatcher, orchestrators,
  helpers, quick agents and plain agents, on any provider.
- **After the fact, Codex only:** `scripts/codex-usage-summary.mjs` reads the
  rollout files Codex keeps under `~/.codex/sessions`.

## The log lines

They go through `appLog` to the local diag tier, so the Logging settings
decide whether they are written (logging on, the `core:usage` namespace on,
level `info` or lower) and how long they are kept (the retention tier). They
are never exported. The diagnostics a feedback report carries keep only
catalogued lines, and `core:usage` has no catalog entry, so its lines are
dropped there too. Telemetry consent and export are not involved.

Each line carries:

| Field | Meaning |
| --- | --- |
| `agentId`, `role`, `parentAgentId`, `projectPath` | Who used it. `role` is `dispatcher`, `helper`, `orchestrator`, `quick`, `agent` or `unknown`. `unknown` (with no parent) means the agent config hasn't been read yet; it is looked up again on the next line |
| `sessionId`, `nativeSessionId`, `resumed` | The Clubhouse chat session, the provider's session or thread id, and whether this run continues an earlier native session |
| `driver`, `provider`, `model`, `effort` | `unknown` when not established. A model change that names no effort (a model without effort levels, or a Codex server reroute) leaves effort `unknown` rather than carrying the earlier one |
| `kind` | `turn`: one finished turn. `final`: a session's running total when it ends |
| `input`, `cachedInput`, `cacheWrite`, `output`, `reasoning` | Tokens, in the convention below. A figure the provider didn't report is absent |
| `source`, `scope`, `dedup`, `completeness`, `baseline` | Provenance, from `RunUsageTracker` (`src/main/telemetry/helper-usage-accounting.ts`) |

To total usage, add the `turn` lines. `final` lines are a cross-check. A
resumed session's final line (`baseline: lifetime`) includes earlier runs.
Never add final lines to turn lines. A turn id is logged once. Lines are
capped at 2,000 an hour; anything over the cap is counted and logged when the
hour turns.

### Not covered

- **Terminal (TUI) agents** of any provider publish no chat events and log
  nothing here. For Codex, the rollout script covers them after the fact.
  There is no equivalent for Claude Code or Copilot in a terminal.
- **Headless runs** (`codex exec`, `claude -p`) are not chat sessions and log
  nothing here. Their transcript summary
  (`src/shared/headless-transcript.ts`) and run view keep a side no event
  reported absent. The view shows "Not reported" or "unknown" for it, never 0.

## Adapter contract

Any chat driver whose protocol reports usage gets attribution by publishing
these chat events. The contract is in `src/shared/chat/events.ts`
(`TokenUsage`, `usage`, `turn_ended`).

- **Units.** Tokens, as the provider counts them. Never derive a token figure
  from cost, context fill or a limit's utilization. A protocol that only
  reports those (ACP `usage_update`: context size and cost) sends them as
  `context` and `costUsd`, with no `tokens`.
- **Input and cache.** `input` is the whole input, cache reads and writes
  included. `cachedInput` and `cacheWrite` are parts of it. If the provider
  reports input without cache (Anthropic does), add the cache figures in.
- **Reasoning.** `reasoning` is the part of `output` spent reasoning, not an
  extra amount on top of it. `total` is the provider's own total, if it
  reports one.
- **Missing or unsupported.** Leave the field out. A turn with no figures
  ends with no `usage`, and is logged as `completeness: none`, not as zeros.
- **Turn or running total.** A turn's own figures go on `turn_ended.usage`,
  or on a `usage` event with `scope: 'turn'`. Running totals go on `usage`
  with `scope: 'session'`, with a `threadId` when the provider keeps one per
  thread, and a `subagentId` when the total is a subagent's own. A running
  total is never also reported as a turn's figure.
- **Provenance.** Set `turn_ended.usageSource`:
  - `provider_turn`: the provider's own figure for the turn.
  - `summed_calls`: your sum of its per-call figures.
  - `cumulative_delta`: your difference of its running totals.

  The four existing drivers have known methods and may leave it out. Any
  other driver that leaves it out is logged as `source: unknown`.
- **Scope.** Set `coverage: 'main'` or `'inclusive'` only when the protocol
  says whether subagents are included. Otherwise leave it out
  (`unscoped`).
- **Resume and reset.** Set `session_started.resumed`. A running total that
  goes down is treated as a reset or compaction, and no delta is claimed
  across it.

| Driver | Turn figure | Running total | Source |
| --- | --- | --- | --- |
| Claude Agent SDK, stream-json | Result `usage` (main loop, `scope: main` only when the driver has measured coverage, else `unscoped`) | Per-model totals | `provider_turn` |
| Codex app-server | Difference of `thread/tokenUsage/updated` totals | Per thread | `cumulative_delta` |
| Copilot SDK | Sum of `assistant.usage` calls | Sum over the session | `summed_calls` |
| ACP (provider-neutral) | None in the pinned schema | None (context and cost only) | `unknown`, `completeness: none` |

## Codex rollout summary

```
node scripts/codex-usage-summary.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--dir <sessions>] [--json]
```

- **Codex only.** It reads `session_meta` (id, cwd, subagent parent),
  `turn_context` (model, effort) and `token_usage_record` lines, and never
  prints text, tool input or output, or instructions.
- **Counting.** Each record is one model response, counted once by its
  `response_id`. Records are grouped by their own UTC day, so a thread
  resumed on a later day counts on that day.
- **Agent.** The agent is named from its working folder: the
  `.clubhouse/agents/<name>` folder, or `Dispatcher` for
  `.clubhouse/dispatcher[-chat]`. Helper-to-parent links are not in rollouts.
- **Output.** Cached input is reported separately from uncached input. Raw
  tokens are never converted into plan percentages.
- **Cross-check.** The positive differences of each file's `token_count`
  running totals come out slightly under the records, about 0.8% on
  2026-11-17..23.
