import { useEffect, useState } from 'react';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useAnnexStore, subscribeAnnexDevices } from '../../stores/annexStore';
import { Toggle } from '../../components/Toggle';
import { PairedSatelliteList } from './PairedSatelliteList';
import { PairingWizard, type RepairTarget } from './PairingWizard';
import { SettingsPage, SettingsSection, SettingsField } from './SettingsLayout';
import { Button } from '../../components/Button';

export function AnnexControlSettingsView() {
  const devices = useAnnexStore((s) => s.devices);
  const loadDevices = useAnnexStore((s) => s.loadDevices);
  const loadSatellites = useAnnexClientStore((s) => s.loadSatellites);
  const scan = useAnnexClientStore((s) => s.scan);
  const forgetAllSatellites = useAnnexClientStore((s) => s.forgetAllSatellites);
  const annexSettings = useAnnexStore((s) => s.settings);
  const saveAnnexSettings = useAnnexStore((s) => s.saveSettings);
  const loadAnnexSettings = useAnnexStore((s) => s.loadSettings);
  const [showPairing, setShowPairing] = useState(false);
  const [repairTarget, setRepairTarget] = useState<RepairTarget | undefined>(undefined);
  const [confirmPurge, setConfirmPurge] = useState(false);

  useEffect(() => {
    loadSatellites();
    loadAnnexSettings();
  }, [loadSatellites, loadAnnexSettings]);

  // The devices this machine controls, from the one device list (#3057).
  useEffect(() => {
    loadDevices();
    return subscribeAnnexDevices();
  }, [loadDevices]);
  // Older pairings with no role are listed on both pages, so either can pair them again.
  // Network members are here too: this machine controls them (#3061).
  const satellites = devices.filter((d) => d.role === 'satellite' || d.role === 'member' || d.role === null);

  return (
    <SettingsPage title="Annex control" description="Control other Clubhouse instances on your local network.">
      <div className="mt-[22px]">
        <SettingsField label="Connect to satellites" help="Discover and control other Clubhouse instances on the network.">
          <div data-testid="annex-client-toggle" className="flex">
            <Toggle
              aria-label="Connect to satellites"
              checked={annexSettings.enableClient}
              onChange={(v) => saveAnnexSettings({ ...annexSettings, enableClient: v })}
            />
          </div>
        </SettingsField>
      </div>

      <SettingsSection
        title="Paired satellites"
        meta={satellites.length > 0 ? String(satellites.length) : undefined}
        actions={
          <>
            <Button onClick={scan} kind="quiet">
              Scan
            </Button>
            <Button
              onClick={() => { setRepairTarget(undefined); setShowPairing((v) => !v); }}
              kind={showPairing ? 'ghost' : 'primary'}
            >
              {showPairing ? 'Cancel' : 'Add satellite'}
            </Button>
          </>
        }
      >
        {satellites.length === 0 && !showPairing ? (
          <p className="text-xs text-ctp-overlay1 py-3 border-t border-surface-0">
            No paired satellites. Click Add satellite to pair with another Clubhouse instance.
          </p>
        ) : (
          <PairedSatelliteList
            devices={satellites}
            onPairAgain={(sat) => {
              setRepairTarget({ fingerprint: sat.fingerprint, alias: sat.alias });
              setShowPairing(true);
            }}
          />
        )}

        {showPairing && (
          <PairingWizard
            // A new target starts the wizard over.
            key={repairTarget?.fingerprint ?? 'add'}
            repairTarget={repairTarget}
            onClose={() => { setShowPairing(false); setRepairTarget(undefined); }}
          />
        )}
      </SettingsSection>

      <SettingsSection title="Reset">
        <SettingsField
          label="Reset Annex control"
          help="Disconnect and forget all paired satellites. You will need to pair each device again."
        >
          {confirmPurge ? (
            <>
              <Button onClick={() => setConfirmPurge(false)} kind="ghost">
                Cancel
              </Button>
              <Button
                onClick={() => {
                  forgetAllSatellites();
                  setConfirmPurge(false);
                }}
                kind="danger"
              >
                Confirm reset
              </Button>
            </>
          ) : (
            <Button onClick={() => setConfirmPurge(true)} kind="danger">
              Forget all satellites
            </Button>
          )}
        </SettingsField>
      </SettingsSection>
    </SettingsPage>
  );
}
