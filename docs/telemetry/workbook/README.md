# Clubhouse Workbook

A ready-made Azure Monitor Workbook for Clubhouse's opt-in telemetry export ([spec §6.10](../../telemetry-otel-spec.md)). It only applies to the Azure Application Insights destination. If you export over OTLP, build dashboards in your own backend.

## Deploy it

**One click:** [![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FAgent-Clubhouse%2FClubhouse%2Fmain%2Fdocs%2Ftelemetry%2Fworkbook%2Fazuredeploy.json)

The portal asks for the resource group and the **Application Insights resource ID** Clubhouse sends to. Find it on the resource's **Properties** page; it looks like `/subscriptions/…/resourceGroups/…/providers/microsoft.insights/components/…`. The workbook is created in that resource group and reads from that resource. Deploying again with the same workbook ID updates it in place.

**By hand:**

1. In the Azure portal, open your Application Insights resource and go to **Workbooks**.
2. Choose **New**, then open the **Advanced Editor** (the `</>` button).
3. Select **Gallery Template**, paste the contents of [`clubhouse.workbook.json`](clubhouse.workbook.json), and choose **Apply**.
4. **Save** the workbook into the same resource.

## Alerts (optional)

[![Deploy alerts to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FAgent-Clubhouse%2FClubhouse%2Fmain%2Fdocs%2Ftelemetry%2Fworkbook%2Falerts.json)

[`alerts.json`](alerts.json) creates one scheduled-query alert rule for each P0 signal in the spec (§12.4). Each rule checks the last hour, once an hour, and fires when its query returns any row. Nothing is created until you deploy it. Give it an **action group** to be emailed or paged; leave it empty to see alerts only in the portal.

| Rule | Hot spot | Fires when |
|---|---|---|
| Data recovered or saves blocked | H1 | a store was restored from backup, found unreadable, or a data-loss guard blocked saves |
| Permission requests timed out or stuck | H3 | a permission request timed out, or stayed pending past the stuck threshold |
| Plugin activations failing | H5 | three or more activations failed with the same error in an hour |
| An applied update did not take | H6 | the next start after an update still ran the old version |
| Agents failing right after spawn | H7 | over 20% of at least 10 runs ended as early failures, per orchestrator |
| Bulletin messages evicted or rejected | H8 | a post pushed out older messages or was rejected |
| File saves failing | H11 | a write from the file service failed |

H2 (CLI drift by `c.provider.cli_version`) and H9 (Annex) get their rules when their instrumentation lands. Thresholds are deliberately low for a single user's resource; edit the rules in the portal to tune them.

## Release checklist

Once per release that changes the workbook, the alert rules or the attribute registry:

1. Run `node scripts/build-workbook-arm.mjs` and commit `azuredeploy.json` and `alerts.json`. `test/telemetry-workbook.test.ts` fails if they are out of date or reference an unregistered name.
2. Deploy `azuredeploy.json` into a scratch resource group against a scratch Application Insights resource that has received data from a dev build.
3. Open every tab with **Time range** set to the last 24 hours. Each panel renders without a query error; panels for features you didn't use may be empty.
4. Deploy `alerts.json` with `alertsEnabled` set to `false`, check that every rule appears under **Alerts → Alert rules**, then delete the scratch resource group.
5. Note any panel or rule change in the release notes.

## Tabs

| Tab | Panels |
|---|---|
| Overview | Active installs, sessions by startup kind, version mix, crash-free sessions, unclean exits |
| Reliability | Exceptions by type and origin, renderer and child-process exits, window hangs, main-thread stalls by running flow, event-loop delay, memory by process type, long frames by view |
| Startup and updates | Startup p50/p95 by kind and version, startup phases, failed startups, the update funnel, applies that didn't take by install kind, update failures, safe-mode decisions |
| Data integrity | Write failures and write time by store, recoveries by store and action, saves blocked by data-loss guards, flush-barrier waits |
| Workspace (Phase 5) | Git operations and failures by type and error, status-poll time by changed files, slow polls, worktree create/remove, project add/remove/git init, projects per install, file operations by result, sandbox denials, file tree reads, search by engine, file watches, Monaco load, external editor and save conflicts, settings changed by area, feature use (theme, popouts, blueprints), bulletin posts by result, MCP tool lists including empty ones |
| Plugins and canvas (Phase 5) | Plugin activations and failures by plugin, origin and error, activation retries, plugin module requests, canvas loads by result, registry fetches, plugin installs/updates/uninstalls by failure stage, plugin update checks |
| Agents | Spawns and spawn failures by orchestrator, runtime and error; spawn time and spawn steps; CLI binary lookup by tier; how runs end; readiness; kills by trigger and stage; kill escalations; tool calls by bucket; Clubhouse MCP tool calls; permission waits; shoulder tap deliveries; durable create and delete |
| Annex | Pairing results; connects by address family; connect and discovery failures; identity regenerations and TLS fallbacks; reconnects by attempt; disconnects by reason; heartbeat RTT; control requests denied; remote spawns; the satellite event stream by type; connected clients; snapshot build and replays; REST routes (Detailed level) |
| Chat | Turns by driver and end reason (p50/p95), failed turns by error type, time to first token, protocol drift by driver and version, stalled turns, tokens by driver, chat permission waits |
| Goobers | Data age by model; stream mode changes; stream reconnects and terminal stops; liveness transitions; activation and daemon control; the poll loop (Detailed level) |

Permission panels live on the Agents tab. Detailed-level panels (tool-call time on Agents, slowest IPC invokes on Reliability, REST routes on Annex) stay empty below the Detailed level.

## Keeping it in sync

`test/telemetry-workbook.test.ts` checks every query against the attribute registry (`src/shared/telemetry/attributes.ts`). If a span, metric, event or attribute is renamed or removed, the test fails until the workbook is updated. Edit the JSON directly, and keep queries to registered names only.

Percentiles come from `requests` and `dependencies` (spans). Histogram metrics in `customMetrics` only carry count, sum, min and max.
