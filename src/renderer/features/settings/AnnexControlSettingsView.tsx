import { useEffect, useState } from 'react';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { PairedSatelliteList } from './PairedSatelliteList';
import { PairingWizard } from './PairingWizard';

export function AnnexControlSettingsView() {
  const satellites = useAnnexClientStore((s) => s.satellites);
  const loadSatellites = useAnnexClientStore((s) => s.loadSatellites);
  const scan = useAnnexClientStore((s) => s.scan);
  const [showPairing, setShowPairing] = useState(false);

  useEffect(() => {
    loadSatellites();
  }, [loadSatellites]);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Annex Control</h2>
        <p className="text-sm text-ctp-subtext0 mb-6">
          Control other Clubhouse instances on your local network.
        </p>

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
      </div>
    </div>
  );
}
