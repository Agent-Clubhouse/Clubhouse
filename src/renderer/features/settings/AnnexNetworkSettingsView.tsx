import { useEffect, useState } from 'react';
import { useAnnexStore, subscribeAnnexDevices } from '../../stores/annexStore';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { Toggle } from '../../components/Toggle';
import { Button } from '../../components/Button';
import { certificateCode } from '../../../shared/annex-certificate-code';
import { AnnexDeviceList } from './AnnexDeviceList';
import { AnnexIdentitySection } from './AnnexIdentitySection';
import { AnnexPairingQr } from './AnnexPairingQr';
import { PairingWizard, type RepairTarget } from './PairingWizard';
import { SettingsPage, SettingsSection, SettingsField, settingsInput } from './SettingsLayout';

/**
 * Settings > Annex Network (#3067): one page for the whole network, in place
 * of Annex and Annex control. Every device both controls and is controlled.
 */
export function AnnexNetworkSettingsView() {
  const settings = useAnnexStore((s) => s.settings);
  const status = useAnnexStore((s) => s.status);
  const devices = useAnnexStore((s) => s.devices);
  const saveSettings = useAnnexStore((s) => s.saveSettings);
  const loadSettings = useAnnexStore((s) => s.loadSettings);
  const loadStatus = useAnnexStore((s) => s.loadStatus);
  const loadDevices = useAnnexStore((s) => s.loadDevices);
  const regeneratePin = useAnnexStore((s) => s.regeneratePin);
  const allowPairingAgain = useAnnexStore((s) => s.allowPairingAgain);
  const purgeServerConfig = useAnnexStore((s) => s.purgeServerConfig);
  const loadSatellites = useAnnexClientStore((s) => s.loadSatellites);
  const scan = useAnnexClientStore((s) => s.scan);
  const [adding, setAdding] = useState(false);
  const [repairTarget, setRepairTarget] = useState<RepairTarget | undefined>(undefined);
  const [linkCopied, setLinkCopied] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const on = settings.enableServer && settings.enableClient;
  const code = certificateCode(status.tlsCertificateFingerprint);

  useEffect(() => {
    loadSettings();
    loadSatellites();
  }, [loadSettings, loadSatellites]);

  useEffect(() => {
    loadDevices();
    return subscribeAnnexDevices();
  }, [loadDevices]);

  // Status while the server starts (catches a missed broadcast).
  useEffect(() => {
    if (!settings.enableServer || status.advertising) return;
    const interval = setInterval(loadStatus, 2000);
    return () => clearInterval(interval);
  }, [settings.enableServer, status.advertising, loadStatus]);

  useEffect(() => {
    if (!linkCopied) return;
    const timer = setTimeout(() => setLinkCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [linkCopied]);

  async function copyPairingLink() {
    if (!status.pairingUrl) return;
    try {
      await navigator.clipboard.writeText(status.pairingUrl);
      setLinkCopied(true);
    } catch {
      // telemetry-exempt: the link stays on screen to select and copy by hand.
    }
  }

  /** On: this machine answers and connects, and new pairings join the network. Off: nothing connects. */
  const setOn = (value: boolean) => saveSettings({
    ...settings,
    enableServer: value,
    enableClient: value,
    ...(value && { networkEnabled: true }),
  });

  return (
    <SettingsPage
      title="Annex Network"
      description="Your computers and phone, joined into one network. Every device in it can control every other."
    >
      <div className="mt-[22px]">
        <SettingsField
          label="Annex Network on this computer"
          help={on
            ? 'Pair a new device with any device in the network and it joins all of them.'
            : 'Off: this computer neither answers nor connects to other devices.'}
        >
          <div data-testid="annex-network-toggle" className="flex">
            <Toggle aria-label="Annex Network on this computer" checked={on} onChange={setOn} />
          </div>
        </SettingsField>
      </div>

      <SettingsSection
        title="Devices"
        meta={devices.length > 0 ? String(devices.length) : undefined}
        actions={on ? <Button onClick={scan} kind="quiet">Scan</Button> : undefined}
      >
        {devices.length === 0 ? (
          <p className="text-xs text-ctp-overlay1 py-3 border-t border-surface-0">No devices yet. Add one below.</p>
        ) : (
          <AnnexDeviceList
            devices={devices}
            onPairAgain={(device) => {
              setRepairTarget({ fingerprint: device.fingerprint, alias: device.alias });
              setAdding(true);
            }}
          />
        )}
      </SettingsSection>

      {on && (
        <SettingsSection
          title="Add a device"
          actions={(
            <Button onClick={() => { setRepairTarget(undefined); setAdding((v) => !v); }} kind={adding ? 'ghost' : 'primary'}>
              {adding ? 'Cancel' : 'Pair with another computer'}
            </Button>
          )}
        >
          {status.pairingPaused && (
            <SettingsField
              label="Pairing paused"
              testId="annex-pairing-paused"
              help="Too many wrong codes were tried, so no device can pair until you allow it again."
            >
              <Button onClick={allowPairingAgain} kind="primary">Allow pairing again</Button>
            </SettingsField>
          )}
          {adding && (
            <PairingWizard
              key={repairTarget?.fingerprint ?? 'add'}
              repairTarget={repairTarget}
              onClose={() => { setAdding(false); setRepairTarget(undefined); }}
            />
          )}
          <SettingsField
            label="One-time code"
            testId="annex-pairing-code"
            help={(
              <>
                <span className="block text-[13px] font-mono text-ctp-text tracking-widest">{status.pin || '------'}</span>
                Enter it on the new device. It works once and changes every 10 minutes.
              </>
            )}
          >
            <Button onClick={regeneratePin} kind="ghost">New code</Button>
          </SettingsField>
          {status.pairingUrl && (
            <SettingsField
              label="Pairing link"
              testId="annex-pairing-link"
              help={(
                <>
                  <span className="block font-mono text-ctp-text truncate select-all">{status.pairingUrl}</span>
                  Paste it on another computer, or scan the code below with the phone.
                </>
              )}
            >
              <Button onClick={copyPairingLink} kind="ghost">{linkCopied ? 'Copied' : 'Copy'}</Button>
            </SettingsField>
          )}
          {status.pairingUrl && <AnnexPairingQr url={status.pairingUrl} hosts={status.pairingHosts ?? []} port={status.port} />}
          <p className="text-xs text-ctp-overlay1 py-2">Finishing a pairing always needs a person at the new device.</p>
        </SettingsSection>
      )}

      {on && (
        <SettingsSection title="This computer">
          <SettingsField label="Device name" htmlFor="annex-device-name">
            <input
              id="annex-device-name"
              type="text"
              value={settings.deviceName}
              onChange={(e) => saveSettings({ ...settings, deviceName: e.target.value })}
              className={`${settingsInput} w-[220px]`}
              placeholder="Clubhouse on my Mac"
            />
          </SettingsField>
          <SettingsField
            label="Reachable at"
            testId="annex-reachable-hosts"
            help={status.pairingHosts && status.pairingHosts.length > 0
              ? <span className="block font-mono text-ctp-text">{status.pairingHosts.join(', ')}</span>
              : 'Found once Annex Network is listening.'}
          />
          <SettingsField
            label="Also reachable at"
            htmlFor="annex-reachable-as"
            help="A name other devices can reach this one by, such as its tailnet name. It's added to the pairing link."
          >
            <input
              id="annex-reachable-as"
              type="text"
              value={settings.reachableAs ?? ''}
              onChange={(e) => saveSettings({ ...settings, reachableAs: e.target.value })}
              className={`${settingsInput} w-[220px]`}
              placeholder="studio.tailnet.ts.net"
            />
          </SettingsField>
          {code && (
            <SettingsField
              label="Certificate code"
              testId="annex-certificate-code"
              help={(
                <>
                  <span className="block text-[13px] font-mono text-ctp-text tracking-widest select-all">{code}</span>
                  A device pairing with this one should show this same code.
                </>
              )}
            />
          )}
          <AnnexIdentitySection settings={settings} status={status} onSave={saveSettings} />
        </SettingsSection>
      )}

      <SettingsSection title="Reset">
        <SettingsField
          label="Reset Annex Network"
          help="Stop Annex and delete this computer's identity, certificate and every pairing. Each device will need to pair again."
        >
          {confirmReset ? (
            <>
              <Button onClick={() => setConfirmReset(false)} kind="ghost">Cancel</Button>
              <Button onClick={() => { purgeServerConfig(); setConfirmReset(false); }} kind="danger">Confirm reset</Button>
            </>
          ) : (
            <Button onClick={() => setConfirmReset(true)} kind="danger">Reset</Button>
          )}
        </SettingsField>
      </SettingsSection>
    </SettingsPage>
  );
}
