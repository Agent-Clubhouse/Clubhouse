/**
 * Azure Application Insights destination (@azure/monitor-opentelemetry-exporter
 * 1.0.0-beta.46, pinned exactly).
 *
 * The exporter can contact two Microsoft-owned hosts besides the user's
 * ingestion endpoint. Both are switched off here and covered by the
 * egress-allowlist test (telemetry-egress.test.ts):
 *
 *  - Statsbeat (SDK health metrics to westus-0 / westeurope-5 ingestion and
 *    the 169.254.169.254 IMDS probe). In beta.46 the only switch that stops
 *    the exporter from creating its StatsbeatManager is the legacy
 *    `APPLICATION_INSIGHTS_NO_STATSBEAT` env var, read in the exporter
 *    constructor (`export/base.js`). `APPLICATIONINSIGHTS_STATSBEAT_DISABLED`
 *    only disables "non-essential" statsbeat, and
 *    `APPLICATIONINSIGHTS_SDKSTATS_DISABLED` only the customer SDK stats; we
 *    set all three.
 *  - OneSettings remote configuration (settings.sdk.monitor.azure.com),
 *    polled 5–15 s after the first exporter is constructed. beta.46 has no
 *    option or env var for it, and it can remotely flip offline storage and
 *    SDK stats. We pre-seed the process-wide ConfigurationManager singleton
 *    with an inert worker so `initialize()` returns early and no poll timer is
 *    ever scheduled.
 */
import { AzureMonitorTraceExporter, AzureMonitorMetricExporter, AzureMonitorLogExporter } from '@azure/monitor-opentelemetry-exporter';
// Not in the package's export map. A relative path into node_modules is
// resolved as a plain file by webpack, tsc and vitest alike, and lands on the
// same CommonJS module instance the exporter's own `require` uses (webpack
// and the vitest alias both pick the package's `require` condition).
import { ConfigurationManager } from '../../../../node_modules/@azure/monitor-opentelemetry-exporter/dist/commonjs/_configuration/configurationManager.js';
import type { DestinationExporters } from './types';

export const STATSBEAT_ENV_FLAGS = {
  APPLICATION_INSIGHTS_NO_STATSBEAT: 'true',
  APPLICATIONINSIGHTS_STATSBEAT_DISABLED: 'true',
  APPLICATIONINSIGHTS_SDKSTATS_DISABLED: 'true',
} as const;

export interface AzureDestinationOptions {
  connectionString: string;
  storageDirectory: string;
}

const INERT_WORKER = Object.freeze({ shutdown: () => {} });

interface ConfigurationManagerInternals {
  worker?: unknown;
}

/** Stop OneSettings polling before any exporter can start it. */
export function neutralizeOneSettings(): void {
  const manager = ConfigurationManager.getInstance() as unknown as ConfigurationManagerInternals;
  if (manager.worker !== INERT_WORKER) {
    ConfigurationManager.getInstance().shutdown();
    manager.worker = INERT_WORKER;
  }
}

/** True while OneSettings polling is held off. Used by the egress test. */
export function isOneSettingsNeutralized(): boolean {
  return (ConfigurationManager.getInstance() as unknown as ConfigurationManagerInternals).worker === INERT_WORKER;
}

export function createAzureExporters(opts: AzureDestinationOptions): DestinationExporters {
  for (const [name, value] of Object.entries(STATSBEAT_ENV_FLAGS)) process.env[name] = value;
  neutralizeOneSettings();

  const common = {
    connectionString: opts.connectionString,
    storageDirectory: opts.storageDirectory,
    disableOfflineStorage: false,
  };
  const exporters: DestinationExporters = {
    spanExporter: new AzureMonitorTraceExporter(common),
    metricExporter: new AzureMonitorMetricExporter(common),
    logExporter: new AzureMonitorLogExporter(common),
  };

  // Belt and braces: if a future exporter version swaps the worker, stop it.
  if (!isOneSettingsNeutralized()) neutralizeOneSettings();
  return exporters;
}
