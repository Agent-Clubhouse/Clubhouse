import { useEffect, useState } from 'react';
import { Toggle } from '../../components/Toggle';

/** Feature definitions for the experimental settings page. */
const EXPERIMENTAL_FEATURES: Array<{
  id: string;
  label: string;
  description: string;
}> = [
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
    id: 'canvas',
    label: 'Canvas',
    description: 'Free-form spatial workspace for arranging agent, file, and browser views on a pannable/zoomable surface. Requires app restart.',
  },
  {
    id: 'annex',
    label: 'Annex (Remote Control)',
    description: 'Desktop-to-desktop remote control over LAN. Enables the Annex Server and Annex Control settings pages. Requires app restart.',
  },
  {
    id: 'sessions',
    label: 'Sessions',
    description: 'Browse and replay historical agent conversation sessions with timeline playback. Requires app restart.',
  },
  {
    id: 'review',
    label: 'Review Carousel',
    description: 'Full-screen swipe carousel for browsing and reviewing agents one at a time. Requires app restart.',
  },
];

export function ExperimentalSettingsView() {
  const [settings, setSettings] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    window.clubhouse.app.getExperimentalSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
  }, []);

  const handleToggle = async (id: string, enabled: boolean) => {
    const updated = { ...settings, [id]: enabled };
    setSettings(updated);
    await window.clubhouse.app.saveExperimentalSettings(updated);
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
              className="px-4 py-1.5 text-sm rounded bg-ctp-surface0 text-ctp-text hover:bg-ctp-surface1 transition-colors cursor-pointer"
            >
              Restart
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
