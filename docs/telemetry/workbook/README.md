# Clubhouse Workbook

A ready-made Azure Monitor Workbook for Clubhouse's opt-in telemetry export ([spec §6.10](../../telemetry-otel-spec.md)). It only applies to the Azure Application Insights destination. If you export over OTLP, build dashboards in your own backend.

## Import it

1. In the Azure portal, open your Application Insights resource and go to **Workbooks**.
2. Choose **New**, then open the **Advanced Editor** (the `</>` button).
3. Select **Gallery Template**, paste the contents of [`clubhouse.workbook.json`](clubhouse.workbook.json), and choose **Apply**.
4. **Save** the workbook into the same resource.

A one-click **Deploy to Azure** button and optional alert rules come in Phase 7.

## What's in v1

| Tab | Panels |
|---|---|
| Overview | Active installs, sessions by startup kind, version mix, crash-free sessions, unclean exits |
| Reliability | Exceptions by type and origin, renderer and child-process exits, window hangs, main-thread stalls by running flow, event-loop delay, memory by process type, long frames by view |
| Startup and updates | Startup p50/p95 by kind and version, startup phases, failed startups, the update funnel, applies that didn't take by install kind, update failures, safe-mode decisions |
| Data integrity | Write failures and write time by store, recoveries by store and action, saves blocked by data-loss guards, flush-barrier waits |
| Workspace (Phase 5) | Git operations and failures by type and error, status-poll time by changed files, slow polls, worktree create/remove, project add/remove/git init, projects per install, file operations by result, sandbox denials, file tree reads, search by engine, file watches, Monaco load, external editor and save conflicts, settings changed by area, feature use (theme, popouts, blueprints), bulletin posts by result, MCP tool lists including empty ones |
| Plugins and canvas (Phase 5) | Plugin activations and failures by plugin, origin and error, activation retries, plugin module requests, canvas loads by result, registry fetches, plugin installs/updates/uninstalls by failure stage, plugin update checks |

Agents, Permissions and Annex tabs are added with telemetry Phases 4 and 6, in the same PRs as the instrumentation they chart.

## Keeping it in sync

`test/telemetry-workbook.test.ts` checks every query against the attribute registry (`src/shared/telemetry/attributes.ts`). If a span, metric, event or attribute is renamed or removed, the test fails until the workbook is updated. Edit the JSON directly, and keep queries to registered names only.

Percentiles come from `requests` and `dependencies` (spans). Histogram metrics in `customMetrics` only carry count, sum, min and max.
