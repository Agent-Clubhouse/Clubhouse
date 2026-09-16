import { useEffect, useState } from 'react';
import { useGoobersSettingsStore } from '../../stores/goobersSettingsStore';
import { Toggle } from '../../components/Toggle';

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
    <div className="h-full overflow-y-auto bg-ctp-base p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Goobers</h2>
        <p className="text-sm text-ctp-subtext0 mb-6">
          Point Clubhouse at a Goobers instance to monitor and control it from the app.
        </p>

        {/* Instance root */}
        <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider mb-3">Instance Root</h3>
        <div className="flex gap-2 max-w-lg mb-2">
          <input
            type="text"
            value={instanceRoot}
            placeholder="/path/to/goobers/instance"
            onChange={(e) => saveSettings({ instanceRoot: e.target.value })}
            className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-surface-1 bg-ctp-mantle text-ctp-text placeholder:text-ctp-overlay0 focus-ring"
            data-testid="goobers-instance-root"
          />
          <button
            type="button"
            onClick={handleBrowse}
            className="px-3 py-1.5 text-sm bg-surface-0 text-ctp-text rounded border border-surface-2 hover:bg-surface-1 whitespace-nowrap cursor-pointer"
            data-testid="goobers-browse-root"
          >
            Browse...
          </button>
        </div>

        {instanceRoot && (
          <p className="text-xs mb-6" data-testid="goobers-root-validation">
            {validating && <span className="text-ctp-subtext0">Checking...</span>}
            {!validating && validation?.ok && (
              <span className="text-ctp-green">
                Valid Goobers instance root — <span className="font-mono">{validation.instanceId}</span>
              </span>
            )}
            {!validating && validation && !validation.ok && (
              <span className="text-ctp-red">{validation.error?.message ?? 'not a Goobers instance root'}</span>
            )}
          </p>
        )}
        {!instanceRoot && <div className="mb-6" />}

        {/* Binary path */}
        <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider mb-3">Goobers Binary</h3>
        <p className="text-xs text-ctp-subtext0 mb-2">
          A bare command name (resolved on your shell PATH) or an absolute path.
        </p>
        <input
          type="text"
          value={binaryPath}
          placeholder="goobers"
          onChange={(e) => saveSettings({ binaryPath: e.target.value })}
          className="w-full max-w-lg px-3 py-1.5 text-sm rounded-lg border border-surface-1 bg-ctp-mantle text-ctp-text placeholder:text-ctp-overlay0 focus-ring mb-6"
          data-testid="goobers-binary-path"
        />

        {/* Auto connect */}
        <div className="flex items-center justify-between py-2 max-w-lg mb-2">
          <div>
            <div className="text-sm text-ctp-text font-medium">Connect Automatically</div>
            <div className="text-xs text-ctp-subtext0 mt-0.5">
              Connect to the instance when Clubhouse starts, if a root is configured.
            </div>
          </div>
          <div data-testid="goobers-auto-connect-toggle">
            <Toggle
              checked={autoConnect}
              onChange={(next) => saveSettings({ autoConnect: next })}
            />
          </div>
        </div>

        {/* Manage daemon */}
        <div className="flex items-center justify-between py-2 max-w-lg">
          <div>
            <div className="text-sm text-ctp-text font-medium">Manage Daemon</div>
            <div className="text-xs text-ctp-subtext0 mt-0.5">
              Allow starting and stopping the Goobers daemon from Clubhouse.
            </div>
          </div>
          <div data-testid="goobers-manage-daemon-toggle">
            <Toggle
              checked={manageDaemon}
              onChange={handleManageDaemonToggle}
            />
          </div>
        </div>

        {showDaemonHazards && (
          <div
            className="mt-3 max-w-lg rounded-lg border border-ctp-peach/30 bg-ctp-peach/5 px-4 py-3"
            data-testid="goobers-daemon-hazards"
          >
            <p className="text-sm text-ctp-peach font-medium mb-1">Before you enable this</p>
            <ul className="text-xs text-ctp-subtext1 list-disc pl-4 space-y-1 mb-3">
              <li>The daemon is spawned with your login-shell environment.</li>
              <li>Stopping it triggers an unbounded drain that may run 30-40 minutes.</li>
              <li>The daemon outlives Clubhouse — quitting the app does not stop it.</li>
            </ul>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={confirmManageDaemon}
                className="px-3 py-1.5 text-sm bg-ctp-accent text-ctp-base rounded hover:opacity-90 cursor-pointer"
                data-testid="goobers-daemon-hazards-confirm"
              >
                Enable anyway
              </button>
              <button
                type="button"
                onClick={() => setShowDaemonHazards(false)}
                className="px-3 py-1.5 text-sm bg-surface-0 text-ctp-text rounded border border-surface-2 hover:bg-surface-1 cursor-pointer"
                data-testid="goobers-daemon-hazards-cancel"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
