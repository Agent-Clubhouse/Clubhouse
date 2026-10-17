import { useEffect, useState } from 'react';
import { useThemeStore } from '../../stores/themeStore';
import { useUIStore } from '../../stores/uiStore';
import { getTheme } from '../../themes';
import { useChromeFlagStore } from '../../chrome/chromeFlag';
import { useChromeStore } from '../../chrome/chromeStore';
import { IDLE_DAY_CHOICES } from '../../chrome/projectActivity';
import { Toggle } from '../../components/Toggle';
import { SettingsPage, SettingsSection, SettingsField, SettingsBlock, settingsInput } from './SettingsLayout';

/** The new layout's idle window (docs/chrome-redesign-spec.md §2 idle rule). */
function IdleProjectsSetting() {
  const idleDays = useChromeStore((s) => s.idleDays);
  const setIdleDays = useChromeStore((s) => s.setIdleDays);
  return (
    <SettingsField
      label="Idle projects"
      help="Unpinned projects with no agent runs and no opened tabs for this long fold into one row at the bottom of the sidebar."
    >
      <select
        aria-label="Idle after"
        data-testid="idle-days"
        value={idleDays}
        onChange={(e) => setIdleDays(Number(e.target.value))}
        className={`${settingsInput} cursor-pointer`}
      >
        {IDLE_DAY_CHOICES.map((d) => <option key={d} value={d}>{d === 0 ? 'Never' : `After ${d} days`}</option>)}
      </select>
    </SettingsField>
  );
}

const VIEW_TOGGLES = [
  {
    key: 'showHome' as const,
    label: 'Home',
    description: 'Show the Home dashboard in the sidebar.',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
  },
];

export function DisplaySettingsView() {
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const availableThemeIds = useThemeStore((s) => s.availableThemeIds);
  const showHome = useUIStore((s) => s.showHome);
  // The new layout has no Home (spec §4.4); its sidebar setting is the idle window instead.
  const newChrome = useChromeFlagStore((s) => s.enabled);
  const setShowHome = useUIStore((s) => s.setShowHome);
  const toggleMap = {
    showHome: { value: showHome, set: setShowHome },
  };

  const [gradientsEnabled, setGradientsEnabled] = useState(false);

  useEffect(() => {
    window.clubhouse.app.getExperimentalSettings().then((s) => {
      setGradientsEnabled(!!s.themeGradients);
    });
  }, []);

  return (
    <SettingsPage title="Display & UI" description="App appearance and sidebar views.">
      <SettingsSection title="Views">
        {newChrome && <IdleProjectsSetting />}
        {!newChrome && VIEW_TOGGLES.map(({ key, label, description, icon }) => {
          const { value, set } = toggleMap[key];
          return (
            <SettingsField
              key={key}
              label={<span className="flex items-center gap-2"><span className="text-ctp-overlay1 flex">{icon}</span>{label}</span>}
              help={description}
            >
              <Toggle aria-label={label} checked={value} onChange={set} />
            </SettingsField>
          );
        })}
      </SettingsSection>

      <SettingsSection title="Color theme">
        <SettingsBlock>
          <div className="grid grid-cols-2 gap-2">
            {availableThemeIds.map((id) => {
              const theme = getTheme(id);
              if (!theme) return null;
              const selected = id === themeId;
              const hasGradient = gradientsEnabled && theme.gradients?.background;
              const cardStyle: React.CSSProperties = {
                backgroundColor: theme.colors.base,
                ...(hasGradient ? { backgroundImage: theme.gradients!.background } : {}),
              };
              const nameStyle: React.CSSProperties = {
                color: theme.colors.text,
                ...(gradientsEnabled && theme.fonts?.ui ? { fontFamily: theme.fonts.ui } : {}),
              };
              return (
                <button
                  key={id}
                  onClick={() => setTheme(id)}
                  type="button"
                  aria-pressed={selected}
                  className={`flex flex-col rounded-lg border-2 p-3 transition-colors cursor-pointer focus-ring ${
                    selected
                      ? 'border-ctp-accent'
                      : 'border-surface-1 hover:border-surface-2'
                  }`}
                  style={cardStyle}
                >
                  {/* Color swatches */}
                  <div className="flex gap-1.5 mb-2">
                    <div
                      className="w-5 h-5 rounded-full"
                      style={{ backgroundColor: theme.colors.mantle }}
                      title="Mantle"
                    />
                    <div
                      className="w-5 h-5 rounded-full"
                      style={{ backgroundColor: theme.colors.surface0 }}
                      title="Surface"
                    />
                    <div
                      className="w-5 h-5 rounded-full"
                      style={{ backgroundColor: theme.colors.text }}
                      title="Text"
                    />
                    <div
                      className="w-5 h-5 rounded-full"
                      style={{ backgroundColor: theme.colors.accent }}
                      title="Accent"
                    />
                  </div>
                  {/* Theme name */}
                  <span
                    className="text-xs font-medium text-left"
                    style={nameStyle}
                  >
                    {theme.name}
                  </span>
                </button>
              );
            })}
          </div>
        </SettingsBlock>
      </SettingsSection>
    </SettingsPage>
  );
}
