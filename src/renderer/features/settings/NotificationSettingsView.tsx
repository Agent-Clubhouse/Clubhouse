import { useEffect, useState } from 'react';
import { useNotificationStore } from '../../stores/notificationStore';
import { useBadgeStore } from '../../stores/badgeStore';
import { useBadgeSettingsStore, ResolvedBadgeSettings } from '../../stores/badgeSettingsStore';
import { useSoundStore } from '../../stores/soundStore';
import { ALL_SOUND_EVENTS } from '../../../shared/types';
import { Toggle } from '../../components/Toggle';
import { SoundEventRow, SoundPackCard, ProjectSoundOverrideSection } from './sound-components';
import { Spinner } from '../../components/Spinner';
import { useChromeFlagStore } from '../../chrome/chromeFlag';
import { SettingsPage, SettingsSection, SettingsField, settingsHelp } from './SettingsLayout';
import { Button } from '../../components/Button';

const TOGGLES: { key: keyof Omit<import('../../../shared/types').NotificationSettings, 'enabled' | 'playSound'>; label: string; description: string }[] = [
  { key: 'permissionNeeded', label: 'An agent needs permission', description: '' },
  { key: 'agentStopped', label: 'An agent stops', description: '' },
  { key: 'agentIdle', label: 'An agent is waiting for input', description: '' },
  { key: 'agentError', label: 'A tool call fails', description: '' },
  { key: 'agentRequestedAttention', label: 'An agent asks for me', description: 'When it calls the notify_user tool.' },
];

// Three-state toggle for project overrides: global default / on / off
function TriStateToggle({ value, onChange, disabled, 'aria-label': ariaLabel }: {
  value: boolean | undefined; // undefined = use global
  onChange: (v: boolean | undefined) => void;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const states: Array<{ label: string; val: boolean | undefined }> = [
    { label: 'Global', val: undefined },
    { label: 'On', val: true },
    { label: 'Off', val: false },
  ];

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`flex h-7 p-0.5 gap-0.5 rounded-md border border-surface-1 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      {states.map(({ label, val }) => (
        <button
          key={label}
          type="button"
          role="radio"
          aria-checked={value === val}
          onClick={() => !disabled && onChange(val)}
          className={`px-2 rounded text-xs cursor-pointer transition-colors ${
            value === val ? 'bg-surface-1 text-ctp-text' : 'text-ctp-overlay1 hover:text-ctp-text'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function useBadgeToggles(): { key: keyof ResolvedBadgeSettings; label: string; description: string }[] {
  // Nothing in the new layout reads projectRailBadges (it has no project rail), so hide it there.
  const newChrome = useChromeFlagStore((s) => s.enabled);
  return [
    { key: 'pluginBadges', label: 'Plugin badges', description: 'Counts that plugins add to their tabs.' },
    ...(newChrome ? [] : [{ key: 'projectRailBadges' as const, label: 'Project rail badges', description: 'Totals on project icons in the project rail.' }]),
  ];
}

function useBadgesHelp(): string {
  const newChrome = useChromeFlagStore((s) => s.enabled);
  return newChrome ? 'Counts on title-bar tabs and the Dock icon.' : 'Counts on tabs, project icons and the Dock icon.';
}

function BadgeSettingsSection({ projectId }: { projectId?: string }) {
  const { enabled, pluginBadges, projectRailBadges, projectOverrides,
    saveAppSettings, setProjectOverride, clearProjectOverride, getProjectSettings } = useBadgeSettingsStore();
  const badgeToggles = useBadgeToggles();
  const badgesHelp = useBadgesHelp();
  const resolved = projectId
    ? getProjectSettings(projectId)
    : { enabled, pluginBadges, projectRailBadges };
  const overrides = projectId ? projectOverrides[projectId] : undefined;

  const handleAppToggle = (key: keyof ResolvedBadgeSettings, value: boolean) => {
    saveAppSettings({ [key]: value });
  };

  const handleProjectToggle = async (key: keyof ResolvedBadgeSettings, value: boolean | undefined) => {
    if (!projectId) return;
    if (value === undefined) {
      // Remove this key from overrides
      const current = projectOverrides[projectId] ?? {};
      const { [key]: _, ...rest } = current;
      await clearProjectOverride(projectId);
      if (Object.keys(rest).length > 0) {
        setProjectOverride(projectId, rest);
      }
    } else {
      setProjectOverride(projectId, { [key]: value });
    }
  };

  if (projectId) {
    return (
      <SettingsSection title="Badges">
        <SettingsField label="Show badges" help={badgesHelp}>
          <TriStateToggle
            aria-label="Show badges"
            value={overrides?.enabled}
            onChange={(v) => handleProjectToggle('enabled', v)}
          />
        </SettingsField>
        {badgeToggles.map(({ key, label, description }) => (
          <SettingsField key={key} label={label} help={description}>
            <TriStateToggle
              aria-label={label}
              value={overrides?.[key]}
              onChange={(v) => handleProjectToggle(key, v)}
              disabled={!resolved.enabled}
            />
          </SettingsField>
        ))}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Badges">
      <SettingsField label="Show badges" help={badgesHelp}>
        <Toggle aria-label="Show badges" checked={resolved.enabled} onChange={(v) => handleAppToggle('enabled', v)} />
      </SettingsField>
      {badgeToggles.map(({ key, label, description }) => (
        <SettingsField key={key} label={label} help={description}>
          <Toggle
            aria-label={label}
            checked={resolved[key]}
            onChange={(v) => handleAppToggle(key, v)}
            disabled={!resolved.enabled}
          />
        </SettingsField>
      ))}
      <SettingsField label="Clear all badges" help="Remove every count from tabs, projects and the Dock.">
        <Button onClick={() => useBadgeStore.getState().clearAll()} kind="ghost">
          Clear
        </Button>
      </SettingsField>
    </SettingsSection>
  );
}

// ── App-level Sound Section ────────────────────────────────────────────

function AppSoundSection() {
  const { settings, packs, saveSettings, importPack, deletePack, applyAllFromPack } = useSoundStore();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  if (!settings) return null;

  return (
    <>
      <SettingsSection title="Sounds" meta="Pick a sound for each event. Mix sounds from different packs.">
        {ALL_SOUND_EVENTS.map((event) => (
          <SoundEventRow
            key={event}
            event={event}
            packs={packs}
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title="Sound packs"
        actions={
          <>
            {Object.keys(settings.slotAssignments).length > 0 && (
              <Button onClick={() => saveSettings({ slotAssignments: {} })} kind="quiet">
                Reset to system sounds
              </Button>
            )}
            <Button onClick={() => importPack()} kind="ghost">
              Import pack…
            </Button>
          </>
        }
      >
        <p className={`${settingsHelp} mb-2`}>
          Drop sound files into <span className="font-mono">~/.clubhouse/sounds/&lt;pack-name&gt;/</span> or import a folder.
        </p>
        {packs.map((pack) => (
          <SoundPackCard
            key={pack.id}
            pack={pack}
            onApplyAll={() => applyAllFromPack(pack.id)}
            onDelete={pack.source === 'user' ? () => {
              if (confirmDelete === pack.id) {
                deletePack(pack.id);
                setConfirmDelete(null);
              } else {
                setConfirmDelete(pack.id);
                setTimeout(() => setConfirmDelete(null), 3000);
              }
            } : undefined}
          />
        ))}
        {packs.length === 0 && (
          <p className={`${settingsHelp} py-2 border-t border-surface-0`}>No sound packs installed. Import one to get started.</p>
        )}
      </SettingsSection>
    </>
  );
}

// ── Main View ──────────────────────────────────────────────────────────

export function NotificationSettingsView({ projectId }: { projectId?: string }) {
  const { settings, loadSettings, saveSettings } = useNotificationStore();
  const loadBadgeSettings = useBadgeSettingsStore((s) => s.loadSettings);
  const { loadSettings: loadSoundSettings, loadPacks, packs } = useSoundStore();

  useEffect(() => {
    loadSettings();
    loadBadgeSettings();
    loadSoundSettings();
    loadPacks();
  }, [loadSettings, loadBadgeSettings, loadSoundSettings, loadPacks]);

  if (!settings) {
    return <div className="p-6 flex items-center gap-2 text-ctp-subtext0 text-sm"><Spinner size="sm" /> Loading…</div>;
  }

  // Project context: badges + sound overrides
  if (projectId) {
    return (
      <SettingsPage title="Notifications & alerts" description="Badges and sounds for this project. Global uses the app setting.">
        <BadgeSettingsSection projectId={projectId} />
        <ProjectSoundOverrideSection projectId={projectId} packs={packs} />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title="Notifications & alerts" description="Desktop notifications, badges and sounds for every project.">
      <div className="mt-[22px]">
        <SettingsField label="Desktop notifications" help="Show a system notification for the events below.">
          <Toggle aria-label="Desktop notifications" checked={settings.enabled} onChange={(v) => saveSettings({ enabled: v })} />
        </SettingsField>
      </div>

      <SettingsSection title="Notify me when">
        {TOGGLES.map(({ key, label, description }) => (
          <SettingsField key={key} label={label} help={description || undefined}>
            <Toggle
              aria-label={label}
              checked={settings[key]}
              onChange={(v) => saveSettings({ [key]: v })}
              disabled={!settings.enabled}
            />
          </SettingsField>
        ))}
        <SettingsField label="Test notification" help="Check that your system lets Clubhouse notify you.">
          <Button
            onClick={() => window.clubhouse.app.sendNotification('Clubhouse', 'Notifications are working!', !settings.playSound)}
            kind="ghost"
          >
            Send test
          </Button>
        </SettingsField>
      </SettingsSection>

      <BadgeSettingsSection />

      <AppSoundSection />
    </SettingsPage>
  );
}
