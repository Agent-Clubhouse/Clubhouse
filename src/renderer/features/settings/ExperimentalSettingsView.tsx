import { useEffect, useState } from 'react';
import { Toggle } from '../../components/Toggle';
import { SettingsPage, SettingsSection, SettingsField } from './SettingsLayout';
import { Button } from '../../components/Button';
import { RICH_CHAT_CONTENT_FLAG, resetRichChatContentFlag } from '../agents/chat/rich/rich-flag';

/** Feature definitions for the experimental settings page. */
const EXPERIMENTAL_FEATURES: Array<{
  id: string;
  label: string;
  description: string;
}> = [
  {
    id: 'themeGradients',
    label: 'Theme gradients & fonts',
    description: 'Allow themes to define custom font families and background gradients. Requires app restart.',
  },
  {
    id: 'newChrome',
    label: 'New layout',
    description: 'One resizable sidebar for projects and agents, with project tabs in the title bar. Work in progress. Requires app restart.',
  },
  {
    id: 'goobers',
    label: 'Goobers',
    description: 'Monitor and control a local Goobers instance from an app-level panel. Not available on Windows. Requires app restart.',
  },
  {
    id: 'chat',
    label: 'Chat',
    description: 'Talk to Claude Code, Codex and Copilot agents in a native chat view. The terminal stays available for every provider.',
  },
  {
    id: RICH_CHAT_CONTENT_FLAG,
    label: 'Rich chat content',
    description: 'Show images agents return inline in chat, links as links, and GitHub pull requests, issues and commits as references with a hover card. Images from the web load only when you click them, and GitHub details load through the gh CLI only when you hover one.',
  },
  {
    id: 'dispatcher',
    label: 'Dispatcher',
    description: 'One app-wide agent that coordinates the orchestrators in your projects. Turn it on in Settings, Dispatcher, after turning this on.',
  },
  {
    id: 'telemetry',
    label: 'Telemetry export',
    description: 'Send anonymized telemetry to your own Application Insights resource or OTLP collector (Settings, Logging), or to the Clubhouse developer with your feedback (Settings, Feedback).',
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
    // Chat panes opened from now on read the new value.
    if (id === RICH_CHAT_CONTENT_FLAG) resetRichChatContentFlag();
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

      <SettingsSection title="Features">
        {EXPERIMENTAL_FEATURES.map(({ id, label, description }) => (
          <SettingsField key={id} label={label} help={description}>
            <Toggle
              aria-label={label}
              checked={!!settings[id]}
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
