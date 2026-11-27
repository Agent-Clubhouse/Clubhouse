# Mobile settings refresh: source assessment, 27 Nov 2026

Scope: read-only source inspection at `c041e7082ca4f72eaf65d4d83c6902b44182fd08`
and supplied installed beta.8 commit `30fd3ab0fdca6dbe75aed0b91e4c9878eded9b71`.
The reported ~6 s agent-settings/helper-routing versus ~20 ms Dispatcher-settings
durations are investigation inputs, not measurements reproduced here. No provider,
app endpoint, user check, client edit, or product behavior change was performed.

## Awaited paths

References below use source lines at c041e7082. Prefix mobile routes with `/api/v1`.

| Route | Work awaited before response |
| --- | --- |
| `/mobile/agents/:id/settings` | `annex-server.ts:4682`: find agent, then **parallel** settings, options, details; response waits for the slowest. Ordinary lookup scans projects sequentially using `peekDurableConfigs`; active Dispatcher lookup short-circuits (`:2040`). |
| settings branch | `mobile-agents.ts:317`: resolve provider if missing, resolve orchestration policy except for Dispatcher, then context options (`:368`). Context reads are performed even without a saved context override. `context-window.ts:24` bounds the context wait at 10 s; timeout does not cancel the underlying cache fill. |
| options branch | `mobile-agents.ts:134,433`: every **enabled** provider's availability and model picker list, parallel within/across providers. Availability failure does not skip the parallel model read. `modelOptions` awaits `getModelOptions`, falling back to Default on failure. No route-level deadline. |
| details branch | `mobile-agents.ts:406`: branch changes with counts against main, unless creating or Dispatcher. `git-service.ts:839` shares concurrent same-folder/base/counts reads; `readBranchChanges` resolves repo/head/base then diffs and counts. This is real awaited git work, despite only counts being returned. |
| `/mobile/helper-routing` | `annex-server.ts:4713`, `mobile-helper-routing.ts:86`: optional agent/project lookup, optional policy resolution, then `readHelperRouting`, then agent usability. `helper-routing.ts:982` awaits all preset providers, including ones reported disabled; non-preset quotas are read sequentially afterward, then Auto policy. |
| helper provider branch | `helper-routing.ts:925`: **first** `modelListFor`, including awaited catalog observation; **then parallel** all cell validations, quota read, availability. Normal mobile GET does not request forced refresh. On cold reads, catalog latency and subsequent quota latency can accumulate. Ordinary quota wait budget is 3 s (`provider-quota.ts:165`), with in-flight sharing, 5 min success cache and failure backoff. |
| `/mobile/dispatcher/settings` | `mobile-dispatcher-settings.ts:78`: in-memory Dispatcher state/config/usage and, for a principal, recursive memory directory metadata fingerprint (`dispatcher/dispatcher-forget.ts:63`). No provider option/model/context/branch reads. It is a different payload/workload, so ~20 ms does not establish that agent-settings should take the same time. |

All service paths above are under `src/main/services/`. The generic agent-settings
route still builds provider options and context for Dispatcher agents; its Dispatcher
flag only skips orchestration/git and adjusts editability. The separate Dispatcher
route does not call that generic builder. Settings does not internally call the
helper-routing endpoint: overlap requires separate requests; client scheduling was
outside this assessment.

## Overlap and redundant work

- **Already shared:** `src/main/orchestrators/base-provider.ts:245-270` implements
  picker options via `listModels`, keyed by sorted env, with shared in-flight loads.
  `modelListFor` (`model-check.ts:18`) uses that same provider list. Default-env
  settings and helper reads therefore share a live probe/cache on the same provider
  instance; repeated list calls alone do not prove repeated processes. Live TTL is
  10 min, fallback 1 min. A cold handshake has a 10 s deadline and can then attempt
  a command fallback (default 5 s); a six-second route is compatible with these
  waits but does not identify one.
- **Separate catalogs:** context uses its own cache/in-flight map
  (`base-provider.ts:285`). Codex model options use app-server `model/list`, while
  context launches `codex debug models` with a 5 s timeout
  (`codex-cli-provider.ts:314-342`); the source explicitly says model/list lacks
  context fields. Copilot named-model context uses a separate SDK tier-catalog
  read (`copilot-cli-provider.ts:137`); default/auto skips it. These can overlap
  model probes, but merging them requires proving equivalent data and semantics.
- **Proven repeated policy work:** `mobileHelperRouting` resolves policy before
  `readHelperRouting`, then `agentUse` resolves it again (`mobile-helper-routing.ts:73,88,100`).
  Each calls `resolveOrchestrationPolicies`, which reads project Auto defaults
  (`orchestration-policy.ts:204`). Agent settings independently resolves policy.
  `readHelperAuto` also reads project defaults (`helper-routing.ts:809`).
  Reusing one request's policy is a narrow candidate; it is not evidence of a
  six-second cause and must retain intended freshness semantics.
- **Repeated validation, usually cache hits:** helper cells call model and effort
  checks separately (`helper-routing.ts:104`), each through `modelListFor`, which
  awaits `observeHelperModelCatalog` (`helper-model-catalog.ts:68`). Observation can
  persist/notify a newly seen live catalog, but skips snapshots already observed.
  This is repeated wrapper/copy/validation work, not proven duplicate handshakes.
- **Availability is separate:** settings and helper routing both check providers;
  Codex availability invalidates shell-env cache and executes `--version` with a
  10 s timeout (`codex-cli-provider.ts:368`). No request-level coalescing appears
  there. Repeated concurrent checks are a candidate, not a measured bottleneck.

## Existing evidence and bounded next proof

`src/main/telemetry/annex-telemetry.ts:72` already provides route-template
`clubhouse.annex.rest` spans; `annex-request.ts:5` includes response finish/close
and emits traceparent when available. Use already captured spans to distinguish
overlapping requests from serial requests, under existing telemetry settings.
These spans do not split settings/options/details or identify a slow provider.
`git-service.ts:51,107` also records git subprocess durations and operation flows
when telemetry permits, useful for distinguishing awaited branch work.
Existing `core:orchestrator` probe/fallback/context-failure logs and helper quota
observations can corroborate failures; they are not complete successful-stage
timers. Do not force refresh, enable telemetry, or invoke probes merely to inspect.

Recommended targeted regressions, using deferred promises/fake providers only:

1. In the existing settings-route test area (`annex-server.test.ts:3586`), verify
   all three builders start before any settles and response waits for all; preserve
   Dispatcher git/orchestration exclusions. Existing payload tests do not prove
   concurrency. Use a handler seam if needed rather than real HTTP requests.
2. Extend provider cache tests (`base-provider.test.ts`, existing concurrent-list
   case) to overlap picker options and helper model reads; assert one probe per
   env and an independent context read. Include failed/fallback cache behavior.
3. If policy reuse is pursued, mock policy resolution and assert one read per
   helper-routing request, identical dispatcher/off/missing-agent behavior, and
   unchanged Auto explanation. First establish acceptable snapshot freshness.

No runtime regression was executed: documentation-only change, source/diff review
and whitespace validation only. Attribution of the reported delay remains deferred
pending existing per-stage evidence or an authorized isolated mock reproduction.

## Revision comparison

`git diff 30fd3ab0f c041e7082` shows no changes in the mobile settings builders,
Annex server, context service, model-check, quota service, git service, Dispatcher
memory fingerprint or orchestration-policy implementation. Helper routing and
catalog observation differ only in user-facing wording. Provider changes add an
instructions-path interface/method; agent registry changes add conversation timing,
not provider resolution. Thus these inspected paths supply no beta.8-to-head
settings-performance regression explanation. Installed binary behavior was not
independently verified.
