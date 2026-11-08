import { useEffect, useState } from 'react';
import { useAnnexStore } from '../../stores/annexStore';
import { Toggle } from '../../components/Toggle';
import { AnnexIdentitySection } from './AnnexIdentitySection';
import { AnnexPairingQr } from './AnnexPairingQr';
import { AnnexPairedDevices } from './AnnexPairedDevices';
import { certificateCode } from '../../../shared/annex-certificate-code';
import { SettingsPage, SettingsSection, SettingsField, settingsInput } from './SettingsLayout';
import { Button } from '../../components/Button';

export function AnnexSettingsView() {
  const settings = useAnnexStore((s) => s.settings);
  const status = useAnnexStore((s) => s.status);
  const saveSettings = useAnnexStore((s) => s.saveSettings);
  const loadSettings = useAnnexStore((s) => s.loadSettings);
  const regeneratePin = useAnnexStore((s) => s.regeneratePin);
  const purgeServerConfig = useAnnexStore((s) => s.purgeServerConfig);
  const loadStatus = useAnnexStore((s) => s.loadStatus);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const code = certificateCode(status.tlsCertificateFingerprint);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

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

  // Poll status while server is enabled but not yet advertising (catches missed broadcasts)
  useEffect(() => {
    if (!settings.enableServer || status.advertising) return;
    const interval = setInterval(loadStatus, 2000);
    return () => clearInterval(interval);
  }, [settings.enableServer, status.advertising, loadStatus]);

  return (
    <SettingsPage
      title="Annex"
      description="Control other Clubhouse instances on your network, or allow this machine to be controlled remotely."
    >
      <SettingsSection title="Server">
        <SettingsField label="Allow remote control" help="Start a local network server so other instances can control this machine.">
          <div data-testid="annex-server-toggle" className="flex">
            <Toggle
              aria-label="Allow remote control"
              checked={settings.enableServer}
              onChange={(v) => saveSettings({ ...settings, enableServer: v })}
            />
          </div>
        </SettingsField>

        {settings.enableServer && (
          <>
            <SettingsField
              label="Server status"
              help={status.advertising ? `Advertising on port ${status.port}` : 'Starting…'}
            />
            <SettingsField
              label="Connected devices"
              help={status.connectedCount === 0
                ? 'No devices connected'
                : `${status.connectedCount} device${status.connectedCount !== 1 ? 's' : ''} connected`}
            />
            <SettingsField
              label="Pairing PIN"
              help={(
                <>
                  <span className="block text-[13px] font-mono text-ctp-text tracking-widest">{status.pin || '------'}</span>
                  The PIN works once and changes every 10 minutes.
                </>
              )}
            >
              <Button onClick={regeneratePin} kind="ghost">
                Regenerate
              </Button>
            </SettingsField>
            {code && (
              <SettingsField
                label="Certificate code"
                testId="annex-certificate-code"
                help={(
                  <>
                    <span className="block text-[13px] font-mono text-ctp-text tracking-widest select-all">{code}</span>
                    A computer pairing from its discovered list should show this same code.
                  </>
                )}
              />
            )}
            {status.pairingUrl && (
              <SettingsField
                label="Pairing link"
                testId="annex-pairing-link"
                help={(
                  <>
                    <span className="block font-mono text-ctp-text truncate select-all">{status.pairingUrl}</span>
                    Paste it into Annex control on the other computer.
                  </>
                )}
              >
                <Button onClick={copyPairingLink} kind="ghost">
                  {linkCopied ? 'Copied' : 'Copy'}
                </Button>
              </SettingsField>
            )}
            {status.pairingUrl && (
              <AnnexPairingQr url={status.pairingUrl} hosts={status.pairingHosts ?? []} port={status.port} />
            )}
          </>
        )}
      </SettingsSection>

      <AnnexPairedDevices showWhenEmpty={settings.enableServer} />

      {/* Device name and identity (shown when either toggle is on) */}
      {(settings.enableServer || settings.enableClient) && (
        <SettingsSection title="Identity">
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
          <AnnexIdentitySection
            settings={settings}
            status={status}
            onSave={saveSettings}
          />
        </SettingsSection>
      )}

      <SettingsSection title="Reset">
        <SettingsField
          label="Reset Annex"
          help="Stop the server and delete all Annex identity, certificates and paired devices. You will need to pair every device again."
        >
          {confirmPurge ? (
            <>
              <Button onClick={() => setConfirmPurge(false)} kind="ghost">
                Cancel
              </Button>
              <Button
                onClick={() => {
                  purgeServerConfig();
                  setConfirmPurge(false);
                }}
                kind="danger"
              >
                Confirm reset
              </Button>
            </>
          ) : (
            <Button onClick={() => setConfirmPurge(true)} kind="danger">
              Purge all Annex config
            </Button>
          )}
        </SettingsField>
      </SettingsSection>
    </SettingsPage>
  );
}
