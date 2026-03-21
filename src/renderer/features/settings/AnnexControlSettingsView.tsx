import { useEffect, useState } from 'react';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useAnnexStore } from '../../stores/annexStore';
import { Toggle } from '../../components/Toggle';
import { PairedSatelliteList } from './PairedSatelliteList';
import { PairingWizard } from './PairingWizard';

export function AnnexControlSettingsView() {
  const satellites = useAnnexClientStore((s) => s.satellites);
  const loadSatellites = useAnnexClientStore((s) => s.loadSatellites);
  const scan = useAnnexClientStore((s) => s.scan);
  const forgetAllSatellites = useAnnexClientStore((s) => s.forgetAllSatellites);
  const annexSettings = useAnnexStore((s) => s.settings);
  const saveAnnexSettings = useAnnexStore((s) => s.saveSettings);
  const loadAnnexSettings = useAnnexStore((s) => s.loadSettings);
  const [showPairing, setShowPairing] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);

  useEffect(() => {
    loadSatellites();
    loadAnnexSettings();
  }, [loadSatellites, loadAnnexSettings]);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Annex Control</h2>
        <p className="text-sm text-ctp-subtext0 mb-6">
          Control other Clubhouse instances on your local network.
        </p>

        {/* Connect to satellites toggle */}
        <div className="flex items-center justify-between py-3 border-b border-surface-0">
          <div>
            <div className="text-sm text-ctp-text font-medium">Connect to satellites</div>
            <div className="text-xs text-ctp-subtext0 mt-0.5">
              Discover and control other Clubhouse instances on the network
            </div>
          </div>
          <div data-testid="annex-client-toggle">
            <Toggle
              checked={annexSettings.enableClient}
              onChange={(v) => saveAnnexSettings({ ...annexSettings, enableClient: v })}
            />
          </div>
        </div>

        {/* Paired satellites */}
        <div className="py-3 border-b border-surface-0">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm text-ctp-text font-medium">Paired Satellites</div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowPairing((v) => !v)}
                className="px-3 py-1.5 text-xs rounded bg-surface-1 hover:bg-surface-2
                  transition-colors cursor-pointer text-ctp-text font-medium border border-ctp-blue"
              >
                {showPairing ? 'Cancel' : 'Add Satellite'}
              </button>
              <button
                onClick={scan}
                className="px-3 py-1.5 text-xs rounded bg-surface-1 hover:bg-surface-2
                  transition-colors cursor-pointer text-ctp-subtext1 hover:text-ctp-text"
              >
                Scan
              </button>
            </div>
          </div>

          {satellites.length === 0 && !showPairing ? (
            <div className="text-xs text-ctp-subtext0 py-4 text-center">
              No paired satellites. Click "Add Satellite" to pair with another Clubhouse instance.
            </div>
          ) : (
            <PairedSatelliteList satellites={satellites} />
          )}

          {showPairing && (
            <PairingWizard onClose={() => setShowPairing(false)} />
          )}
        </div>

        {/* Purge control config */}
        <div className="mt-6 py-3 border-t border-surface-0">
          <div className="text-sm text-ctp-text font-medium mb-1">Reset Annex Control</div>
          <div className="text-xs text-ctp-subtext0 mb-3">
            Disconnect and forget all paired satellites. You will need to re-pair each device.
          </div>
          {confirmPurge ? (
            <div className="flex gap-2">
              <button
                onClick={() => {
                  forgetAllSatellites();
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
              Forget All Satellites
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
