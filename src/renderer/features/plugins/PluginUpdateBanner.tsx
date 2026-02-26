import { usePluginUpdateStore } from '../../stores/pluginUpdateStore';

export function PluginUpdateBanner() {
  const updates = usePluginUpdateStore((s) => s.updates);
  const dismissed = usePluginUpdateStore((s) => s.dismissed);
  const updating = usePluginUpdateStore((s) => s.updating);
  const updateErrors = usePluginUpdateStore((s) => s.updateErrors);
  const dismiss = usePluginUpdateStore((s) => s.dismiss);
  const updateAll = usePluginUpdateStore((s) => s.updateAll);
  const updatePlugin = usePluginUpdateStore((s) => s.updatePlugin);
  const clearUpdateError = usePluginUpdateStore((s) => s.clearUpdateError);

  const hasErrors = Object.keys(updateErrors).length > 0;
  const isUpdating = Object.keys(updating).length > 0;

  // Show banner if there are updates available OR if there are unresolved errors
  if ((updates.length === 0 && !hasErrors) || dismissed) return null;

  const pluginNames = updates.map((u) => u.pluginName);

  const handleUpdate = () => {
    if (updates.length === 1) {
      updatePlugin(updates[0].pluginId);
    } else {
      updateAll();
    }
  };

  // If there are only errors (no pending updates), show error-only banner
  if (updates.length === 0 && hasErrors) {
    const errorEntries = Object.entries(updateErrors);
    return (
      <div
        className="flex-shrink-0 flex items-center gap-3 px-4 py-2 bg-ctp-peach/10 border-b border-ctp-peach/20 text-ctp-peach text-sm"
        data-testid="plugin-update-banner"
      >
        {/* Warning icon */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>

        <span className="flex-1" data-testid="plugin-update-message">
          {errorEntries.length === 1
            ? `Plugin reload failed — restart may be needed`
            : `${errorEntries.length} plugins failed to reload — restart may be needed`}
        </span>

        <button
          onClick={() => errorEntries.forEach(([id]) => clearUpdateError(id))}
          className="text-ctp-peach/50 hover:text-ctp-peach transition-colors cursor-pointer px-1"
          data-testid="plugin-update-dismiss-btn"
        >
          x
        </button>
      </div>
    );
  }

  const message =
    updates.length === 1
      ? `Plugin update available: ${pluginNames[0]} v${updates[0].latestVersion}`
      : `${updates.length} plugin updates available: ${pluginNames.join(', ')}`;

  return (
    <div
      className="flex-shrink-0 flex items-center gap-3 px-4 py-2 bg-ctp-success/10 border-b border-ctp-success/20 text-ctp-success text-sm"
      data-testid="plugin-update-banner"
    >
      {/* Package icon */}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
        <path d="M16.5 9.4 7.55 4.24" />
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.29 7 12 12 20.71 7" />
        <line x1="12" y1="22" x2="12" y2="12" />
      </svg>

      <span className="flex-1" data-testid="plugin-update-message">
        {message}
        {hasErrors && (
          <span className="text-ctp-peach ml-2">
            ({Object.keys(updateErrors).length} failed to reload)
          </span>
        )}
      </span>

      <button
        onClick={handleUpdate}
        disabled={isUpdating}
        className="px-3 py-1 text-xs rounded bg-ctp-success/20 hover:bg-ctp-success/30
          transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        data-testid="plugin-update-btn"
      >
        {isUpdating ? 'Updating...' : hasErrors ? 'Retry' : 'Update now'}
      </button>

      <button
        onClick={dismiss}
        className="text-ctp-success/50 hover:text-ctp-success transition-colors cursor-pointer px-1"
        data-testid="plugin-update-dismiss-btn"
      >
        x
      </button>
    </div>
  );
}
