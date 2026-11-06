import { useEffect, useRef, useState } from 'react';
import { Toggle } from '../../components/Toggle';
import { SettingsPage, SettingsSection, SettingsField, settingsError, SETTING_NOT_SAVED_TEXT } from './SettingsLayout';
import { Button } from '../../components/Button';
import { COPILOT_SDK_FLAG } from '../../../shared/chat';
import { isGraduatedFlagOn } from '../../../shared/graduated-flags';

/** Feature definitions for the experimental settings page. */
export const EXPERIMENTAL_FEATURES: Array<{
  id: string;
  label: string;
  description: string;
}> = [
  {
    id: 'goobers',
    label: 'Goobers',
    description: 'Monitor and control a local Goobers instance from an app-level panel. Not available on Windows. Requires app restart.',
  },
  {
    id: COPILOT_SDK_FLAG,
    label: 'Copilot SDK driver',
    description: 'On selects Copilot SDK for the next chat start; off selects ACP. Running sessions keep their current driver. If SDK cannot start, chat reports the fallback and its reason. Details > Session > Runs on shows the actual driver.',
  },
];

export function ExperimentalSettingsView() {
  const [settings, setSettings] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);

  useEffect(() => {
    window.clubhouse.app.getExperimentalSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
  }, []);

  const handleToggle = async (id: string, enabled: boolean) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    let previous = settings;
    const updated = { ...settings, [id]: enabled };
    setSettings(updated);
    setSaveFailed(false);
    try {
      previous = await window.clubhouse.app.getExperimentalSettings();
      const next = { ...previous, [id]: enabled };
      await window.clubhouse.app.saveExperimentalSettings(next);
      setSettings(next);
    } catch {
      // telemetry-exempt: shown to the user, and the switch goes back to what's saved.
      setSettings(previous);
      setSaveFailed(true);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  const handleRestart = () => {
    window.clubhouse.app.restart();
  };

  if (!loaded) return null;

  return (
    <SettingsPage
      title="Experimental"
      description="These features are unstable and may be buggy. Use at your own risk."
    >
      <p className="text-xs text-ctp-overlay1 mt-3">
        Experimental features may change or go away in future releases. Turning one on or off may need a restart to take full effect.
      </p>

      {saveFailed && <p className={`${settingsError} mt-3`} role="alert">{SETTING_NOT_SAVED_TEXT}</p>}

      <SettingsSection title="Features">
        {EXPERIMENTAL_FEATURES.map(({ id, label, description }) => (
          <SettingsField key={id} label={label} help={id === COPILOT_SDK_FLAG && !isGraduatedFlagOn(settings, 'chat') ? `${description} Needs Chat, which is off in Settings > Agents & providers.` : description}>
            <Toggle
              aria-label={label}
              checked={!!settings[id]}
              disabled={saving}
              onChange={(enabled) => handleToggle(id, enabled)}
            />
          </SettingsField>
        ))}
      </SettingsSection>

      <SettingsSection title="Apply changes">
        <SettingsField label="Restart Clubhouse" help="Restart Clubhouse to apply experimental feature changes.">
          <Button onClick={handleRestart} kind="ghost">
            Restart
          </Button>
        </SettingsField>
      </SettingsSection>
    </SettingsPage>
  );
}
