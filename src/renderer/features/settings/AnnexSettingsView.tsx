import { useEffect, useState } from 'react';
import { useAnnexStore } from '../../stores/annexStore';
import { Toggle } from '../../components/Toggle';
import { AnnexIdentitySection } from './AnnexIdentitySection';

export function AnnexSettingsView() {
  const settings = useAnnexStore((s) => s.settings);
  const status = useAnnexStore((s) => s.status);
  const saveSettings = useAnnexStore((s) => s.saveSettings);
  const loadSettings = useAnnexStore((s) => s.loadSettings);
  const regeneratePin = useAnnexStore((s) => s.regeneratePin);
  const purgeServerConfig = useAnnexStore((s) => s.purgeServerConfig);
  const loadStatus = useAnnexStore((s) => s.loadStatus);
  const [confirmPurge, setConfirmPurge] = useState(false);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Poll status while server is enabled but not yet advertising (catches missed broadcasts)
  useEffect(() => {
    if (!settings.enableServer || status.advertising) return;
    const interval = setInterval(loadStatus, 2000);
    return () => clearInterval(interval);
  }, [settings.enableServer, status.advertising, loadStatus]);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Annex</h2>
        <p className="text-sm text-ctp-subtext0 mb-6">
          Control other Clubhouse instances on your network, or allow this machine to be controlled remotely.
        </p>

        {/* Enable Server toggle */}
        <div className="flex items-center justify-between py-3 border-b border-surface-0">
          <div>
            <div className="text-sm text-ctp-text font-medium">Allow remote control</div>
            <div className="text-xs text-ctp-subtext0 mt-0.5">
              Start a local network server so other instances can control this machine
            </div>
          </div>
          <div data-testid="annex-server-toggle">
            <Toggle
              checked={settings.enableServer}
              onChange={(v) => saveSettings({ ...settings, enableServer: v })}
            />
          </div>
        </div>

        {/* Enable Client toggle */}
        <div className="flex items-center justify-between py-3 border-b border-surface-0">
          <div>
            <div className="text-sm text-ctp-text font-medium">Connect to satellites</div>
            <div className="text-xs text-ctp-subtext0 mt-0.5">
              Discover and control other Clubhouse instances on the network
            </div>
          </div>
          <div data-testid="annex-client-toggle">
            <Toggle
              checked={settings.enableClient}
              onChange={(v) => saveSettings({ ...settings, enableClient: v })}
            />
          </div>
        </div>

        {settings.enableServer && (
          <>
            {/* Status */}
            <div className="py-3 border-b border-surface-0">
              <div className="text-sm text-ctp-text font-medium">Server Status</div>
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
          </>
        )}

        {/* Device name (shown when either toggle is on) */}
        {(settings.enableServer || settings.enableClient) && (
          <>
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

            {/* Identity section */}
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-ctp-text mb-2">Identity</h3>
              <AnnexIdentitySection
                settings={settings}
                status={status}
                onSave={saveSettings}
              />
            </div>
          </>
        )}

        {/* Purge server config */}
        <div className="mt-6 py-3 border-t border-surface-0">
          <div className="text-sm text-ctp-text font-medium mb-1">Reset Annex</div>
          <div className="text-xs text-ctp-subtext0 mb-3">
            Stop the server and delete all Annex identity, certificates, and paired devices.
            You will need to re-pair all devices after this.
          </div>
          {confirmPurge ? (
            <div className="flex gap-2">
              <button
                onClick={() => {
                  purgeServerConfig();
                  setConfirmPurge(false);
                }}
                className="px-3 py-1.5 text-xs rounded bg-red-600 hover:bg-red-700
                  transition-colors cursor-pointer text-white font-medium"
              >
                Confirm Reset
              </button>
              <button
                onClick={() => setConfirmPurge(false)}
                className="px-3 py-1.5 text-xs rounded bg-surface-1 hover:bg-surface-2
                  transition-colors cursor-pointer text-ctp-subtext1 hover:text-ctp-text"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmPurge(true)}
              className="px-3 py-1.5 text-xs rounded bg-surface-1 hover:bg-surface-2
                transition-colors cursor-pointer text-ctp-error hover:text-red-400"
            >
              Purge All Annex Config
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
