import { useThemeStore } from '../../stores/themeStore';
import { useUIStore } from '../../stores/uiStore';
import { THEMES, THEME_IDS } from '../../themes';

const VIEW_TOGGLES = [
  {
    key: 'showHome' as const,
    label: 'Home',
    description: 'Show the Home dashboard in the sidebar',
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
  const showHome = useUIStore((s) => s.showHome);
  const setShowHome = useUIStore((s) => s.setShowHome);
  const toggleMap = {
    showHome: { value: showHome, set: setShowHome },
  };

  return (
    <div className="h-full overflow-y-auto bg-ctp-base p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Display & UI</h2>
        <p className="text-sm text-ctp-subtext0 mb-6">Customize the app appearance and sidebar views.</p>

        {/* View toggles */}
        <div className="space-y-3 mb-6">
          <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Views</h3>
          {VIEW_TOGGLES.map(({ key, label, description, icon }) => {
            const { value, set } = toggleMap[key];
            return (
              <div key={key} className="flex items-center justify-between py-1.5">
                <div className="flex items-center gap-2.5">
                  <span className="text-ctp-subtext1">{icon}</span>
                  <div>
                    <div className="text-sm text-ctp-text">{label}</div>
                    <div className="text-xs text-ctp-subtext0 mt-0.5">{description}</div>
                  </div>
                </div>
                <button
                  onClick={() => set(!value)}
                  className="toggle-track"
                  data-on={String(value)}
                >
                  <span className="toggle-knob" />
                </button>
              </div>
            );
          })}
        </div>

        {/* Color theme */}
        <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider mb-3">Color Theme</h3>
        <div className="grid grid-cols-2 gap-3 max-w-lg">
          {THEME_IDS.map((id) => {
            const theme = THEMES[id];
            const selected = id === themeId;
            return (
              <button
                key={id}
                onClick={() => setTheme(id)}
                className={`flex flex-col rounded-lg border-2 p-3 transition-all cursor-pointer ${
                  selected
                    ? 'border-ctp-accent ring-1 ring-ctp-accent'
                    : 'border-surface-1 hover:border-surface-2'
                }`}
                style={{ backgroundColor: theme.colors.base }}
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
                  style={{ color: theme.colors.text }}
                >
                  {theme.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
