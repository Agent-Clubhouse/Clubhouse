# Helper Auto routing

**Status: proposed (#2671).** Only stage 1, an explicit `effort` on `start_helper`, is built. Everything else here is a design. The phone wire in [Phone contract](#phone-contract) is not locked, and nothing should be built against it until Clubhouse Go and the maintainer agree it.

An orchestrator can ask for a helper by difficulty instead of naming a model, and can opt in to letting Clubhouse pick the provider from load and quota. The choice is deterministic, explained, and made once.

Every threshold, cooldown and built-in preset below is a **starting proposal, not a measured value**. They become named constants in one policy module, with comments saying so. Each decision records `policyVersion`, so telemetry can tune them from evidence.

## Precedence

Auto applies only where it is selected, and only to a new helper. It never writes to an existing agent, a saved preference or a current default.

**Is Auto allowed?** The first of these that is set wins:

1. Project or persona `off`. These two can only turn it off, so a cloned repository can't spend another provider's quota.
2. The orchestrator's `orchestration.autoHelpers`.
3. The app setting.
4. Built-in: off.

**Mode** comes from the request only:

| Request | Mode | Provider |
|---|---|---|
| No `difficulty` | `explicit` | Today's path |
| `difficulty`, with or without a named `cli` | `preset` | The named CLI or the orchestrator's own. Never changes. |
| `cli: "auto"` and `difficulty` | `auto` | Chosen across providers. `model` or `effort` alongside it is refused, since they belong to one CLI. |

`difficulty` while Auto isn't allowed is refused, not ignored.

**Each of CLI, model and effort**, highest first:

1. An explicit request argument. A saved Sol choice that Go sends lands here and is authoritative.
2. A persona front-matter pin, for values the request didn't name.
3. A mapping cell (`preset` or `auto` only): custom, then built-in.
4. Nothing passed: the CLI's own default and the user's CLI config.

**Behaviour change in stage 2.** A persona with `model:` or `orchestrator:` in its front-matter overwrites an explicit `start_helper` model today, because it is applied during creation. Stage 2 restores explicit fields after the persona applies, so rule 1 holds. Its PR description and release note must call this out, and a test uses a persona that pins both model and orchestrator.

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

**Fallback.** Custom cell, then the built-in cell if valid (`builtin_preset`), then the next provider (Auto only, `candidate_skipped`), then a refusal with `no_valid_mapping` naming each cell and reason. It never falls back to the CLI's default model, because a `hard` task on an unknown default is a silent substitute. Saved values are never rewritten. Settings and the phone show a stale cell with Reset.

**Copilot** is excluded from `preset` and `auto`, with reason `auto_not_supported`: its list reports no per-model efforts, and no quota source has been researched. Explicit Copilot starts are untouched.

## Inputs

### Quota

Read token-free, with no prompt. Checked on one login on Claude Code 2.1.312 and codex 0.163.0; an account that is really rate limited and non-subscription logins are fixture-tested only.

- **Codex:** `account/rateLimits/read` on `app-server`, plus `account/rateLimits/updated` from running chat sessions. `primary` can be the weekly window, so windows are classified by duration. `accountId` and `planType` are dropped and never stored.
- **Claude:** the `get_usage` control request with `skip_behaviors`, plus `rate_limit_event` from running chat sessions. The SDK labels it experimental, so shape drift reads as `unknown` and never throws, and a fixture schema check guards the fields we read. Fields are picked by name, because the reply holds many unrelated keys.
- **Reads** run only when Auto routes or Settings is open, with no background polling. Shared in flight, cached 5 minutes, 1 minute backoff after a failure, 3 second budget at route time, keyed by provider and profile.
- **Model-scoped caps** apply only on an exact name match. Otherwise only provider-wide windows count, so a model-scoped cap can be missed, and the UI says so.

| State | Meaning |
|---|---|
| `known` | Under 80% used |
| `low` | 80 to 95% used |
| `exhausted` | 95% or more, or the CLI reports the limit reached |
| `unknown` | No current reading. `unknownReason`: `not_read`, `stale` (over 15 minutes old), `not_applicable` (for example an API key), `read_failed`, `not_supported` |

Every state has `asOf`, and a stale reading keeps its. A window past `resetsAt` is discarded.

`unknown` scores the same as `known`, so an API-key login isn't starved, but it stays `unknown` in the UI, the phone and telemetry and never reads as available capacity. The decision carries `quotaBasis: "unknown_scored_as_healthy"`.

Percent used is only compared within a provider's own plan. There is no claim of equal cost across providers, and dollar fields aren't used.

### Load

A provider's helpers, across all orchestrators, that are creating, starting or have a live process, plus unexpired reservations. Sleeping, failed and disposed helpers don't count, nor do non-helper agents. Sleeping helpers still count toward the global helper cap.

## Selection

A pure function, one decision per start. Inputs that need a CLI are read before the global start lock, and the decision runs under it.

1. Candidates: enabled, available, Auto-eligible, a valid mapping cell, not cooling down.
2. Drop `exhausted`.
3. Keep the best tier: `known` and `unknown` together, otherwise `low`.
4. **Anchor:** the sticky provider if it survived, else the orchestrator's own CLI if it survived, else the first by registration order.
5. **Margin 2:** leave the anchor only if some provider in the tier has a load at least 2 lower. Among those, pick the lowest load, then registration order.

The margin applies only between providers in the same tier. A worse tier always loses, and it has no part in explicit or preset starts.

**Sticky.** The key is orchestrator plus difficulty, and the value is a provider, never a model or effort; the cell is always read fresh. Each Auto decision sets it, and it expires 30 minutes after the last one for that key. It is in memory only, never overrides steps 1 to 3, and doesn't touch running helpers.

**Reservations.** Added under the lock at decision time, so a burst sees earlier picks without depending on disk or the helper-index cache. Released when the helper counts as live, or the start fails or is cancelled, with a 5 minute backstop. A held approval doesn't reserve, because it decides when approved.

From 0/0 with the orchestrator on A, seven starts go A A B B B B A. The spread stays within 2. That balances helper counts, not cost.

**No candidate:** an immediate refusal naming each provider's reason. Nothing is queued. Explicit starts are never blocked by quota or a cooldown, only warned.

**One decision.** Routing never runs again for that helper. A wake reuses its saved CLI, model and effort and resumes its session. A quota change, rate limit or failure after the task is delivered never moves it. If a saved model has gone, the wake fails or falls to the CLI default as any agent does, and is reported.

## Failures

Classified from existing signals: `auth_required`, `account_issue`, `rate_limited`, `isLoginRequiredError` and spawn failures.

| Class | Signal | Cooldown (Auto only, per provider and profile) | Retry |
|---|---|---|---|
| `auth` | Login required, account issue | 10 minutes | Allowed before delivery |
| `quota` | `rate_limited` | Until `resetsAt`, else 30 minutes. State becomes `exhausted`. | Allowed before delivery |
| `availability` | Spawn failed, missing binary, model rejected | 5 minutes | Allowed before delivery |
| `task` | Anything else after delivery: tool failure, context overflow, exit | None | Never |

- A failed start can exclude a provider whose quota is unknown, but only for `auth`, `quota` or `availability`, and only for that cooldown. Unknown quota alone never excludes.
- A `quota` or `auth` error after delivery sets the cooldown for future starts. That helper isn't moved or retried.
- At most one alternate provider per start, only if the spawn failed and the task was never delivered. Cooldowns are fixed and in memory.

## Context window

Auto adds no rule to #2660's context setting (#2668, not merged when this was written):

- A saved choice is per CLI and model. A model change keeps one the model offers and clears one it doesn't. A CLI change clears it.
- At launch, `contextWindowForLaunch` clears a refused choice and keeps, without passing, one it can't check. Both emit the `context_window_not_applied` notice.

v1 has no context column and `start_helper` has no context argument, so the only case is a persona supplying a choice against the model Auto picked. It is reported as `routing.context.status`: `none`, `applied`, `reset` or `not_applied`. A wake doesn't change the model, so it adds no case.

Effort follows the same idea more simply: any change of model or CLI clears it.

## Explanation

`start_helper` and `list_helpers` return `routing`, saved on the helper and shown on the Helpers card and helper header. It describes the decision, not live quota, and is absent on helpers started before this. `balanced` is false for anything but `auto`, so nothing claims Auto balanced a helper an explicit argument decided.

```json
"routing":{"mode":"auto","balanced":true,"decidedAt":"…","policyVersion":1,
 "requested":{"provider":"auto","model":null,"effort":null,"difficulty":"hard"},
 "resolved":{"provider":"codex-cli","model":"gpt-6.1-sol","effort":"high","difficulty":"hard"},
 "source":{"provider":"auto","model":"builtin_mapping","effort":"builtin_mapping"},
 "reason":"lower_load","fallback":"none","quotaBasis":"known",
 "load":{"claude-code":2,"codex-cli":0},
 "quota":{"codex-cli":{"state":"known","asOf":"…"},"claude-code":{"state":"unknown","unknownReason":"read_failed","asOf":null}},
 "context":{"status":"none"}}
```

Stable codes:

- `reason`: `explicit_request`, `persona_pinned`, `preset_on_cli`, `only_candidate`, `lower_load`, `better_quota_tier`, `sticky`, `default_order`.
- `fallback`: `none`, `builtin_preset`, `candidate_skipped`, `model_unverified`, `retried_after_spawn_failure`.
- `source`: `request`, `persona`, `auto`, `orchestrator`, `custom_mapping`, `builtin_mapping`, `cli_default`.

MCP calls the provider `cli`, as `start_helper` does.

## Telemetry

Closed allowlists in `src/shared/telemetry/attributes.ts`, with no prompts, secrets or raw config.

- `clubhouse.helper.routed`: reuses `orchestrator` (resolved), `modelFamily` (never the raw id) and `outcome`. Adds requested CLI, difficulty, mode, effort, preset (`builtin`, `custom`, `none`), config source, reason, fallback, load bucket, quota state, staleness bucket, `quotaBasis`, failure class and `policyVersion`.
- `clubhouse.helper_routing.changed`: action (`set`, `toggle`, `reset_cell`, `reset_provider`, `reset_all`), surface and outcome.
- Add `orchestration` to `SETTINGS_KEYS`. `SAVE_ORCHESTRATION_SETTINGS` emits nothing today.

## Auditing settings changes

The writers today, from greps, so close but not proven complete. The audit PR should pin the list with a test.

- **Agent:** `updateDurableConfig` (IPC, mobile, persona application, and runtime bookkeeping like `lastSleep` and session ids), `updateDurable` (IPC, appearance, mobile), `setOrchestrationPolicy` (IPC, mobile, Dispatcher controls), persona reconcile, `turnOffOrchestration`, `setHelperStartFields`, `setParentAgent`, icon writes.
- **Project:** `PROJECT.UPDATE`, reset, cropped icon, write and reset of project agent defaults, instructions and permissions, MCP binding instructions and disabled tools.
- **App:** the `createSettingsStore` stores, mostly through `SAVE_*` in `app-handlers`, plus Annex, telemetry, marketplace and `dispatcher.setEnabled`.
- **MCP:** `update_agent`, `update_project`, and the Dispatcher controls, which `dispatcher-audit.ts` already records.

**Design.** Generalize `dispatcher-audit.ts` into a shared bounded log, with the same rotation and 1 MB cap. A row has surface (`ui`, `mcp`, `mobile`, `dispatcher`, `persona`, `system`), actor id, scope, key, target id, before, after, outcome and code. It hooks at service chokepoints and diffs the keys in the `settings-read-service` catalog. Values go through a per-key formatter (enum, bool, integer, provider id). Anything else, such as names or commands, records `changed: true` only. Bookkeeping fields are left out, and rows use project ids, not paths.

The first audit covers helper routing and `setOrchestrationPolicy`. Appearance and agent config come next, then the rest.

## Phone contract

**Not locked.** On the phone the provider is named `provider`.

**Capability:** `helperRouting:{version:1,scopes:["app","project","agent"],difficulties,modes,reasons,fallbacks,quotaStates,unknownReasons,cellStates}`. Absent means an older desktop: hide the UI and expect no `routing` on helpers. Treat an unknown enum value as other.

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

A cell with nothing valid has `effective: null`.

**Write:** command `helperRouting.update` with `{revision,scope,projectId?,auto?,cells?:[{provider,difficulty,model,effort}],reset?:{provider?,difficulty?}}`, returning fresh settings. A project scope accepts only `auto: "off"|null`. Errors: 400 `invalid_helper_routing`, 409 `helper_routing_stale`, 409 `model_unavailable`, 409 `effort_unavailable`. Agent scope stays in `orchestration.autoHelpers` through `agent.update`.

**Helper snapshot (minimal):** `routing:{mode,difficulty,provider,model,effort,reason}`.

**Helper settings (detailed):** `GET /mobile/agents/:id/settings` carries the full `routing` above.

**Held starts:** the helper request gets `requestedRouting`. `resolved` comes at approval.

**Fixtures:** capability present and absent; each quota state, including `unknown` with and without a stale `asOf`; an explicit override (Sol, `explicit_request`, `balanced: false`); a preset on a CLI; a persona pin; project-disabled; a stale preset falling back to built-in; stale with nothing valid; Copilot excluded; context `reset` and `not_applied`; stale-write and reset results.

## Orchestrator guidance

To replace the persona's model lines once Auto ships. The `start_helper` description and the difficulty enum carry the short form, and a test pins the wording against claims like "best" or "cheapest".

> - For most tasks, name a difficulty. `easy`: mechanical, well specified, easy to check (a rename, a doc fix, one test). `medium`: normal feature or bug work in a known area with clear acceptance. `hard`: ambiguous, cross-cutting, concurrency, security or data-loss risk, or a mistake that is costly to catch. Judge the task, not its urgency or size alone.
> - `difficulty` keeps the helper on your CLI. If Auto is on for you, `cli: "auto"` with a difficulty lets Clubhouse pick the provider. If it is off, `start_helper` refuses; ask the user or name a CLI.
> - Name a CLI, model or effort only when the task or the user needs that one. They always win, and nothing is balanced for that helper.
> - Read `routing` in the result and report what it says. Unknown quota means unknown, not available. Don't claim a choice is cheapest, best or preferred, and don't compare cost across providers.
> - A helper stays on its provider for its whole task. If Auto refuses, tell the user the reasons or start with an explicit CLI. Don't retry in a loop.

## Open items

- **Terminal signal limit.** Terminal helpers report no error codes, so their failures after spawn aren't seen, no cooldown is set, and quota stays whatever the last read said.
- **Worktree check, stage 4.** Whether a worktree prepared for one CLI can be switched to another. If it can't, the retry is dropped and the start fails as today with its task saved. Cooldowns stay either way.
- **Phone wire** isn't locked.
- **Context and Auto** haven't been tested together, and #2668 was still open when this was written.

## Stages

One PR each.

1. Explicit `effort` on `start_helper`. Built.
2. Mapping and `difficulty` in `preset` mode: settings, validation, reset, UI, explanation, telemetry, phone read and write, restoring explicit fields after a persona applies, first audit rows.
3. Quota service: read-only, shown in Settings and on the phone.
4. `cli: "auto"`: routing, load, sticky, reservations, cooldowns, retry, tool and persona guidance.
5. Wider audit.
