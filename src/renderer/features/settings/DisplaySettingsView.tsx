import { useThemeStore } from '../../stores/themeStore';
import { THEMES, THEME_IDS } from '../../themes';

export function DisplaySettingsView() {
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <div className="h-full overflow-y-auto bg-ctp-base p-6">
      <h2 className="text-lg font-semibold text-ctp-text mb-1">Display & UI</h2>
      <p className="text-sm text-ctp-subtext0 mb-6">Choose a color theme for the app.</p>

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
  );
}
