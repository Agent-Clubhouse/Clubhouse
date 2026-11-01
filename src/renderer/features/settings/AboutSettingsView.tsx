import { useState, useEffect } from 'react';
import { SUPPORTED_PLUGIN_API_VERSIONS } from '../../../shared/marketplace-types';
import type { CliInstallStatus } from '../../../shared/types';
import { Button } from '../../components/Button';
import { SettingsPage, SettingsField } from './SettingsLayout';

interface ArchInfo {
  arch: string;
  platform: string;
  rosetta: boolean;
}

function formatArch(info: ArchInfo): string {
  if (info.rosetta) return `${info.arch} (Rosetta)`;
  return info.arch;
}

const valueClass = 'text-xs text-ctp-subtext1 font-mono';

function CliInstallField() {
  const [status, setStatus] = useState<CliInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.clubhouse.app.getCliInstallStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  if (!status?.supported) return null;

  const change = async (action: () => Promise<CliInstallStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const help = error
    ? <span className="text-ctp-error">{error}</span>
    : status.note ?? (status.installed
      ? <>Installed at <span className="font-mono">{status.commandPath}</span>.</>
      : 'Lets scripts list projects and agents and change how they look while Clubhouse is open. Needs Node.js on your PATH.');

  return (
    <SettingsField label="Command line tool" help={help} testId="cli-install">
      {status.installed
        ? <Button onClick={() => change(window.clubhouse.app.uninstallCli)} disabled={busy}>Remove</Button>
        : <Button onClick={() => change(window.clubhouse.app.installCli)} disabled={busy}>Install</Button>}
    </SettingsField>
  );
}

export function AboutSettingsView() {
  const [appVersion, setAppVersion] = useState('');
  const [archInfo, setArchInfo] = useState<ArchInfo | null>(null);

  useEffect(() => {
    window.clubhouse.app.getVersion().then(setAppVersion);
    window.clubhouse.app.getArchInfo().then(setArchInfo);
  }, []);

  return (
    <SettingsPage title="About" description="App version and compatibility.">
      <div className="mt-[22px]">
        <SettingsField label="Application">
          <span className={valueClass}>Clubhouse v{appVersion}</span>
        </SettingsField>

        {archInfo && (
          <SettingsField
            label="Architecture"
            help={archInfo.rosetta ? (
              <span className="text-ctp-warning">
                This app is running under Rosetta translation. An arm64 build is available for better performance on Apple Silicon.
              </span>
            ) : undefined}
          >
            <span className={valueClass}>{formatArch(archInfo)}</span>
          </SettingsField>
        )}

        <SettingsField label="Supported plugin API versions">
          <span className={valueClass}>{SUPPORTED_PLUGIN_API_VERSIONS.join(', ')}</span>
        </SettingsField>

        <CliInstallField />
      </div>
    </SettingsPage>
  );
}
