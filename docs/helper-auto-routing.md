# Helper Auto routing

**Status: built (#2671):** an explicit `effort` on `start_helper`, presets by `difficulty`, read-only quota, `cli: "auto"`, and the settings audit. Clubhouse Go has locked the stage 2 phone wire in [Phone contract](#phone-contract), which is presets only. Later stages are not locked.

An orchestrator can ask for a helper by difficulty instead of naming a model, and can opt in to letting Clubhouse pick the provider from load and quota. The choice is deterministic, explained, and made once.

Every threshold, cooldown and built-in preset below is a **starting proposal, not a measured value**. They become named constants in one policy module, with comments saying so. Each decision records `policyVersion`, so telemetry can tune them from evidence.

## Precedence

Auto applies only where it is selected, and only to a new helper. It never writes to an existing agent, a saved preference or a current default.

**Is Auto allowed?** Asked only for `cli: "auto"`. The first of these that is set wins:

1. `dispatcher_locked` or `mcp_off`: always off. See [Where Auto is off](#where-auto-is-off).
2. Project or persona `off`. These two can only turn it off, so a cloned repository can't spend another provider's quota.
3. The orchestrator's `orchestration.autoHelpers`.
4. The app setting.
5. Built-in: off.

**Mode** comes from the request only:

| Request | Mode | Provider |
|---|---|---|
| No `difficulty` | `explicit` | Today's path |
| `difficulty`, with or without a named `cli` | `preset` | The named CLI or the orchestrator's own. Never changes. |
| `cli: "auto"` and `difficulty` | `auto` | Chosen across providers. `model` or `effort` alongside it is refused, since they belong to one CLI. |

`cli: "auto"` while Auto isn't allowed is refused, not ignored.

`preset` has no switch. It only changes anything when an orchestrator sends `difficulty`, it stays on one CLI, and an orchestrator can already name any model. This also means turning on a stage 2 setting can't quietly authorize cross-provider routing when stage 4 ships. The limitation: a project or persona `off` stops Auto but doesn't stop presets.

A start that names no CLI, model, effort or difficulty is today's path. Nothing is decided and no `routing` is recorded, whatever its persona sets.

**Each of CLI, model and effort**, highest first:

1. An explicit request argument. A saved Sol choice that Go sends lands here and is authoritative.
2. A persona front-matter pin, for values the request didn't name.
3. A mapping cell (`preset` or `auto` only): custom, then built-in.
4. `explicit` mode only: nothing passed, so the CLI's own default and the user's CLI config apply.

`preset` and `auto` have no step 4. With no valid cell they refuse with `no_valid_mapping`.

A persona's model isn't known to fit the CLI, so it is checked. In `preset` mode, one a live list refuses is `no_valid_mapping`. In `explicit` mode it only warns, as nothing asked for a preset. A persona's `default` is that persona's own choice, and is allowed.

A persona's model goes with its CLI. If the request names a different CLI from the one the persona pins, the persona's model is dropped too, and the model comes from below that step.

A cell's effort belongs to its model. So an explicit or pinned model takes no effort from a preset: it gets an explicit effort or the CLI's default. An explicit effort on a preset's model is checked against that model.

**Behaviour change in stage 2.** Until stage 2, a persona with `model:` or `orchestrator:` in its front-matter overwrote an explicit `start_helper` CLI or model, because it is applied during creation. Now the persona step leaves alone what the request named, and still applies the rest. A start that names nothing is unchanged, so its persona still sets them.

## Difficulty

A closed enum the orchestrator passes. Clubhouse never infers it from the task text and makes no model call to route.

- `easy`: mechanical, well specified, easy to check (a rename, a doc fix, one test).
- `medium`: normal feature or bug work in a known area with clear acceptance.
- `hard`: ambiguous, cross-cutting, concurrency, security or data-loss risk, or a mistake that is costly to catch.

## Mapping

Per provider, difficulty to model and effort, stored in `orchestration-settings` as sparse overrides on built-in presets.

| | easy | medium | hard |
|---|---|---|---|
| Claude | `haiku` / low | `sonnet` / medium | `opus` / high |
| Codex | `gpt-6-luna` / low | `gpt-6.1-terra` / medium | `gpt-6.1-sol` / high |

Cells are app-scope in v1. Reset removes overrides per cell, per provider or for all.

**Validation.** Both model and effort are checked at write and again at resolve, against the list for the target project's profile, since a profile can be a different login. The effort check is `checkHelperEffort`.

- Live list: a missing model, or an effort that model lacks, makes the cell `stale` (`model_unavailable`, `effort_unavailable`). A good model with a bad effort is still stale, and never runs at a default effort.
- Fallback or unreadable list: the cell is `unverified` and usable, with fallback code `model_unverified`. Verified candidates rank ahead within a tier.
- A cell can have `effort: null` for a model that takes no levels.
- A cell has to name a model. `default` is refused on write and treated as stale if it's saved, because a `hard` task on an unknown default is a silent substitute.

**Which list.** A write is checked against the app-wide list, because presets are app-wide, and `choices` are that same list, so a value picked from them is accepted. Cells read with `projectId` or `agentId` are checked under that project's profile, so their state says what a start there would do. A model only a project's profile offers can't be saved as a preset. Name it on the start instead.

**Check again.** Settings > Helpers has a Check again action, for after signing in to a CLI, because nothing notices a login change. It forces each preset provider's app-wide model list once, before cells are built, and forces a quota read, then shows the result. A probe that fails doesn't fail the page. It writes nothing, so there's no audit row, and the revision moves only as for any app-wide read that finds a cell's state changed. It's desktop only, and doesn't force a list or read kept under a project's profile. Each provider logs one `core:mcp` line with its list source, model count and outcome.

**Fallback.** Custom cell, then the built-in cell if valid (`builtin_preset`), then the next provider (Auto only, `candidate_skipped`), then a refusal with `no_valid_mapping` naming each cell and reason. Neither mode falls back to the CLI's default model, because a `hard` task on an unknown default is a silent substitute. Saved values are never rewritten. Settings and the phone show a stale cell with Reset.

**Copilot** is excluded from `preset` and `auto`, with reason `auto_not_supported`: its list reports no per-model efforts, and no quota source has been researched. Explicit Copilot starts are untouched.

## Inputs

### Quota

Read token-free, with no prompt. Checked on one login on Claude Code 2.1.312 and codex 0.163.0; an account that is really rate limited and non-subscription logins are fixture-tested only.

- **Codex:** `account/rateLimits/read` on `app-server`, plus `account/rateLimits/updated` from running chat sessions. `primary` can be the weekly window, so windows are classified by duration. `accountId` and `planType` are dropped and never stored.
- **Claude:** the `get_usage` control request with `skip_behaviors`, plus `rate_limit_event` from running chat sessions. The SDK labels it experimental, so shape drift reads as `unknown` and never throws, and a fixture schema check guards the fields we read. Fields are picked by name, because the reply holds many unrelated keys.
- **No plan:** a login with no plan limits is `not_applicable`. Claude says so with `rate_limits_available: false`. Codex says so only as an error, `authentication required to read rate limits`, seen on 0.163.0 with no login and with an API key, so it is matched by its words and a new wording reads as `read_failed`.
- **Reads** run only when Auto routes or Settings is open, with no background polling. Shared in flight, cached 5 minutes, 1 minute backoff after a failure, 3 second budget at route time, keyed by provider and profile. Check again skips the cache and the backoff and waits up to 12 seconds, still sharing a read already in flight.
- **Model-scoped caps** apply only on an exact name match, and only to a choice of that model. A provider's own state leaves them out, since they apply to one model. So a model-scoped cap can be missed, and the UI says so.
- **Claude's other keys** aren't read: `locked_reason` isn't in the SDK's types, so a reported limit on Claude comes from `rate_limit_event` in a running chat session. A terminal session or an idle provider shows `near_limit` at most, never `exhausted`.

| State | Meaning | Routing |
|---|---|---|
| `known` | Under 80% used | Eligible |
| `low` | 80% up to 95% used | Used only if nothing better is left |
| `near_limit` | 95% or more used, and the provider hasn't said the limit is reached. Quota remains. | Skipped, our own reserve: `quota_near_limit` |
| `exhausted` | The provider reported the limit reached: a `rejected` status, `rateLimitReachedType`, or a `rate_limited` error | Skipped: `quota_exhausted` |
| `unknown` | No current reading. `unknownReason`: `not_read`, `stale` (over 15 minutes old), `not_applicable` (for example an API key), `read_failed`, `not_supported` | Scored as `known`, shown as unknown |

The UI and telemetry never say exhausted while quota remains. Used percent alone never produces `exhausted`, even at 100%.

**Which limit sets the state.** The most constrained of the provider's readable windows: weekly, five-hour, and any model-scoped window that matched. That means the highest used percent, with the later reset breaking a tie. `limitingWindow` and `resetsAt` both come from that one window. A reported limit on any window makes the state `exhausted`, with that window's reset. A window past its reset is discarded first. A plan with no such window (this login reports no five-hour window) isn't a missing reading. If a window exists but can't be read, the other one decides and `unreadableWindows` records it. If none can be read, the state is `unknown`.

Every state has `asOf`, and a stale reading keeps its.

`unknown` scores the same as `known`, so an API-key login isn't starved, but it stays `unknown` in the UI, the phone and telemetry and never reads as available capacity. The decision carries `quotaBasis: "unknown_scored_as_healthy"`.

Percent used is only compared within a provider's own plan. There is no claim of equal cost across providers, and dollar fields aren't used.

### Load

A provider's helpers, across all orchestrators, that are creating, starting or have a live process, plus unexpired reservations. Sleeping, failed and disposed helpers don't count, nor do non-helper agents. Sleeping helpers still count toward the global helper cap.

## Selection

A pure function, one decision per start. Inputs that need a CLI are read before the global start lock, and the decision runs under it.

1. Candidates: enabled, available, Auto-eligible, a valid mapping cell, not cooling down.
2. Drop `exhausted` and `near_limit`.
3. Keep the best tier: `known` and `unknown` together, otherwise `low`.
4. **Anchor:** the sticky provider if it survived, else the orchestrator's own CLI if it survived, else the first by registration order.
5. **Margin 2:** leave the anchor only if some provider in the tier has a load at least 2 lower. Among those, pick the lowest load, then registration order.

The margin applies only between providers in the same tier. A worse tier always loses, and it has no part in explicit or preset starts.

**Sticky.** The key is orchestrator plus difficulty, and the value is a provider, never a model or effort; the cell is always read fresh. Each Auto decision sets it, and it expires 30 minutes after the last one for that key. It is in memory only, never overrides steps 1 to 3, and doesn't touch running helpers.

**Reservations.** Added under the lock at decision time, so a burst sees earlier picks without depending on disk or the helper-index cache. Released when the helper counts as live, or the start fails or is cancelled, with a 5 minute backstop. A held approval doesn't reserve, because it decides when approved.

From 0/0 with the orchestrator on A, seven starts go A A B B B B A. The spread stays within 2. That balances helper counts, not cost.

**No candidate:** an immediate refusal naming each provider's reason. Nothing is queued. Explicit starts are never blocked by quota or a cooldown, only warned: `start_helper` returns `quotaWarning`, from what is already known, without asking a CLI. A person sees the same words in Needs you, on the Helpers card and in the helper header, and a phone in `startWarning`, `warning` and `routing.warning`.

**One decision.** Routing never runs again for that helper. A wake reuses its saved CLI, model and effort and resumes its session. A quota change, rate limit or failure after the task is delivered never moves it. If a saved model has gone, the wake fails or falls to the CLI default as any agent does, and is reported.

## Failures

Classified from existing signals: `auth_required`, `account_issue`, `rate_limited`, `isLoginRequiredError` and spawn failures.

| Class | Signal | Cooldown (Auto only, per provider and profile) | Retry |
|---|---|---|---|
| `auth` | Login required, account issue | 10 minutes | Allowed before delivery |
| `quota` | `rate_limited` | Until `resetsAt`, else 30 minutes. The provider said so, so the state becomes `exhausted`. | Allowed before delivery |
| `availability` | Spawn failed, missing binary, model rejected | 5 minutes | Allowed before delivery |
| `task` | Anything else after delivery: tool failure, context overflow, exit | None | Never |

- A failed start can exclude a provider whose quota is unknown, but only for `auth`, `quota` or `availability`, and only for that cooldown. Unknown quota alone never excludes.
- A `quota` or `auth` error after delivery sets the cooldown for future starts. That helper isn't moved or retried.
- Cooldowns are fixed and in memory, and kept per class, so a later failure never shortens another class's cooldown.
- A successful read from Check again ends an `auth` cooldown older than that read, for the same provider and profile. It takes a reading with windows, since Codex also answers `not_applicable` when logged out, so an API-key login waits out its cooldown. `quota` and `availability` cooldowns stay, and a failed read clears nothing.
- **No retry on another provider.** A worktree is set up for one CLI when it's created: its instructions file, skills and config follow that CLI's conventions. So a failed spawn isn't moved. It fails as any helper does, with its task saved for `wake_helper`, and the cooldown keeps the next start off that provider. `retried_after_spawn_failure` is not used.

## Context window

Auto adds no rule to #2660's context setting:

- A saved choice is per CLI and model. A model change keeps one the model offers and clears one it doesn't. A CLI change clears it.
- At launch, `contextWindowForLaunch` clears a refused choice and keeps, without passing, one it can't check. Both emit the `context_window_not_applied` notice.

v1 has no context column and `start_helper` has no context argument, so the only case is a persona supplying a choice against the model Auto picked. It is reported as `routing.context.status`: `none`, `applied`, `reset` or `not_applied`. A wake doesn't change the model, so it adds no case.

`status` is a code with no text of its own. The words come from #2660's existing `contextWindowNotice`, `contextWindowReset` and `context_window_not_applied` notice, so a client shows those and doesn't add a second warning.

Effort follows the same idea more simply: any change of model or CLI clears it, whatever happens to the context choice, and changing the context choice leaves effort alone. Both are passed at launch, and a launch that drops the context choice still passes the effort.

## Explanation

`start_helper` and `list_helpers` return `routing`, saved on the helper and shown on the Helpers card and helper header. It describes the decision, not live quota, and is absent on helpers started before this. `balanced` is false for anything but `auto`, so nothing claims Auto balanced a helper an explicit argument decided.

```json
"routing":{"mode":"auto","balanced":true,"decidedAt":"…","policyVersion":1,
 "requested":{"provider":"auto","model":null,"effort":null,"difficulty":"hard"},
 "resolved":{"provider":"codex-cli","model":"gpt-6.1-sol","effort":"high","difficulty":"hard"},
 "source":{"provider":"auto","model":"builtin_mapping","effort":"builtin_mapping"},
 "reason":"lower_load","fallback":"none","quotaBasis":"known","skipped":{},
 "load":{"claude-code":2,"codex-cli":0},
 "quota":{"codex-cli":{"state":"known","limitingWindow":"weekly","asOf":"…"},"claude-code":{"state":"unknown","unknownReason":"read_failed","asOf":null}},
 "context":{"status":"none"}}
```

Stable codes:

- `reason`: `explicit_request`, `persona_pinned`, `preset_on_cli`, `only_candidate`, `lower_load`, `better_quota_tier`, `sticky`, `default_order`.
- `fallback`: `none`, `builtin_preset`, `candidate_skipped`, `model_unverified`, `retried_after_spawn_failure`.
- `source`: `request`, `persona`, `auto`, `orchestrator`, `custom_mapping`, `builtin_mapping`, `cli_default`.
- `skipped`, per provider: `cli_disabled`, `cli_unavailable`, `auto_not_supported`, `no_valid_mapping`, `cooling_down`, `quota_near_limit`, `quota_exhausted`.
- `auto.reason`, when Auto is off: `not_enabled`, `project_off`, `persona_off`, `orchestration_off`, `mcp_off`, `dispatcher_locked`.

MCP calls the provider `cli`, as `start_helper` does.

## Telemetry

Closed allowlists in `src/shared/telemetry/attributes.ts`, with no prompts, secrets or raw config.

Stage 2 lists only `explicit` and `preset`, its three reasons and its fallbacks. The rest come with their stages.

- `clubhouse.helper.routed`: reuses `orchestrator` (resolved), `modelFamily` (never the raw id) and `outcome`. Adds requested CLI, difficulty, mode, effort, preset (`builtin`, `custom`, `none`), config source, reason, fallback, load bucket, quota state (the five above), limiting window, staleness bucket, `quotaBasis`, failure class and `policyVersion`.
- `clubhouse.helper_routing.changed`: action (`set`, `toggle`, `reset_cell`, `reset_provider`, `reset_all`), surface and outcome.
- Add `orchestration` to `SETTINGS_KEYS`. `SAVE_ORCHESTRATION_SETTINGS` emits nothing today.

### Decision, outcome and usage records (#2747)

Seven events, all `localOnly`: they go to the local recording (`~/.clubhouse/logs/telemetry-*.jsonl`) at the default level and are never handed to an export destination, whatever its level or preset. Exporting any of it later is a separate decision. `clubhouse.helper.routed` stays the one exportable summary. Nothing here reads a prompt, task text, path, account name or credential, changes routing, probes a provider or spends tokens.

| Event | Written when | Carries |
| --- | --- | --- |
| `clubhouse.helper.decision` | A routing decision, accepted or refused. A refusal has no helper | Decision id, mode, outcome, policy version, requested and resolved provider, model (hash plus family), effort, difficulty, task profile, mapping revision and fingerprint (hashes), mapping kind, counts of candidates and eligible ones, thresholds in force, cooldown counts, tie inputs |
| `clubhouse.helper.decision.candidate` | One per registered provider of a decision, at most 8 | Eligibility and exclusion code, mapped model and effort and whether verified, load split into `live` and `reserved`, quota state, source, reading time and freshness, unknown reason, weekly and 5-hour used basis points and reset times, policy score inputs, rank, chosen |
| `clubhouse.helper.spawn_result` | The decision became a helper or didn't | `started`, `left_asleep`, `spawn_failed` (with cooldown kind), `creation_refused`, `cancelled`; whether the provider and model that launched differ from the decision; decision age |
| `clubhouse.helper.reuse` | A wake or resume | The earlier decision's id and age. It is never a new decision; `decision_known=false` when the ledger has none |
| `clubhouse.helper.usage.sample` | After each finished turn of a helper run, and once or twice at its end | Token figures with source, scope, dedup rule and completeness |
| `clubhouse.helper.outcome` | The run ended, or the helper was disposed | Outcome, duration, turns, turns with no usage, auth, rate limit and exceeded-quota errors seen, samples dropped |
| `clubhouse.helper_quota.sample` | A token-free plan-limit read finished | See below |

Conventions that hold for every field:

- **Absent is unavailable. Zero is a reported zero.** A quota with no reading has no percent attribute, not `0`. A provider that reports no reasoning tokens has no `reasoning_tokens`.
- Percentages are basis points of the provider's own plan window (4200 is 42.00%), times are epoch milliseconds, ids are hashed by the facade with the install's secret salt. A model is `model_hash` (different mapped models stay distinguishable, the id is not recoverable) plus the closed `clubhouse.model.family`. The same applies to the mapping revision and fingerprint, so two decisions on the same mapping compare equal.
- Tokens are never turned into a subscription percentage, and neither are dollars. Used percent is only the provider's reading.
- The contract routing fills in is `src/shared/telemetry/helper-usage-contract.ts`. Anything policy-specific is optional, so a policy that has no score, tie band or reservation expiry leaves them out.

#### Local and export policy, per field

Today every field of these seven events is local-only: written when local recording is on at the standard level or above (the default), never exported, and not tied to any destination's level or preset. They follow the same consent gate as every other signal: local recording off, nothing is produced (and the ledger is not written). The `localOnly` option on `tel.event` is what enforces it; it is tested against both the live and the start-up-buffered export paths.

If a field is ever exported, it is a deliberate per-field change, not a default. Closed-enum fields (mode, outcome, reason, exclusion code, spawn result, outcome class, completeness, dedup rule, scope) are the only candidates. These stay local: used percentages and reset times, the model hash, mapping revision and fingerprint, token counts, ids and their hashes, anything with a time, and every number a quota reading carries.

#### Joining

The base folder (`~/.clubhouse`, or `~/.clubhouse-dev` in development) keeps `helper-decisions.json`, a small ledger that maps a helper id to the decision that started it. It holds ids and the resolved provider, model and effort, nothing else. While the app runs, an entry whose helper has a run open, or whose start has no result yet, is never evicted. A start with no result is kept until routing reports one or a run begins (which proves it started); past 200 such starts the oldest are marked `orphaned`, which is an explicit unknown that still joins. Entries of helpers that are not running are kept 30 days, at most 500, oldest first. After a restart no run survives, so every entry is inactive and a start the previous run never resolved is `orphaned`. A helper missing from the ledger (evicted, started while telemetry was off, or the file lost) is an explicit unknown: its events say `helper_decision.known=false`. Writes are atomic, coalesced and serialized, a failed write is reported once without affecting anything, and a persisted entry with any field off its closed set is dropped on read.

Join on the hashes:

- `clubhouse.helper_decision.id_hash`: decision, candidates, spawn result, reuse, usage samples and the outcome.
- `clubhouse.agent.id_hash`: the helper (its agent id), the same value other agent events carry.
- `clubhouse.helper_run.id_hash`: one actual run. A wake starts a new run on the same decision. It is not the provider's session id, which a resume can reuse. `native_resumed` only says whether the provider continued an earlier session.

Disposal waits for the session to end before the run is closed, so the last turn's usage is still joined, and the ledger entry is kept after disposal.

#### Usage samples

One sample per finished turn, deduplicated by the turn id, and a closing sample from the provider's running total. **Use one kind, not both: turn samples and the closing sample are separate readings of the same run.** A run is capped at 200 turn samples; anything past that is counted in `usage_samples_dropped`.

| Field | Meaning |
| --- | --- |
| `source` | `provider_turn` (the provider's total for one turn) or `provider_session_cumulative` (its running total as last reported) |
| `scope` | `main` is the helper alone, `inclusive` also counts its subagents, `unscoped` means the driver did not say. Never add samples of different scope |
| `dedup` | `turn_id`, `thread_cumulative`, `content_equal` (an identical report right after another is dropped), or `none` when repeats could not be told apart |
| `completeness` | `complete` (input and output reported), `partial`, `none` |
| `reset` | A running total went down (a reset or compaction). No delta is claimed |

What each provider gives, as of this source:

| Provider | Turn | Running total | Notes |
| --- | --- | --- | --- |
| Claude (stream-json and SDK) | Main loop of the turn (`main`) | Sum of per-model totals, subagents and compaction included (`inclusive`) | `input` includes cache reads and writes. No reasoning figure, so it is absent |
| Codex | Difference of the thread's running totals | One total per thread (`main`); a subagent thread is flagged and reported apart. The closing samples are the helper's own thread (`subagent_excluded`) and, when subagents ran, the sum of every thread (`inclusive`) | A total that goes down leaves that figure out of the turn instead of showing zero |
| Copilot SDK | Sum of the turn's `assistant.usage` calls, subagents included (`inclusive`) | Our sum over the session (`inclusive`) | A figure no call reported is absent. No per-call id, so calls cannot be deduplicated |
| Copilot ACP and other ACP agents | The prompt's usage; an exact repeat of the previous report is dropped (`content_equal`) | Context and cost only, no tokens | Scope is `unscoped` |

Parent and helper are never added: a helper's usage is its own run. The session transcript reader (`getSessionSummary`) counts each message once even though Claude writes one record per content block, keeps the usage of tool-only and thinking-only messages, and marks `tokenUsage` as `partial` when a message has none or repeated records disagree. A conflicting message keeps the highest figure per field, which may match no actual record, so it is flagged and must not be used as a measured sample.

#### Plan-limit samples

`clubhouse.helper_quota.sample` is written when a token-free read has finished, on the provider's first reading, when its state changes, when a window moved by one point or its reset time changed (at least 5 minutes after the last sample), and otherwise at most every 15 minutes. At most 12 an hour per provider. There is no timer: only reads that demand already causes are sampled.

`weekly_delta_bp` and `five_hour_delta_bp` are the change since the previous sample, labelled `observed`: they appear only when both readings are in the same reset window, and `reset_between=true` marks a window that reset in between, with no delta claimed. They cover the whole login. Use outside Clubhouse is in them and cannot be told apart from helper use, so per-helper burn is attributable only from usage samples.

#### Limits

At most 2000 helper events an hour in total, so a burst of starts cannot crowd out other signals (the recorder allows 10,000 log records an hour in all). Past it they are dropped and counted in memory. Per decision: 1 event plus at most 8 candidates. Per provider: 12 quota samples an hour. Per run: 200 turn samples plus at most 3 closing ones.

#### Reading the logs

Fairness is measured against eligibility, load and quota; round robin is not assumed. Examples with `jq`, over `telemetry-*.jsonl`:

```sh
cd ~/.clubhouse/logs   # or ~/.clubhouse-dev/logs

# Choices by provider
jq -r 'select(.t=="event" and .name=="clubhouse.helper.decision" and .attrs["clubhouse.helper_decision.outcome"]=="chosen" and .attrs["clubhouse.helper_routing.mode"]=="auto") | .attrs["clubhouse.orchestrator"]' telemetry-*.jsonl | sort | uniq -c

# How often each limit excluded a provider
jq -r 'select(.name=="clubhouse.helper.decision.candidate" and .attrs["clubhouse.helper_candidate.excluded"]!="none") | .attrs["clubhouse.helper_candidate.excluded"]' telemetry-*.jsonl | sort | uniq -c

# Per decision: who was eligible, their load and quota, and who was chosen
jq -c 'select(.name=="clubhouse.helper.decision.candidate") | [.attrs["clubhouse.helper_decision.id_hash"], .attrs["clubhouse.orchestrator"], .attrs["clubhouse.helper_candidate.eligible"], .attrs["clubhouse.helper_candidate.load_live"], .attrs["clubhouse.helper_candidate.load_reserved"], .attrs["clubhouse.helper_quota.state"], .attrs["clubhouse.helper_quota.weekly_used_bp"], .attrs["clubhouse.helper_candidate.chosen"]]' telemetry-*.jsonl

# Chosen with an unknown quota
jq -r 'select(.name=="clubhouse.helper.decision.candidate" and .attrs["clubhouse.helper_candidate.chosen"]==true and .attrs["clubhouse.helper_quota.state"]=="unknown") | .attrs["clubhouse.orchestrator"]' telemetry-*.jsonl | sort | uniq -c

# Whether the anchor held (tie reason)
jq -r 'select(.name=="clubhouse.helper.decision") | .attrs["clubhouse.helper_routing.reason"]' telemetry-*.jsonl | sort | uniq -c

# Failure rate by chosen provider and model: join spawn results to decisions
jq -s 'map(select(.t=="event")) as $e
  | ($e | map(select(.name=="clubhouse.helper.decision")) | map({key: .attrs["clubhouse.helper_decision.id_hash"], value: [.attrs["clubhouse.orchestrator"], .attrs["clubhouse.helper_decision.model_hash"]]}) | from_entries) as $d
  | $e | map(select(.name=="clubhouse.helper.spawn_result")) | group_by($d[.attrs["clubhouse.helper_decision.id_hash"]])
  | map({chosen: $d[.[0].attrs["clubhouse.helper_decision.id_hash"]], total: length, failed: map(select(.attrs["clubhouse.helper_spawn.result"]=="spawn_failed")) | length})' telemetry-*.jsonl
```

## Auditing settings changes

`settings-audit.jsonl` under the Clubhouse base dir: one JSON line per change or refusal, 1 MB, then one rotated file. It shares `bounded-audit-log.ts` with `dispatcher-audit.ts`. It's local and isn't sent anywhere. Reading it is by the file for now: nothing in the app shows it.

**A row** has `surface`, `actorId` when an agent asked, `scope` (`app`, `project`, `agent`), `targetId`, `key`, `before` and `after` or `changed: true`, `outcome` and `code`. It uses agent and project ids. Where only a path is to hand, as with project defaults, `targetId` is a short hash of it, never the path.

**Values.** Only through a per-key format. `value` keeps a boolean, a whole number, or a short word or id. Anything longer or odder, even on a `value` key, is only `changed: true`. `changed` keys never keep a value: names, commands, env, MCP config, instructions, permissions. In a settings store, a boolean is kept, other keys need the store to name them, and the rest are `changed: true`.

**Who asked** comes from `withSettingsSurface` at each entry point: `ui` from `withValidatedArgs`, `mcp` with the agent's id from the tool registry, `mobile` from the command service, `cli` from the CLI endpoint, `persona` around applying one. An explicit `dispatcher` comes from its controls. Nothing set means `system`, which is Clubhouse itself. An IPC handler not using `withValidatedArgs` also reads `system`.

**What it covers,** hooked where settings are written, so a new way to reach a writer is covered:

| Scope | Writer | Keys |
|---|---|---|
| Agent | `updateDurableConfig` | Exhaustive by type. Bookkeeping (`lastSleep`, session ids) is left out |
| Agent | `updateDurable`, `saveAgentIcon`, so appearance too | Name, color, emoji, icon |
| Agent | `setOrchestrationPolicy`, `turnOffOrchestration`, a persona pinning | Each policy field, refusals too |
| Agent | Instructions, permissions, MCP binding instructions and disabled tools | Changed only |
| Project | `projectStore.update`, so appearance too | Color, CLI, name, emoji, icon |
| Project | `writeProjectAgentDefaults`, including reset | Exhaustive by type |
| Project | Reset | Changed only |
| App | Every `createSettingsStore` that holds a person's choices | Top-level keys |
| App | Helper presets and Auto | Each cell and switch, refusals too |
| App | The asset catalog (`asset-catalog/store.ts`): new assets, revisions, template publications, names, deletions | Changed only, by asset id, refusals too |
| Agent | The asset catalog: compositions, accepted structure, template switches and copies | Changed only, refusals too |

`settings-audit-inventory.test.ts` pins this: a new settings store has to report or be named as not settings, and the writers and entry points are checked. **Not settings:** `annex-ports.json`, `finished-quick-agents.json`, `project-state.json`, `chat-cli-denylist.json`.

**Not covered:** the renderer's own stores such as keyboard shortcuts, plugin storage, files edited by hand, and `dispatcher-audit.jsonl`'s own rows, which stay where they are. Project pin and inactive state isn't treated as a setting. A store's save records a key's value as saved, which can include neighbours saved at their defaults, as `docs/settings-read-mcp.md` describes.

## Phone contract

Stage 2 is locked from the phone side. Auto UI waits for the stage 4 capability. On the phone the provider is named `provider`.

App-wide preset editing from the phone is in scope.

**Capability.** `helperRouting:{version:1,modes,scopes,quota,commands,difficulties,reasons,fallbacks,skipped,quotaStates,unknownReasons,cellStates}`. It advertises only what is implemented and usable, so a client keys on these fields and can't offer Auto early. Absent means an older desktop: hide the UI and expect no `routing` on helpers.

| Stage | `modes` | Writable `scopes` | `quota` | Also added |
|---|---|---|---|---|
| 1 | Capability absent | | | Nothing on the phone. `effort` is MCP only. |
| 2 | `explicit`, `preset` | `app`: cells and reset only | `false` | `helperRouting.update`, `GET helper-routing` without `auto`, helper `routing`, `helperRoutingRevision` |
| 3 | `explicit`, `preset` | `app` | `true` | Provider `quota`, `quotaStates`, `unknownReasons` |
| 4 | `explicit`, `preset`, `auto` | `app`, `project`, `agent` | `true` | `auto` block, `auto` in `helperRouting.update`, `orchestration.autoHelpers` |
| 5 | No change | | | |

**Read:** `GET /api/v1/mobile/helper-routing?projectId=&agentId=`, both optional, narrowing the scope.

```json
{"version":1,"revision":"r12",
 "auto":{"effective":false,"source":"project",
  "scopes":{"app":{"value":true,"editable":true},
   "project":{"value":"off","choices":["off",null],"editable":true},
   "persona":{"value":null,"editable":false},
   "agent":{"value":null,"editable":true}}},
 "providers":{
  "codex-cli":{"autoEligible":true,
   "quota":{"state":"known","source":"cli_query","asOf":"…","weekly":{"usedPercent":41,"resetsAt":"…"},"fiveHour":null},
   "choices":{"source":"live","asOf":"…","models":[{"id":"gpt-6.1-sol","label":"…","efforts":["low","high"]}]},
   "cells":{"hard":{"effective":{"model":"gpt-6.1-sol","effort":"high"},"source":"builtin","state":"valid",
     "custom":null,"builtin":{"model":"gpt-6.1-sol","effort":"high"},"editable":true},
    "medium":{"effective":{"model":"gpt-6.1-terra","effort":"medium"},"source":"builtin","fallback":"builtin_preset","state":"stale","staleReason":"model_unavailable",
     "custom":{"model":"gone","effort":"high"},"builtin":{"model":"gpt-6.1-terra","effort":"medium"},"editable":true}}},
  "copilot-cli":{"autoEligible":false,"reason":"auto_not_supported","quota":{"state":"unknown","unknownReason":"not_supported","asOf":null},"cells":null}}}
```

A cell with nothing valid has `effective: null`. Until the `auto` mode is advertised, `autoEligible` only says whether a provider has presets. With `agentId`, stage 2 also returns `agent:{usable,reason?}`, where `reason` is `dispatcher_locked`, `mcp_off` or `orchestration_off`. The `auto` block appears from stage 4 and `quota` from stage 3. `source` under `auto` is `agent`, `project`, `persona`, `app`, `default`, `mcp_off` or `dispatcher_locked`, and `auto.reason` is set whenever `effective` is false.

**Revisions.** The full snapshot has `helperRoutingRevision`, and a `helper_routing:changed` event carries `{revision}`, so an open or cached page knows to refetch. The revision moves when a saved value changes, when an app-wide read finds that a cell's state changed, or when something that decides Auto changes: a project's `off` or default persona from any surface, an orchestrator's switch or persona, or Clubhouse MCP. It doesn't move for a quota sample, and no snapshot is broadcast for one. It is opaque to a client. A list changing doesn't make a write stale: only a saved value does.

**Quota freshness** is pulled. See `docs/mobile-control-v1.md#quota` for the rule: the smallest `refreshAfterSeconds` across providers, at least 5 seconds, with age measured from a `serverTime` anchor on suspend-aware monotonic time, never the phone's clock.

**Labels.** `GET helper-routing` returns `labels`, keyed by code family, and helper settings add `display:{summary,reason,fallback}` with the resolved text, and `quota` from stage 3. So the desktop owns the words. A bare `GET helper-routing`, with no `agentId` or `projectId`, returns every label family, so a client can cache labels once per revision for code-only helper and Needs you rows. Precedence for a client: `display`, then `labels`, then `labels.unknownCode`, then its own generic "Other". The snapshot carries codes only.

| Family | Code | Text |
|---|---|---|
| reason | `explicit_request` | You or the orchestrator chose this |
| reason | `persona_pinned` | Set by the persona |
| reason | `preset_on_cli` | From the helper settings for this difficulty |
| reason | `only_candidate` | The only provider available |
| reason | `lower_load` | Fewer helpers running on this provider |
| reason | `better_quota_tier` | This provider has more of its limit left |
| reason | `sticky` | Stayed on the provider chosen last |
| reason | `default_order` | No reason to switch |
| fallback | `builtin_preset` | The saved choice is no longer offered, so the default was used |
| fallback | `candidate_skipped` | Another provider was skipped |
| fallback | `model_unverified` | The model list may be out of date, so this couldn't be checked |
| fallback | `retried_after_spawn_failure` | Started on another provider after the first failed to start |
| skipped | `cli_disabled` | Turned off in Settings |
| skipped | `cli_unavailable` | Not available on this computer |
| skipped | `auto_not_supported` | Auto doesn't support this provider yet |
| skipped | `no_valid_mapping` | No choice for this difficulty is offered now |
| skipped | `cooling_down` | It failed to start recently |
| skipped | `quota_near_limit` | Close to its limit |
| skipped | `quota_exhausted` | The provider reports its limit reached |
| quota | `known` | Limit available |
| quota | `low` | Limit getting low |
| quota | `near_limit` | Close to the limit |
| quota | `exhausted` | Limit reached |
| quota | `unknown` | Unknown |
| unknown | `not_read` | Not checked yet |
| unknown | `stale` | Last checked too long ago |
| unknown | `not_applicable` | This login has no plan limit |
| unknown | `read_failed` | Couldn't check |
| unknown | `not_supported` | This provider doesn't report it |
| cell | `valid` | Offered |
| cell | `unverified` | Couldn't be checked |
| cell | `stale` | No longer offered |
| generic | `unknownCode` | Clubhouse gave a reason this version can't show |

`known` says limit available, not capacity guaranteed. `unknown` is never worded as available. Context status has no labels: see [Context window](#context-window).

**Write:** command `helperRouting.update` with `{revision,scope,projectId?,auto?,cells?:[{provider,difficulty,model,effort}],reset?:{provider?,difficulty?}}`, returning fresh settings. Only scopes the capability lists are accepted. A project scope accepts only `auto: "off"|null`. Errors: 400 `invalid_helper_routing`, 409 `helper_routing_stale`, 409 `model_unavailable`, 409 `effort_unavailable`. Agent scope stays in `orchestration.autoHelpers` through `agent.update`.

**A stale write** writes nothing, for any part of the command, and its 409 returns `{revision, settings}`. A client shows the fresh values and lets the person apply their change again. It must not retry on its own, since that could overwrite someone else's edit.

**Helper snapshot (minimal):** `routing:{mode,difficulty,provider,model,effort,reason}`, codes only. The snapshot frame size tests from #2659 cover these fields, on a helper in every row.

**Helper settings (detailed):** `GET /mobile/agents/:id/settings` carries the full `routing` above and `display`.

**Held starts.** The helper request gets `requestedRouting`, with no resolved choice. `no_valid_mapping` is checked before holding, so the person isn't asked about a start that can't run, and again at approval, since a cell can go stale meanwhile. If it fails at approval, `helper.approve` returns 409 with `status: "rejected"`, because nothing was created, `error.code: "no_valid_mapping"`, a sentence for a person in `error.message`, and no `routing`. The request is used up, the orchestrator is told why, and a snapshot without the row is sent, in either order with the receipt. A phone shows the sentence and offers no retry. The same `commandId` replays the receipt, and a new one gets 404 `helper_request_not_found`, so nothing can be created twice. Only a helper that starts gets `routing`.

**Fixtures:** the capability at each stage, and absent; each quota state, including `near_limit` with quota remaining, `exhausted` as reported, and `unknown` with and without a stale `asOf`; a limiting window with another window unreadable; an explicit override (Sol, `explicit_request`, `balanced: false`); a preset on a CLI; a persona pin; project-disabled; `mcp_off`; `dispatcher_locked`; a stale preset falling back to built-in; stale with nothing valid; Copilot excluded; a held approval failing with `no_valid_mapping`; context `reset` and `not_applied`; a stale-write 409 and reset results; labels, including an unknown code; the revision in the snapshot and the changed event.

## Where Auto is off

From stage 4 these are `auto` states, as below. At stage 2 they are the `agent` block's `usable: false` and `reason`.

**Dispatcher (`dispatcher_locked`).** The Dispatcher doesn't start helpers, and this feature doesn't expand its authority. It gets no `start_helper`, no write tools and no routing inputs. For the Dispatcher's agent, `auto` is `{effective: false, source: "dispatcher_locked", reason: "dispatcher_locked"}`, with every scope `editable: false`, and `orchestration.autoHelpers` in `agent.update` stays refused as its other orchestration fields are. App-wide preset editing is a person's action from Settings or a phone, never the Dispatcher's. There are no MCP write tools for any of this.

**No Clubhouse MCP (`mcp_off`).** No MCP means no orchestration (#2589), so the agent can't call `start_helper`. `auto` is `{effective: false, source: "mcp_off", reason: "mcp_off"}`, and saved values stay and come back with MCP. Turning `autoHelpers` on while MCP is off is refused with the existing `mcpRequired` result. Clearing or turning it off still works. Helpers already running keep their `routing`.

## Orchestrator guidance

To replace the persona's model lines once Auto ships. The `start_helper` description and the difficulty enum carry the short form, and a test pins the wording against claims like "best" or "cheapest".

> - For most tasks, name a difficulty. `easy`: mechanical, well specified, easy to check (a rename, a doc fix, one test). `medium`: normal feature or bug work in a known area with clear acceptance. `hard`: ambiguous, cross-cutting, concurrency, security or data-loss risk, or a mistake that is costly to catch. Judge the task, not its urgency or size alone.
> - `difficulty` keeps the helper on your CLI. If Auto is on for you, `cli: "auto"` with a difficulty lets Clubhouse pick the provider. If it is off, `start_helper` refuses; ask the user or name a CLI.
> - Name a CLI, model or effort only when the task or the user needs that one. They always win, and nothing is balanced for that helper.
> - Read `routing` in the result and report what it says. Unknown quota means unknown, not available. Don't claim a choice is cheapest, best or preferred, and don't compare cost across providers.
> - A helper stays on its provider for its whole task. If Auto refuses, tell the user the reasons or start with an explicit CLI. Don't retry in a loop.

## Open items

- **Terminal signal limit.** Terminal helpers report no error codes, so their failures after spawn aren't seen, no cooldown is set, and quota stays whatever the last read said.
- **Phone wire** past stage 2 isn't locked.
- **Context and Auto** haven't been tested together. Effort and context have, from stage 1.

## Stages

One PR each.

1. Explicit `effort` on `start_helper`. Built.
2. Built. Mapping and `difficulty` in `preset` mode: settings, validation, reset, UI, explanation, telemetry, phone read and write including app-wide preset editing, restoring explicit fields after a persona applies, first audit rows.
3. Built. Quota service: read-only, shown in Settings and on the phone. Routing doesn't use it yet.
4. Built. `cli: "auto"`: routing, load, sticky, reservations, cooldowns, retry, tool and persona guidance.
5. Built. Wider audit.
