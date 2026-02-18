import { useUpdateStore } from '../../stores/updateStore';

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`
        relative w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer
        ${checked ? 'bg-indigo-500' : 'bg-surface-2'}
      `}
    >
      <span
        className={`
          absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform duration-200
          ${checked ? 'translate-x-4' : 'translate-x-0'}
        `}
      />
    </button>
  );
}

export function UpdateSettingsView() {
  const settings = useUpdateStore((s) => s.settings);
  const saveSettings = useUpdateStore((s) => s.saveSettings);
  const status = useUpdateStore((s) => s.status);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);

  const stateLabel: Record<string, string> = {
    idle: 'Up to date',
    checking: 'Checking...',
    downloading: 'Downloading...',
    ready: 'Update ready',
    error: 'Error',
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Updates</h2>
        <p className="text-sm text-ctp-subtext0 mb-6">
          Manage automatic update checks and downloads.
        </p>

        {/* Auto-update toggle */}
        <div className="flex items-center justify-between py-3 border-b border-surface-0">
          <div>
            <div className="text-sm text-ctp-text font-medium">Automatic updates</div>
            <div className="text-xs text-ctp-subtext0 mt-0.5">
              Check for updates every 4 hours and download in the background
            </div>
          </div>
          <Toggle
            checked={settings.autoUpdate}
            onChange={(v) => saveSettings({ ...settings, autoUpdate: v })}
          />
        </div>

        {/* Status */}
        <div className="py-3 border-b border-surface-0">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-ctp-text font-medium">Status</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">
                {stateLabel[status.state] || status.state}
                {status.state === 'downloading' && ` (${status.downloadProgress}%)`}
                {status.state === 'ready' && status.availableVersion && ` — v${status.availableVersion}`}
                {status.state === 'error' && status.error && ` — ${status.error}`}
              </div>
            </div>
            <button
              onClick={checkForUpdates}
              disabled={status.state === 'checking' || status.state === 'downloading'}
              className="px-3 py-1.5 text-xs rounded bg-surface-1 hover:bg-surface-2
                transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed
                text-ctp-subtext1 hover:text-ctp-text"
            >
              {status.state === 'checking' ? 'Checking...' : 'Check now'}
            </button>
          </div>
        </div>

        {/* Last check */}
        {settings.lastCheck && (
          <div className="py-3 border-b border-surface-0">
            <div className="text-sm text-ctp-text font-medium">Last checked</div>
            <div className="text-xs text-ctp-subtext0 mt-0.5">
              {new Date(settings.lastCheck).toLocaleString()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
