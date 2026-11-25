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
| `agentId`, `role`, `parentAgentId`, `projectId` | Who used it. The project is named by its Clubhouse id; no line carries a path. `role` is `dispatcher`, `helper`, `orchestrator`, `quick`, `agent` or `unknown`. `unknown` (with no parent) means the agent config hasn't been read yet; it is looked up again on the next line |
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

### Totals

```
node scripts/usage-rollup.mjs [--by day,provider,role,agentId] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--dir <log folder>] [--json]
```

- **What it reads.** The `core:usage` lines in `~/.clubhouse/logs/telemetry-*.jsonl`, nothing else.
- **How it adds.** It sums the turn lines (`src/shared/usage-rollup.mjs`). Session totals are counted but never added. A turn read twice is added once. A line without a turn id is added too, but counted in `turnsWithoutId`, since a repeat of it can't be detected.
- **Unknown stays unknown.** A figure no turn reported is `null` in `--json` and `unknown` in the table, never 0; a reported 0 stays 0. `noLines` (or the message without `--json`) means no turn line was found, not zero use. Unreadable usage lines are counted in `malformed`.
- **What it shows separately.** Total, uncached and cached input, cache writes, turns that reported no usage, the turns missing each figure, and the turns per source.
- **Grouping.** `--by` picks any of `day`, `provider`, `driver`, `model`, `effort`, `role`, `agentId`, `parentAgentId` and `source`.
- **Limits.**
  - It covers only what the logging settings let through and retention kept.
  - It covers only turns that fit the recorder's diag budget.
  - A day with logging off reads as no turns, not as zero use.

### Settings › Usage

The Usage page (`src/renderer/features/settings/UsageSettingsView.tsx`) shows
the same totals inside the app, for today or the last 7 days (UTC). The main
process reads them from the local log through the same aggregator
(`src/main/services/usage-summary.ts`).

- **Plan limits.** One row per provider descriptor. A provider whose
  descriptor says `quota: 'reader'` shows its token-free reading, such as
  "62% of the weekly limit used". Every other provider, and any reading that
  failed or is unknown, shows "unknown", never a percentage.
- **Tokens used.** One row per provider. A row has turns, input (with
  cached), output and reasoning. A figure no turn reported reads "unknown".
  A provider with no lines reads "No usage logged".
- **By role.** Turns by role, covering the Dispatcher, orchestrators,
  helpers, quick agents and other agents.
- **No lines for the period.** The page says so, and says whether the
  logging settings let usage lines be written. It never shows zeros.

### Not covered

- **Terminal (TUI) agents** publish no chat events. When a terminal run ends,
  Clubhouse reads that run's usage from the CLI's own session file and logs
  one `kind: run` line (`driver: terminal`, `src/main/services/terminal-usage.ts`).
  - **What it reads.** Claude Code `assistant` usage, once per message id.
    Codex `token_usage_record` usage, once per response id, plus model and
    effort from `turn_context`. Ids, times, model, effort and counts only:
    no text, and no model call.
  - **Which file.** The session captured at exit, located by the provider's
    own `transcriptPath`.
  - **Which lines.** Only lines stamped within the run, so a resumed
    session's earlier runs are left out. The file is read backwards from its
    end, up to 256 MB. A run bigger than that is marked `partial`.
  - **Back-to-back runs.** For each session, Clubhouse remembers the last
    line a run counted and the ids it counted (in memory, for this app run).
    So a resume or restart closer than the slack doesn't count those lines
    again.
  - **Weak session ids.** A session id only scraped from the terminal's
    output isn't trusted to pick a file. The run is logged as
    `scraped_session_id`.
  - **When there are no figures.** `coverage` says why:
    - `not_supported`: Copilot and other CLIs, whose files aren't read.
    - `no_session`: the run's session wasn't found.
    - `no_usage`: the file was read, but nothing fell in the run.
    - `scraped_session_id`: see above.
    - `read_failed`.
  - **Dedup.** Claude lines dedupe by `message_id`, Codex lines by
    `response_id`.
  - **Long lines.** A line over 16 MB is dropped as it's read.
- **Headless runs** (`codex exec`, `claude -p`) are not chat sessions. Each
  run logs one `Usage turn` line of `kind: run`, `driver: headless`
  (`src/main/services/headless-usage.ts`), which the rollup adds like a turn.
  - **Figures:**
    - Claude: per message id, cache reads and writes joined to input.
    - Codex: each `turn.completed`, with cached input and reasoning kept as
      parts of input and output.
    - A result's own total is used only when nothing else reported.
  - **Requested settings.** Provider, model and effort are what the run was
    started with (`requested: true`), not a provider report.
  - **No usage.** A run that reported none is `completeness: none`.
  - **Display.** The transcript summary (`src/shared/headless-transcript.ts`)
    and the run view keep a side no event reported absent. The view shows
    "Not reported" or "unknown" for it, never 0.

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
