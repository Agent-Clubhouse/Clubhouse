import { useEffect } from 'react';
import { useAnnexStore } from '../../stores/annexStore';
import { Toggle } from '../../components/Toggle';

export function AnnexSettingsView() {
  const settings = useAnnexStore((s) => s.settings);
  const status = useAnnexStore((s) => s.status);
  const saveSettings = useAnnexStore((s) => s.saveSettings);
  const loadSettings = useAnnexStore((s) => s.loadSettings);
  const regeneratePin = useAnnexStore((s) => s.regeneratePin);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Annex</h2>
        <p className="text-sm text-ctp-subtext0 mb-6">
          Monitor your agents from an iOS companion app over the local network.
        </p>

        {/* Enable toggle */}
        <div className="flex items-center justify-between py-3 border-b border-surface-0">
          <div>
            <div className="text-sm text-ctp-text font-medium">Enable Annex server</div>
            <div className="text-xs text-ctp-subtext0 mt-0.5">
              Start a local network server for the iOS companion app
            </div>
          </div>
          <Toggle
            checked={settings.enabled}
            onChange={(v) => saveSettings({ ...settings, enabled: v })}
          />
        </div>

        {settings.enabled && (
          <>
            {/* Status */}
            <div className="py-3 border-b border-surface-0">
              <div className="text-sm text-ctp-text font-medium">Status</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">
                {status.advertising
                  ? `Advertising on port ${status.port}`
                  : 'Starting...'}
              </div>
            </div>

            {/* Connected clients */}
            <div className="py-3 border-b border-surface-0">
              <div className="text-sm text-ctp-text font-medium">Connected devices</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">
                {status.connectedCount === 0
                  ? 'No devices connected'
                  : `${status.connectedCount} device${status.connectedCount !== 1 ? 's' : ''} connected`}
              </div>
            </div>

            {/* PIN */}
            <div className="flex items-center justify-between py-3 border-b border-surface-0">
              <div>
                <div className="text-sm text-ctp-text font-medium">Pairing PIN</div>
                <div className="text-lg font-mono text-ctp-text mt-0.5 tracking-widest">
                  {status.pin || '------'}
                </div>
              </div>
              <button
                onClick={regeneratePin}
                className="px-3 py-1.5 text-xs rounded bg-surface-1 hover:bg-surface-2
                  transition-colors cursor-pointer text-ctp-subtext1 hover:text-ctp-text"
              >
                Regenerate
              </button>
            </div>

            {/* Device name */}
            <div className="py-3 border-b border-surface-0">
              <div className="text-sm text-ctp-text font-medium mb-2">Device name</div>
              <input
                type="text"
                value={settings.deviceName}
                onChange={(e) => saveSettings({ ...settings, deviceName: e.target.value })}
                className="w-full px-3 py-1.5 text-sm rounded bg-surface-0 border border-surface-1
                  text-ctp-text placeholder-ctp-subtext0 focus:outline-none focus:border-indigo-500"
                placeholder="Clubhouse on my Mac"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
