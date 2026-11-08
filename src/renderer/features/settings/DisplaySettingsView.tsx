import { useEffect, useId, useMemo, useState } from 'react';
import { useThemeStore } from '../../stores/themeStore';
import { getTheme } from '../../themes';
import { usePluginStore } from '../../plugins/plugin-store';
import type { ThemeDefinition, ThemeId } from '../../../shared/types';
import { groupThemes, themeSource, type ThemeKindFilter } from './theme-picker';
import { useChromeFlagStore, NEW_CHROME_FLAG } from '../../chrome/chromeFlag';
import { useChromeStore, SIDEBAR_SORTS, type SidebarSort } from '../../chrome/chromeStore';
import { IDLE_DAY_CHOICES } from '../../chrome/projectActivity';
import { isGraduatedFlagOn } from '../../../shared/graduated-flags';
import { Button } from '../../components/Button';
import { Toggle } from '../../components/Toggle';
import { SettingsPage, SettingsSection, SettingsField, SettingsBlock, settingsInput, settingsError, settingsHelp, SETTING_NOT_SAVED_TEXT } from './SettingsLayout';

/**
 * The way back to the classic layout, saved as the newChrome flag (on = false).
 * This session's layout is fixed (docs/chrome-redesign-spec.md §4.1), so the
 * restart is offered while the saved choice differs from it.
 */
function ClassicLayoutSetting() {
  const newChrome = useChromeFlagStore((s) => s.enabled);
  const [classic, setClassic] = useState(!newChrome);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    window.clubhouse.app.getExperimentalSettings().then((s) => {
      setClassic(!isGraduatedFlagOn(s, NEW_CHROME_FLAG));
    }).catch(() => {
      // telemetry-exempt: the switch keeps showing this session's layout, and a save reports its own failure.
    });
  }, []);

  const handleToggle = async (on: boolean) => {
    setClassic(on);
    setSaving(true);
    setSaveFailed(false);
    try {
      const saved = await window.clubhouse.app.getExperimentalSettings();
      await window.clubhouse.app.saveExperimentalSettings({ ...saved, [NEW_CHROME_FLAG]: !on });
    } catch {
      // telemetry-exempt: shown under the switch, which goes back to the saved value.
      setClassic(!on);
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsField
        label="Classic layout"
        help="Use the project rail and agent column instead of the sidebar. Applies after a restart. The classic layout will go away in a future update."
      >
        <Toggle aria-label="Classic layout" checked={classic} disabled={saving} onChange={handleToggle} />
      </SettingsField>
      {saveFailed && <p className={`${settingsError} mt-1.5`} role="alert">{SETTING_NOT_SAVED_TEXT}</p>}
      {classic === newChrome && (
        <SettingsField label="Restart Clubhouse" help="Restart Clubhouse to apply the layout change.">
          <Button onClick={() => window.clubhouse.app.restart()} kind="ghost">
            Restart
          </Button>
        </SettingsField>
      )}
    </>
  );
}

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

const SORT_LABELS: Record<SidebarSort, string> = { manual: 'Manual', recent: 'Most recent first' };

/** Manual or recent order for the sidebar's projects or agents (#2116). */
function SidebarSortSetting({ kind }: { kind: 'project' | 'agent' }) {
  const sort = useChromeStore((s) => (kind === 'project' ? s.projectSort : s.agentSort));
  const setSort = useChromeStore((s) => (kind === 'project' ? s.setProjectSort : s.setAgentSort));
  const noun = kind === 'project' ? 'projects' : 'agents';
  return (
    <SettingsField
      label={kind === 'project' ? 'Project order' : 'Agent order'}
      help={kind === 'project'
        ? 'Manual keeps the order you set by dragging or Move up and Move down. Most recent first puts the projects with the latest agent activity on top.'
        : 'Manual keeps the order you set by dragging or Move up and Move down. Most recent first puts the agents that woke or worked last on top.'}
    >
      <select
        aria-label={`Order ${noun}`}
        data-testid={`${kind}-sort`}
        value={sort}
        onChange={(e) => setSort(e.target.value as SidebarSort)}
        className={`${settingsInput} cursor-pointer`}
      >
        {SIDEBAR_SORTS.map((value) => <option key={value} value={value}>{SORT_LABELS[value]}</option>)}
      </select>
    </SettingsField>
  );
}

const KIND_LABELS: Record<ThemeKindFilter, string> = { all: 'All themes', dark: 'Dark', light: 'Light' };

/** One theme, drawn in its own colors. */
function ThemeCard({ theme, selected, gradientsEnabled, onPick }: { theme: ThemeDefinition; selected: boolean; gradientsEnabled: boolean; onPick: () => void }) {
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
      onClick={onPick}
      type="button"
      aria-pressed={selected}
      data-testid={`theme-card-${theme.id}`}
      className={`flex flex-col rounded-lg border-2 p-3 transition-colors cursor-pointer focus-ring ${
        selected ? 'border-ctp-accent' : 'border-surface-1 hover:border-surface-2'
      }`}
      style={cardStyle}
    >
      <div className="flex gap-1.5 mb-2" aria-hidden="true">
        {[theme.colors.mantle, theme.colors.surface0, theme.colors.text, theme.colors.accent].map((color, i) => (
          <div key={i} className="w-5 h-5 rounded-full" style={{ backgroundColor: color }} />
        ))}
      </div>
      <span className="text-xs font-medium text-left" style={nameStyle}>{theme.name}</span>
    </button>
  );
}

/**
 * Every built-in and plugin theme, searchable, filterable by light or dark,
 * and grouped by where it comes from (#2754). The current theme is named
 * above the list, so it stays findable when a search hides its card.
 */
function ThemePicker({ themeId, availableThemeIds, gradientsEnabled, onPick }: {
  themeId: ThemeId;
  availableThemeIds: ThemeId[];
  gradientsEnabled: boolean;
  onPick: (id: ThemeId) => void;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ThemeKindFilter>('all');
  const plugins = usePluginStore((s) => s.plugins);
  const idBase = useId();
  const pluginName = (pluginId: string) => plugins[pluginId]?.manifest.name;
  const themes = useMemo(
    () => availableThemeIds.map((id) => getTheme(id)).filter((t): t is ThemeDefinition => !!t),
    [availableThemeIds],
  );
  const groups = groupThemes(themes, { query, kind, pluginName });
  const current = themes.find((t) => t.id === themeId);
  const currentShown = groups.some((g) => g.themes.some((t) => t.id === themeId));
  const filtered = query.trim() !== '' || kind !== 'all';
  const clear = () => { setQuery(''); setKind('all'); };

  return (
    <div data-testid="theme-picker">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <input
          type="search"
          aria-label="Search themes"
          placeholder="Search themes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${settingsInput} flex-1 min-w-[10rem]`}
        />
        <select
          aria-label="Show"
          value={kind}
          onChange={(e) => setKind(e.target.value as ThemeKindFilter)}
          className={`${settingsInput} cursor-pointer`}
        >
          {(Object.keys(KIND_LABELS) as ThemeKindFilter[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
        </select>
      </div>
      {current && (
        <p className={`${settingsHelp} mb-3`} data-testid="current-theme">
          Using {current.name}, from {themeSource(current, pluginName).label}.
          {!currentShown && (
            <>
              {' '}It's hidden by the search or filter.{' '}
              <button type="button" onClick={clear} className="underline text-ctp-text focus-ring rounded-sm cursor-pointer">Show all themes</button>
            </>
          )}
        </p>
      )}
      {groups.length === 0 ? (
        <div data-testid="theme-picker-empty">
          <p className={settingsHelp}>No themes match{query.trim() ? ` "${query.trim()}"` : ''}{kind !== 'all' ? ` among ${kind} themes` : ''}.</p>
          <Button kind="ghost" onClick={clear} className="mt-2">Clear search and filter</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => {
            const headingId = `${idBase}-${group.key}`;
            return (
              <section key={group.key} aria-labelledby={headingId} data-testid={`theme-group-${group.key}`}>
                <h3 id={headingId} className="text-xs font-medium text-ctp-subtext1 mb-1.5">
                  {group.label}
                  {filtered && <span className="ml-1.5 font-normal text-ctp-overlay1">{group.themes.length}</span>}
                </h3>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
                  {group.themes.map((theme) => (
                    <ThemeCard
                      key={theme.id}
                      theme={theme}
                      selected={theme.id === themeId}
                      gradientsEnabled={gradientsEnabled}
                      onPick={() => onPick(theme.id)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function DisplaySettingsView() {
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const availableThemeIds = useThemeStore((s) => s.availableThemeIds);
  // The sidebar's view settings belong to the new layout; the classic rail has none since Home was removed.
  const newChrome = useChromeFlagStore((s) => s.enabled);

  const gradientsEnabled = useThemeStore((s) => s.experimentalGradients);
  const setThemeGradients = useThemeStore((s) => s.setThemeGradients);
  const [gradientsSaveFailed, setGradientsSaveFailed] = useState(false);
  const changeGradients = async (on: boolean) => {
    setGradientsSaveFailed(false);
    setGradientsSaveFailed(!await setThemeGradients(on));
  };

  return (
    <SettingsPage title="Display & UI" description="App appearance and sidebar views.">
      <SettingsSection title="Layout">
        <ClassicLayoutSetting />
      </SettingsSection>

      {newChrome && (
        <SettingsSection title="Views">
          <IdleProjectsSetting />
          <SidebarSortSetting kind="project" />
          <SidebarSortSetting kind="agent" />
        </SettingsSection>
      )}

      <SettingsSection title="Color theme">
        <SettingsField
          label="Theme gradients & fonts"
          help="Let themes use their own font families and background gradients. Themes that don't define any look the same either way."
          testId="theme-gradients-row"
        >
          <Toggle aria-label="Theme gradients & fonts" checked={gradientsEnabled} onChange={(on) => { void changeGradients(on); }} />
        </SettingsField>
        {gradientsSaveFailed && (
          <SettingsBlock>
            <p className={settingsError} role="alert">{SETTING_NOT_SAVED_TEXT}</p>
          </SettingsBlock>
        )}
        <SettingsBlock>
          <ThemePicker themeId={themeId} availableThemeIds={availableThemeIds} gradientsEnabled={gradientsEnabled} onPick={setTheme} />
        </SettingsBlock>
      </SettingsSection>
    </SettingsPage>
  );
}
