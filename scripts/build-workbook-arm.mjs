#!/usr/bin/env node
/**
 * Generates the Clubhouse Workbook deployment files (telemetry spec §6.10):
 *
 *  - docs/telemetry/workbook/azuredeploy.json: an ARM template that wraps
 *    clubhouse.workbook.json, for the "Deploy to Azure" button.
 *  - docs/telemetry/workbook/alerts.json: optional scheduled-query alert
 *    rules, one per P0 signal (§12.4). Created only when a user deploys them.
 *
 * Run after editing the workbook or the alert list:
 *   node scripts/build-workbook-arm.mjs
 * test/telemetry-workbook.test.ts fails if either file is out of date.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'docs', 'telemetry', 'workbook');

/**
 * One alert rule per P0 hot spot that has signals today. Each query returns
 * rows only when the condition holds; the rule fires when a 1-hour window
 * returns any row. H2 (CLI drift by c.provider.cli_version) and H9 (Annex)
 * are added when their instrumentation lands (Phase 4b, Phase 6).
 */
export const ALERTS = [
  {
    id: 'persistence-recovery',
    hotspot: 'H1',
    name: 'Clubhouse: data recovered or saves blocked',
    description: 'H1 persistence integrity: a store was recovered from backup, found unreadable, or a data-loss guard blocked saves.',
    severity: 2,
    query: [
      'customEvents',
      '| where name in ("clubhouse.persist.recovery", "clubhouse.persist.guard_blocked")',
      '| extend store = tostring(customDimensions["clubhouse.persist.store"])',
      '| summarize events = sum(itemCount), installs = dcount(user_Id) by name, store',
    ],
  },
  {
    id: 'permission-timeouts',
    hotspot: 'H3',
    name: 'Clubhouse: permission requests timed out or stuck',
    description: 'H3 hooks and permissions: a permission request timed out or stayed pending past the stuck threshold.',
    severity: 2,
    query: [
      'union',
      '  (requests | where name == "clubhouse.agent.permission" and tostring(customDimensions["clubhouse.permission.result"]) == "timeout" | summarize events = sum(itemCount) by kind = "timeout"),',
      '  (customEvents | where name == "clubhouse.agent.permission.stuck" | summarize events = sum(itemCount) by kind = "stuck")',
      '| where events > 0',
    ],
  },
  {
    id: 'plugin-activation-failures',
    hotspot: 'H5',
    name: 'Clubhouse: plugin activations failing',
    description: 'H5 plugin loading: three or more failed plugin activations in an hour, by error type.',
    severity: 3,
    query: [
      'requests',
      '| where name == "clubhouse.plugin.activate" and success == false',
      '| extend error = tostring(customDimensions["error.type"]), plugin = tostring(customDimensions["clubhouse.plugin.ref"])',
      '| summarize failures = sum(itemCount) by error, plugin',
      '| where failures >= 3',
    ],
  },
  {
    id: 'update-not-taken',
    hotspot: 'H6',
    name: 'Clubhouse: an applied update did not take',
    description: 'H6 auto-update: after an update was applied, the next start still ran the old version.',
    severity: 2,
    query: [
      'customEvents',
      '| where name == "clubhouse.update.apply_verified" and tostring(customDimensions["clubhouse.update.apply.verified"]) == "not_taken"',
      '| extend install = tostring(customDimensions["clubhouse.install.kind"])',
      '| summarize events = sum(itemCount), installs = dcount(user_Id) by install',
    ],
  },
  {
    id: 'agent-early-failures',
    hotspot: 'H7',
    name: 'Clubhouse: agents failing right after spawn',
    description: 'H7 agent lifecycle: over 20% of agent runs (at least 10) ended as early failures, by orchestrator.',
    severity: 2,
    query: [
      'customMetrics',
      '| where name == "clubhouse.agent.runs"',
      '| extend orchestrator = tostring(customDimensions["clubhouse.orchestrator"]), exit_class = tostring(customDimensions["clubhouse.agent.exit.class"])',
      '| summarize runs = sum(value), early = sumif(value, exit_class == "early_failure") by orchestrator',
      '| where runs >= 10 and 100.0 * early / runs > 20',
    ],
  },
  {
    id: 'bulletin-evictions',
    hotspot: 'H8',
    name: 'Clubhouse: bulletin messages evicted or rejected',
    description: 'H8 bulletin: a post pushed out older messages or was rejected (P0 while #1830 is open).',
    severity: 3,
    query: [
      'customMetrics',
      '| where name == "clubhouse.group.bulletin.posts"',
      '| extend result = tostring(customDimensions["clubhouse.bulletin.post.result"])',
      '| where result != "ok"',
      '| summarize posts = sum(value) by result',
      '| where posts > 0',
    ],
  },
  {
    id: 'file-save-failures',
    hotspot: 'H11',
    name: 'Clubhouse: file saves failing',
    description: 'H11 editor save path: writes from the file service failed, by error type.',
    severity: 2,
    query: [
      'customMetrics',
      '| where name == "clubhouse.file.ops"',
      '| where tostring(customDimensions["clubhouse.file.op"]) == "write" and tostring(customDimensions["clubhouse.file.result"]) == "error"',
      '| extend error = tostring(customDimensions["error.type"])',
      '| summarize failures = sum(value) by error',
      '| where failures > 0',
    ],
  },
];

export const PENDING_P0 = {
  H2: 'Spawn early failures grouped by c.provider.cli_version: added with Phase 4b.',
  H9: 'Annex connect, pair and reconnect failures: added with Phase 6.',
};

function buildDeploy(workbook) {
  return {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
    contentVersion: '1.0.0.0',
    metadata: { description: 'Clubhouse Workbook for Application Insights. Generated by scripts/build-workbook-arm.mjs; do not edit.' },
    parameters: {
      applicationInsightsResourceId: {
        type: 'string',
        metadata: { description: 'Resource ID of the Application Insights resource Clubhouse sends telemetry to.' },
      },
      workbookDisplayName: { type: 'string', defaultValue: 'Clubhouse' },
      workbookId: { type: 'string', defaultValue: '[newGuid()]', metadata: { description: 'Leave as is to create a new workbook.' } },
    },
    resources: [
      {
        type: 'microsoft.insights/workbooks',
        apiVersion: '2022-04-01',
        name: "[parameters('workbookId')]",
        location: '[resourceGroup().location]',
        kind: 'shared',
        properties: {
          displayName: "[parameters('workbookDisplayName')]",
          category: 'workbook',
          version: 'Notebook/1.0',
          sourceId: "[parameters('applicationInsightsResourceId')]",
          serializedData: JSON.stringify(workbook),
        },
      },
    ],
    outputs: {
      workbookResourceId: { type: 'string', value: "[resourceId('microsoft.insights/workbooks', parameters('workbookId'))]" },
    },
  };
}

function buildAlerts() {
  return {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
    contentVersion: '1.0.0.0',
    metadata: { description: 'Optional Clubhouse alert rules, one per P0 signal. Generated by scripts/build-workbook-arm.mjs; do not edit.' },
    parameters: {
      applicationInsightsResourceId: {
        type: 'string',
        metadata: { description: 'Resource ID of the Application Insights resource Clubhouse sends telemetry to.' },
      },
      actionGroupResourceId: {
        type: 'string',
        defaultValue: '',
        metadata: { description: 'Optional action group (email, Teams, ...) to notify. Leave empty to only show alerts in the portal.' },
      },
      alertsEnabled: { type: 'bool', defaultValue: true },
      location: { type: 'string', defaultValue: '[resourceGroup().location]' },
    },
    resources: ALERTS.map((a) => ({
      type: 'Microsoft.Insights/scheduledQueryRules',
      apiVersion: '2021-08-01',
      name: `clubhouse-${a.id}`,
      location: "[parameters('location')]",
      tags: { 'clubhouse-hotspot': a.hotspot },
      properties: {
        displayName: a.name,
        description: a.description,
        severity: a.severity,
        enabled: "[parameters('alertsEnabled')]",
        evaluationFrequency: 'PT1H',
        windowSize: 'PT1H',
        scopes: ["[parameters('applicationInsightsResourceId')]"],
        criteria: {
          allOf: [
            {
              query: a.query.join('\n'),
              timeAggregation: 'Count',
              operator: 'GreaterThan',
              threshold: 0,
              failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 },
            },
          ],
        },
        actions: {
          actionGroups: "[if(empty(parameters('actionGroupResourceId')), createArray(), createArray(parameters('actionGroupResourceId')))]",
        },
      },
    })),
  };
}

export function buildAll() {
  const workbook = JSON.parse(readFileSync(path.join(dir, 'clubhouse.workbook.json'), 'utf8'));
  return {
    'azuredeploy.json': JSON.stringify(buildDeploy(workbook), null, 2) + '\n',
    'alerts.json': JSON.stringify(buildAlerts(), null, 2) + '\n',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [file, content] of Object.entries(buildAll())) {
    writeFileSync(path.join(dir, file), content);
    console.log(`wrote docs/telemetry/workbook/${file}`);
  }
}
