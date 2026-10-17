import { useEffect, useState } from 'react';
import { useGoobersSettingsStore } from '../../stores/goobersSettingsStore';
import { Toggle } from '../../components/Toggle';
import { SettingsPage, SettingsSection, SettingsField, SettingsBlock, settingsButton, settingsInput } from './SettingsLayout';

interface ValidateRootResult {
  ok: boolean;
  instanceId?: string;
  error?: { code: string; message: string };
}

function isValidateRootResult(v: unknown): v is ValidateRootResult {
  return typeof v === 'object' && v !== null && 'ok' in v;
}

export function GoobersSettingsView() {
  const instanceRoot = useGoobersSettingsStore((s) => s.instanceRoot);
  const binaryPath = useGoobersSettingsStore((s) => s.binaryPath);
  const autoConnect = useGoobersSettingsStore((s) => s.autoConnect);
  const manageDaemon = useGoobersSettingsStore((s) => s.manageDaemon);
  const loadSettings = useGoobersSettingsStore((s) => s.loadSettings);
  const saveSettings = useGoobersSettingsStore((s) => s.saveSettings);

  const [validation, setValidation] = useState<ValidateRootResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [showDaemonHazards, setShowDaemonHazards] = useState(false);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (!instanceRoot) {
      setValidation(null);
      return;
    }
    let cancelled = false;
    setValidating(true);
    window.clubhouse.goobers.validateRoot(instanceRoot).then((result) => {
      if (cancelled) return;
      setValidation(isValidateRootResult(result) ? result : null);
      setValidating(false);
    });
    return () => {
      cancelled = true;
    };
  }, [instanceRoot]);

  const handleBrowse = async () => {
    const picked = await window.clubhouse.project.pickDirectory();
    if (picked != null) {
      saveSettings({ instanceRoot: picked });
    }
  };

  const handleManageDaemonToggle = (next: boolean) => {
    if (next && !manageDaemon) {
      setShowDaemonHazards(true);
      return;
    }
    saveSettings({ manageDaemon: next });
  };

  const confirmManageDaemon = () => {
    saveSettings({ manageDaemon: true });
    setShowDaemonHazards(false);
  };

  return (
    <SettingsPage title="Goobers" description="Point Clubhouse at a Goobers instance to monitor and control it from the app.">
      <SettingsSection title="Instance">
        <SettingsField
          label="Instance root"
          htmlFor="goobers-instance-root"
          help={instanceRoot ? (
            <span data-testid="goobers-root-validation">
              {validating && <span>Checking…</span>}
              {!validating && validation?.ok && (
                <span className="text-ctp-success">
                  Valid Goobers instance root · <span className="font-mono">{validation.instanceId}</span>
                </span>
              )}
              {!validating && validation && !validation.ok && (
                <span className="text-ctp-error">{validation.error?.message ?? 'not a Goobers instance root'}</span>
              )}
            </span>
          ) : 'The folder that holds the Goobers instance.'}
        >
          <input
            id="goobers-instance-root"
            type="text"
            value={instanceRoot}
            placeholder="/path/to/goobers/instance"
            onChange={(e) => saveSettings({ instanceRoot: e.target.value })}
            className={`${settingsInput} w-[240px] font-mono`}
            data-testid="goobers-instance-root"
          />
          <button
            type="button"
            onClick={handleBrowse}
            className={settingsButton.ghost}
            data-testid="goobers-browse-root"
          >
            Browse…
          </button>
        </SettingsField>

        <SettingsField
          label="Goobers binary"
          htmlFor="goobers-binary-path"
          help="A bare command name (resolved on your shell PATH) or an absolute path."
        >
          <input
            id="goobers-binary-path"
            type="text"
            value={binaryPath}
            placeholder="goobers"
            onChange={(e) => saveSettings({ binaryPath: e.target.value })}
            className={`${settingsInput} w-[240px] font-mono`}
            data-testid="goobers-binary-path"
          />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="Connection">
        <SettingsField label="Connect automatically" help="Connect to the instance when Clubhouse starts, if a root is set.">
          <div data-testid="goobers-auto-connect-toggle" className="flex">
            <Toggle
              ariaLabel="Connect automatically"
              checked={autoConnect}
              onChange={(next) => saveSettings({ autoConnect: next })}
            />
          </div>
        </SettingsField>

        <SettingsField label="Manage daemon" help="Allow starting and stopping the Goobers daemon from Clubhouse.">
          <div data-testid="goobers-manage-daemon-toggle" className="flex">
            <Toggle
              ariaLabel="Manage daemon"
              checked={manageDaemon}
              onChange={handleManageDaemonToggle}
            />
          </div>
        </SettingsField>

        {showDaemonHazards && (
          <SettingsBlock>
            <div data-testid="goobers-daemon-hazards">
              <p className="text-[13px] text-ctp-warning mb-1">Before you turn this on</p>
              <ul className="text-xs text-ctp-subtext1 list-disc pl-4 space-y-1 mb-3">
                <li>The daemon is spawned with your login-shell environment.</li>
                <li>Stopping it triggers an unbounded drain that may run 30-40 minutes.</li>
                <li>The daemon outlives Clubhouse. Quitting the app does not stop it.</li>
              </ul>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowDaemonHazards(false)}
                  className={settingsButton.ghost}
                  data-testid="goobers-daemon-hazards-cancel"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmManageDaemon}
                  className={settingsButton.primary}
                  data-testid="goobers-daemon-hazards-confirm"
                >
                  Turn on anyway
                </button>
              </div>
            </div>
          </SettingsBlock>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
