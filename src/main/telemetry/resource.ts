/**
 * Resource attributes (spec §5.4), built by hand. No resource detectors: the
 * OTel defaults add host.name and process args, which would leak.
 * `service.instance.id` is set explicitly, otherwise the Azure exporter falls
 * back to os.hostname() for cloud_RoleInstance.
 */
import { TELEMETRY_SCHEMA_VERSION, type TelemetryLevel } from '../../shared/telemetry/attributes';

export interface ResourceInputs {
  appVersion: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  nodeVersion: string;
  electronVersion: string;
  installId: string;
  instanceId: string;
  level: TelemetryLevel;
  annexRole: 'none' | 'satellite' | 'controller' | 'both';
  /** Which chrome shell this session runs (docs/chrome-redesign-spec.md §8). Fixed for the session. */
  uiChrome: 'legacy' | 'v2';
}

/** Keys we set. Anything else on the resource is a bug (asserted in tests). */
export const RESOURCE_KEYS = [
  'service.name',
  'service.version',
  'service.instance.id',
  'clubhouse.install.id',
  'enduser.pseudo.id',
  'clubhouse.channel',
  'deployment.environment.name',
  'os.type',
  'os.version',
  'host.arch',
  'process.runtime.version',
  'clubhouse.electron.version',
  'clubhouse.telemetry.schema',
  'clubhouse.telemetry.level',
  'clubhouse.annex.role',
  'clubhouse.ui.chrome',
] as const;

const OS_TYPE: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'darwin',
  win32: 'windows',
  linux: 'linux',
};

const HOST_ARCH: Record<string, string> = {
  arm64: 'arm64',
  x64: 'amd64',
  ia32: 'x86',
  arm: 'arm32',
};

/** `25.5.0` → `25.5`; `10.0.26100` → `10.0`. */
export function majorMinor(version: string): string {
  const m = /^(\d+)(?:\.(\d+))?/.exec(version);
  if (!m) return 'unknown';
  return m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1];
}

export function channelForVersion(version: string): 'stable' | 'preview' {
  return /-(?:beta|alpha|rc|preview)/i.test(version) ? 'preview' : 'stable';
}

export function buildResourceAttributes(input: ResourceInputs): Record<(typeof RESOURCE_KEYS)[number], string | number> {
  return {
    'service.name': 'clubhouse',
    'service.version': input.appVersion,
    'service.instance.id': input.instanceId,
    'clubhouse.install.id': input.installId,
    // Also copied onto every span and log record by the SDK: the Azure
    // exporter fills user_Id from item attributes, not from the resource.
    'enduser.pseudo.id': input.installId,
    'clubhouse.channel': channelForVersion(input.appVersion),
    'deployment.environment.name': input.isPackaged ? 'production' : 'development',
    'os.type': OS_TYPE[input.platform] ?? 'other',
    'os.version': majorMinor(input.osRelease),
    'host.arch': HOST_ARCH[input.arch] ?? 'other',
    'process.runtime.version': input.nodeVersion,
    'clubhouse.electron.version': input.electronVersion,
    'clubhouse.telemetry.schema': TELEMETRY_SCHEMA_VERSION,
    'clubhouse.telemetry.level': input.level,
    'clubhouse.annex.role': input.annexRole,
    'clubhouse.ui.chrome': input.uiChrome,
  };
}
