# Opt-in reset-aware Auto and retained reserves

Implemented on a task branch for review; not activated in anyone's saved settings. The user selected calendar urgency, configurable provider reserves starting at10% when explicitly opted in, and **no automatic reserve relaxation**. The approved research remains at `f386b143fda60d969c705dcb397c9458b6ae0035`; its simulations are not measurements of this implementation's savings or future task consumption.

## User behavior

Settings > Smart selection offers “Prefer useful work before quota resets.” Enabling it saves version1 plus both selected retained percentages; absence keeps the legacy weekly-use policy. It does not enable Auto itself or change the saved Copilot last-resort switch. Turning the preference off stores `enabled:false` with the selected percentages retained for a later opt-in. Mapping Reset resets mappings only.

For Claude Code and Codex, “Keep for me (%)” accepts whole percentages0–100 per provider. The percentage applies to the provider's shared local login across orchestrators, in every applicable reported window. It is not a separate allowance for each router, project, model or helper. A0% reserve is an explicit choice to admit below100%; a100% reserve admits no new measured-provider starts. Neither changes provider-reported hard limits. There is no relaxation field, button, implicit exception, scripting engine or mode that changes a reserve near reset.

At each fresh Auto start, under the existing start lock:

1. Preserve permission/scope, provider enabled/available, mapping/model/effort, cooldown, helper cap and prepared mapping-generation checks. An explicit provider/model choice, preset, wake or already-resolved plan does not enter the new provider selector.
2. Provider-reported exhaustion always blocks. Require fresh (at most15min old), complete usage for every applicable measured window. Unreadable/stale/future/expired windows block that measured provider until a new observation arrives. A fresh short window cannot vouch for an expired weekly window. Only model windows matching the existing exact mapped-model rule count; unrelated model windows do not become constraints.
3. Set the admission ceiling to `100% - retained%`. Block equality as well as a higher reported value. When one existing qualified aggregate remaining-pressure forecast covers all applicable windows for the exact current used values/reset epochs, also block at `used + upper >= ceiling`. This bound covers live, pending and proposed work as one group; no helper-count or token-to-quota conversion is introduced. Missing/partial/cold forecasts leave admission observation-only, explicitly labeled unavailable.
4. For verified measured candidates with weekly usable budget `max(0,100%-used%-retained%)`, prefer reset deadlines within48h, with stronger priority within24h. Boundaries are inclusive. Earlier reset wins within a band. Equal band/reset peers compare existing comparable weekly pressure, then load/tie-band/rotation across the old80% tiers (AR1). Missing reset disables urgency for that candidate; complete fresh usage can still support normal admission. A passed reset is never treated as a reported zero.
5. Otherwise retain normal quota-tier/verification/pressure/load/rotation preference among admitted providers. Copilot stays behind every eligible measured provider, with quota explicitly unknown and no numeric score/reserve. The saved Copilot switch is rechecked under the lock. If none is eligible and Copilot is disallowed/unavailable, refuse with per-provider reasons; do not cross a reserve or create a later job automatically.

No task is generated, duplicated, moved or inflated to consume quota. A helper keeps its provider and mapped effort for the run. Existing failure cooldown and no-cross-provider-retry behavior remain.

## Limits and deferred pace

The reserve is an **admission threshold**, not a guaranteed physical remaining balance. Running tasks, simultaneous cold starts, delayed quota samples or outside activity can still use more. The original research's89%→93% four-start example remains a limit, not a claim of protection against it. Qualified bounds reduce risk but remain empirical predictions.

This version implements calendar priority completely without collecting new rate history. It does **not** estimate sustainable pace, observed rate or an implied burn-rate delta, and never inserts unknown rate as zero. UI and helper explanations explicitly say burn pace was not measured. The existing subscription-group forecast is not divided by helper count or extrapolated into a continuous rate. No observation buffer, probe, polling thread, paid inference, token/cost conversion or new collection destination is added.

Reset-crossing/inflight coverage checks invalidate expired quota windows and do not reuse old-epoch group bounds, even if the percentage happens to match. They do not predict or reroute the remainder of a running task across a future reset; no live completion guarantee or cross-epoch task-consumption measurement is claimed. A fresh post-reset observation can resume cold routing.

## Storage, compatibility and pending edits

`orchestration-settings.json` adds optional `helperAutoBudget`. A current valid value is:

```json
{"version":1,"enabled":true,"reserves":{"claude-code":10,"codex-cli":10}}
```

There is no migration for absent policy and no automatic opt-in. The writer validates this closed schema, integer range, known provider keys and absence of relaxation/unknown fields. A present malformed/future policy is preserved on unrelated writes and fails closed for Auto, rather than silently falling back to legacy or discarding future configuration. The settings view exposes a repair path, not the raw unreadable payload. Explicit valid off/on replaces it. This does not promise that an older app binary that does not know the field will preserve it; mixed-binary downgrade needs separate consideration. Older clients using this server's existing partial APIs omit the new field, preserve it and continue using revision conflict checks.

All app writers remain serialized and atomic. Higher reserves and newly required complete-quota checks apply while pending, including a valid restrictive request queued behind a model read or another settings save. Pending enable enforces conservative admission without enabling deadline preference before commit. Lower reserves, disabling the preference and other loosening wait for durable commit. Concurrent restrictions combine with the stricter retained percentage; a failed/stale request releases only its own restriction. Budget-only edits advance the shared settings revision without advancing mapping cell identities. Project-scope budget writes are refused. Current presets-only MCP writes remain presets-only and preserve this policy; no grant changes are introduced.

Shared settings/updates include optional budget capability and app-only editing information. Mobile `helperRouting.update` accepts the optional closed policy schema only behind the existing authorization path; old commands remain valid. Capabilities advertise `resetAwareBudget:1`. Generic labels cover new reasons for older clients. Targeted routing fixtures use relative revision bases and routing-local example identifiers, preserving request/response joins and avoiding dependence on unrelated producer cases. The normal full fixture generator still works; a routing-only profile checks/regenerates eight existing routing fixture files without deleting or changing unrelated fixtures.

## Explanations, privacy and validation

Each affected decision records policy version4, effective mode/reserve/ceiling, usable weekly budget/reset/urgency when known, forecast availability, observation versus prediction admission block and rank/pressure for the final comparison pool. Chosen helper routing preserves a decision-time budget receipt. Reasons distinguish the configured reserve or incomplete quota from provider exhaustion. Copilot receives no numeric capacity or invented forecast. Detailed attributes use the existing consent-gated local-only candidate events; the closed reason remains the ordinary summary. Audit records bounded selected values on the existing local audit path. No prompts, account identifiers, task text, new telemetry destination or raw rule configuration is recorded.

Tests target the production pure selector and actual fresh-start path (AR1, qualified/cold/partial means, disabled forecasts, 24/48h boundaries, custom reserves/equality/all-window hard limits, Copilot fallback/opt-out); real persistence/start races (queued restrictive writes, failed rename, stale request, committed loosening, mapping identities); old-client/schema/invalid-version preservation; quota expiry/new-epoch and forecast epoch invalidation; UI toggles/preserved values/capability absence; local-only receipts and legacy/resolved plans. Full root `tsconfig.json` remains ES2020. No installed app, settings activation, actual provider start or paid/live routing experiment is used.

Validation uses the existing byte-matched lock cache only through reversible worktree-local package links; shared `.vite`/cache directories are not linked. Original layout is restored after checks. Test/lint admission uses min4GiB, compiler min6GiB, Vitest maxWorkers2 total, and gate75 retries at least60s apart. Exact committed-head/tree/source/command/exit/raw-output receipts accompany the review handoff. Historical development failures remain labeled as such. Independent review is required before a PR; CI, merging and release/live rollout remain separate gates. The public release hold is unchanged.
