import { usePluginUpdateStore } from '../../stores/pluginUpdateStore';

export function PluginUpdateBanner() {
  const updates = usePluginUpdateStore((s) => s.updates);
  const dismissed = usePluginUpdateStore((s) => s.dismissed);
  const updating = usePluginUpdateStore((s) => s.updating);
  const dismiss = usePluginUpdateStore((s) => s.dismiss);
  const updateAll = usePluginUpdateStore((s) => s.updateAll);
  const updatePlugin = usePluginUpdateStore((s) => s.updatePlugin);

  if (updates.length === 0 || dismissed) return null;

  const isUpdating = Object.keys(updating).length > 0;
  const pluginNames = updates.map((u) => u.pluginName);
  const message =
    updates.length === 1
      ? `Plugin update available: ${pluginNames[0]} v${updates[0].latestVersion}`
      : `${updates.length} plugin updates available: ${pluginNames.join(', ')}`;

  const handleUpdate = () => {
    if (updates.length === 1) {
      updatePlugin(updates[0].pluginId);
    } else {
      updateAll();
    }
  };

  return (
    <div
      className="flex-shrink-0 flex items-center gap-3 px-4 py-2 bg-green-500/10 border-b border-green-500/20 text-green-200 text-sm"
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
      </span>

      <button
        onClick={handleUpdate}
        disabled={isUpdating}
        className="px-3 py-1 text-xs rounded bg-green-500/20 hover:bg-green-500/30
          transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        data-testid="plugin-update-btn"
      >
        {isUpdating ? 'Updating...' : 'Update now'}
      </button>

      <button
        onClick={dismiss}
        className="text-green-200/50 hover:text-green-200 transition-colors cursor-pointer px-1"
        data-testid="plugin-update-dismiss-btn"
      >
        x
      </button>
    </div>
  );
}
