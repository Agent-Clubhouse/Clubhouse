import { usePluginUpdateStore } from '../../stores/pluginUpdateStore';
import { approvePluginPermissions, rejectPluginPermissions } from '../../plugins/plugin-loader';
import type { PluginRegistryEntry } from '../../../shared/plugin-types';
import { PERMISSION_RISK_LEVELS } from '../../../shared/plugin-types';
import { DEPRECATED_PLUGIN_API_VERSIONS } from '../../../shared/marketplace-types';
import { settingsButton } from './SettingsLayout';

/** Phase label for inline update progress. */
const UPDATE_PHASE_LABELS: Record<string, string> = {
  downloading: 'Downloading…',
  installing: 'Installing…',
  reloading: 'Reloading…',
};

/**
 * One plain line per thing about a plugin that needs action: incompatible,
 * error, deprecated API, permissions to approve, an update. Renders nothing
 * when all is well. Shared by the plugin list rows and the plugin detail page.
 */
export function PluginStatusLines({ entry }: { entry: PluginRegistryEntry }) {
  const id = entry.manifest.id;
  const updateInfo = usePluginUpdateStore((s) => s.updates.find((u) => u.pluginId === id));
  const updatePhase = usePluginUpdateStore((s) => s.updating[id]);
  const updateError = usePluginUpdateStore((s) => s.updateErrors[id]);
  const updatePlugin = usePluginUpdateStore((s) => s.updatePlugin);

  const isIncompatible = entry.status === 'incompatible';
  const isErrored = entry.status === 'errored';
  const isPendingApproval = entry.status === 'pending-approval';
  const isUpdating = !!updatePhase;
  const updateVersion = updateInfo?.latestVersion;
  const api = entry.manifest.engine?.api;
  const deprecatedRemoval = api !== undefined ? DEPRECATED_PLUGIN_API_VERSIONS[api] : undefined;

  const newline = entry.error ? entry.error.indexOf('\n') : -1;
  const errorMessage = entry.error ? (newline >= 0 ? entry.error.slice(0, newline) : entry.error) : null;
  const errorStack = entry.error && newline >= 0 ? entry.error.slice(newline + 1) : null;

  return (
    <>
      {isIncompatible && !errorMessage && (
        <p className="text-xs text-ctp-error mt-0.5">Doesn&apos;t work with this version of Clubhouse.</p>
      )}
      {isErrored && !errorMessage && (
        <p className="text-xs text-ctp-error mt-0.5" data-testid={`plugin-error-${id}`}>Error</p>
      )}
      {!isIncompatible && deprecatedRemoval && (
        <p className="text-xs text-ctp-warning mt-0.5" data-testid={`deprecated-api-${id}`}>
          Uses plugin API {api}, which stops loading in {deprecatedRemoval}.
        </p>
      )}
      {errorMessage && (
        <div className="mt-0.5" data-testid={`plugin-error-${id}`}>
          <p className="text-xs text-ctp-error">{errorMessage}</p>
          {errorStack && (
            <details className="mt-0.5">
              <summary className="text-xs text-ctp-overlay1 cursor-pointer hover:text-ctp-text">View details</summary>
              <pre className="text-xs text-ctp-overlay1 bg-ctp-crust border border-surface-0 p-2 rounded-md mt-1 overflow-auto max-h-32 whitespace-pre-wrap">{errorStack}</pre>
            </details>
          )}
        </div>
      )}
      {isPendingApproval && entry.pendingPermissions && (
        <div className="mt-1 flex items-center gap-3" data-testid={`pending-approval-${id}`}>
          <p className="flex-1 min-w-0 text-xs text-ctp-warning">
            This update needs more permissions:{' '}
            {entry.pendingPermissions.map((perm, i) => (
              <span key={perm}>
                {i > 0 && ', '}
                <span className={`font-mono ${PERMISSION_RISK_LEVELS[perm] === 'dangerous' ? 'text-ctp-error' : ''}`}>{perm}</span>
              </span>
            ))}
          </p>
          <button
            onClick={() => rejectPluginPermissions(id)}
            className={settingsButton.quiet}
            data-testid={`reject-btn-${id}`}
          >
            Reject
          </button>
          <button
            onClick={() => approvePluginPermissions(id)}
            className={settingsButton.ghost}
            data-testid={`approve-btn-${id}`}
          >
            Approve and turn on
          </button>
        </div>
      )}
      {updateVersion && !isUpdating && (
        <div className="mt-1 flex items-center gap-3" data-testid={`update-badge-${id}`}>
          <p className="flex-1 min-w-0 text-xs text-ctp-success">Version {updateVersion} is available.</p>
          <button
            onClick={() => updatePlugin(id)}
            className={settingsButton.ghost}
            title={`Update to ${updateVersion}`}
            data-testid={`update-btn-${id}`}
          >
            Update
          </button>
        </div>
      )}
      {isUpdating && (
        <p className="text-xs text-ctp-overlay1 mt-0.5" data-testid={`update-phase-${id}`}>
          {UPDATE_PHASE_LABELS[updatePhase] || 'Updating…'}
        </p>
      )}
      {updateError && (
        <p className="text-xs text-ctp-error mt-0.5">Update failed. {updateError}</p>
      )}
    </>
  );
}
