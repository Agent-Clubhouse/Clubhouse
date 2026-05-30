import { useEffect, useState } from 'react';
import { Toggle } from '../../components/Toggle';
import { useHookServerSettingsStore } from '../../stores/hookServerSettingsStore';

/** Feature definitions for the experimental settings page. */
const EXPERIMENTAL_FEATURES: Array<{
  id: string;
  label: string;
  description: string;
}> = [
  {
    id: 'assistant',
    label: 'Assistant',
    description: 'Built-in interactive help agent that can configure the app and answer questions. Requires app restart.',
  },
  {
    id: 'agentQueue',
    label: 'Agent Queue',
    description: 'Queue system for batch-spawning agents with configurable orchestrators. Requires app restart.',
  },
  {
    id: 'structuredMode',
    label: 'Structured Mode',
    description: 'Enable the structured agent execution mode for providers that support it (ACP protocol).',
  },
  {
    id: 'themeGradients',
    label: 'Theme Gradients & Fonts',
    description: 'Allow themes to define custom font families and background gradients. Requires app restart.',
  },
  {
    id: 'sessions',
    label: 'Sessions',
    description: 'Browse and replay historical agent conversation sessions with timeline playback. Requires app restart.',
  },
];

export function ExperimentalSettingsView() {
  const [settings, setSettings] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);

  const hookServerEnabled = useHookServerSettingsStore((s) => s.enabled);
  const hookServerLoaded = useHookServerSettingsStore((s) => s.loaded);
  const loadHookServerSettings = useHookServerSettingsStore((s) => s.loadSettings);
  const saveHookServerSettings = useHookServerSettingsStore((s) => s.saveSettings);

  useEffect(() => {
    window.clubhouse.app.getExperimentalSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
    if (!hookServerLoaded) void loadHookServerSettings();
  }, [hookServerLoaded, loadHookServerSettings]);

  const handleToggle = async (id: string, enabled: boolean) => {
    const updated = { ...settings, [id]: enabled };
    setSettings(updated);
    await window.clubhouse.app.saveExperimentalSettings(updated);
  };

  const handleHookServerToggle = (enabled: boolean) => {
    void saveHookServerSettings({ enabled });
  };

  const handleRestart = () => {
    window.clubhouse.app.restart();
  };

  if (!loaded) return null;

  return (
    <div className="h-full overflow-y-auto bg-ctp-base p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Experimental</h2>
        <p className="text-sm text-ctp-subtext0 mb-4">
          These features are unstable and may be buggy. Use at your own risk.
        </p>

        {/* Disclaimer banner */}
        <div className="rounded-lg border border-ctp-peach/30 bg-ctp-peach/5 px-4 py-3 mb-6">
          <p className="text-sm text-ctp-peach font-medium mb-1">Beta Features</p>
          <p className="text-xs text-ctp-subtext1">
            Experimental features may change or be removed in future releases.
            Toggling a feature on or off may require an app restart to take full effect.
          </p>
        </div>

        {/* Feature toggles */}
        <div className="space-y-3 mb-6">
          <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Features</h3>
          {EXPERIMENTAL_FEATURES.map(({ id, label, description }) => (
            <div key={id} className="flex items-center justify-between py-2">
              <div>
                <div className="text-sm text-ctp-text font-medium">{label}</div>
                <div className="text-xs text-ctp-subtext0 mt-0.5">{description}</div>
              </div>
              <Toggle
                checked={!!settings[id]}
                onChange={(enabled) => handleToggle(id, enabled)}
              />
            </div>
          ))}
        </div>

        {/* Diagnostics — escape hatches for stuck states.  Not experimental
            in the "may be removed" sense, but lives here because the user
            audience overlaps and the section is already labelled advanced. */}
        <div className="space-y-3 mb-6 border-t border-surface-0 pt-4">
          <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Diagnostics</h3>
          <div className="flex items-center justify-between py-2">
            <div className="pr-4">
              <div className="text-sm text-ctp-text font-medium">Hook server</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">
                Receives orchestrator hook callbacks (permission requests, tool
                events). Disabling is the durable escape hatch when an
                orchestrator's hook integration gets stuck — Clubhouse-injected
                hooks are stripped from running agents and the server returns
                fast 200s. Running agents need to be restarted before changes
                take full effect; permission request and observability features
                are unavailable while disabled.
              </div>
            </div>
            <Toggle
              checked={hookServerEnabled}
              onChange={handleHookServerToggle}
            />
          </div>
        </div>

        {/* Restart button */}
        <div className="border-t border-surface-0 pt-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-ctp-text">Restart App</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">
                Restart Clubhouse to apply experimental feature changes.
              </div>
            </div>
            <button
              onClick={handleRestart}
              className="px-4 py-1.5 text-sm rounded bg-surface-0 text-ctp-text hover:bg-surface-1 transition-colors cursor-pointer"
            >
              Restart
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
