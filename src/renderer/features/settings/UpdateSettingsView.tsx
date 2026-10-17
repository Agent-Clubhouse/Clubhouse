import { useUpdateStore } from '../../stores/updateStore';
import { Toggle } from '../../components/Toggle';
import { SettingsPage, SettingsField } from './SettingsLayout';
import { Button } from '../../components/Button';

export function UpdateSettingsView() {
  const settings = useUpdateStore((s) => s.settings);
  const saveSettings = useUpdateStore((s) => s.saveSettings);
  const status = useUpdateStore((s) => s.status);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);
  const openUpdateDownload = useUpdateStore((s) => s.openUpdateDownload);

  const stateLabel: Record<string, string> = {
    idle: 'Up to date',
    checking: 'Checking…',
    downloading: 'Downloading…',
    ready: 'Update ready',
    error: 'Update failed',
  };

  const showManualDownload = status.artifactUrl && (status.state === 'ready' || status.state === 'error');

  return (
    <SettingsPage title="Updates" description="Automatic update checks and downloads.">
      <div className="mt-[22px]">
        <SettingsField label="Automatic updates" help="Check for updates every 4 hours and download in the background.">
          <Toggle
            aria-label="Automatic updates"
            checked={settings.autoUpdate}
            onChange={(v) => saveSettings({ ...settings, autoUpdate: v })}
          />
        </SettingsField>

        <SettingsField label="Preview versions" help="Get upcoming features early, before they are officially released.">
          <Toggle
            aria-label="Preview versions"
            checked={settings.previewChannel}
            onChange={(v) => saveSettings({ ...settings, previewChannel: v })}
          />
        </SettingsField>

        <SettingsField
          label="Status"
          help={
            <span className={status.state === 'error' ? 'text-ctp-error' : undefined}>
              {stateLabel[status.state] || status.state}
              {status.state === 'downloading' && ` (${status.downloadProgress}%)`}
              {status.state === 'ready' && status.availableVersion && ` (v${status.availableVersion})`}
              {status.state === 'error' && status.error && `. ${status.error}`}
            </span>
          }
        >
          {showManualDownload && (
            <Button
              onClick={openUpdateDownload}
              kind="quiet"
              data-testid="settings-manual-download-btn"
            >
              Download manually
            </Button>
          )}
          <Button
            onClick={checkForUpdates}
            disabled={status.state === 'checking' || status.state === 'downloading'}
            kind="ghost"
          >
            {status.state === 'checking' ? 'Checking…' : 'Check now'}
          </Button>
        </SettingsField>

        {settings.lastCheck && (
          <SettingsField label="Last checked">
            <span className="text-xs text-ctp-subtext1">{new Date(settings.lastCheck).toLocaleString()}</span>
          </SettingsField>
        )}
      </div>
    </SettingsPage>
  );
}
