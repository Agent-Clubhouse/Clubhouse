import { useEffect, useState } from 'react';
import { useNotificationStore } from '../../stores/notificationStore';
import { useBadgeStore } from '../../stores/badgeStore';
import { useBadgeSettingsStore, ResolvedBadgeSettings } from '../../stores/badgeSettingsStore';
import { useSoundStore } from '../../stores/soundStore';
import { ALL_SOUND_EVENTS } from '../../../shared/types';
import { Toggle } from '../../components/Toggle';
import { SoundEventRow, SoundPackCard, ProjectSoundOverrideSection } from './sound-components';

const TOGGLES: { key: keyof Omit<import('../../../shared/types').NotificationSettings, 'enabled' | 'playSound'>; label: string; description: string }[] = [
  { key: 'permissionNeeded', label: 'Permission Needed', description: 'Notify when an agent is waiting for approval' },
  { key: 'agentStopped', label: 'Agent Stopped', description: 'Notify when an agent has finished running' },
  { key: 'agentIdle', label: 'Agent Idle', description: 'Notify when an agent is waiting for input' },
  { key: 'agentError', label: 'Agent Error', description: 'Notify when a tool call fails' },
];

// Three-state toggle for project overrides: global default / on / off
function TriStateToggle({ value, onChange, disabled }: {
  value: boolean | undefined; // undefined = use global
  onChange: (v: boolean | undefined) => void;
  disabled?: boolean;
}) {
  const states: Array<{ label: string; val: boolean | undefined }> = [
    { label: 'Global', val: undefined },
    { label: 'On', val: true },
    { label: 'Off', val: false },
  ];

  return (
    <div className={`flex rounded-md overflow-hidden border border-surface-1 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      {states.map(({ label, val }) => (
        <button
          key={label}
          type="button"
          onClick={() => !disabled && onChange(val)}
          className={`
            px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors
            ${value === val ? 'bg-ctp-accent text-white' : 'bg-surface-0 text-ctp-subtext0 hover:bg-surface-1'}
          `}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const BADGE_TOGGLES: { key: keyof ResolvedBadgeSettings; label: string; description: string }[] = [
  { key: 'pluginBadges', label: 'Plugin Badges', description: 'Show badge indicators from plugins' },
  { key: 'projectRailBadges', label: 'Project Rail Badges', description: 'Show aggregated badges on project icons in the sidebar' },
];

function BadgeSettingsSection({ projectId }: { projectId?: string }) {
  const { enabled, pluginBadges, projectRailBadges, projectOverrides,
    saveAppSettings, setProjectOverride, clearProjectOverride, getProjectSettings } = useBadgeSettingsStore();
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
      <>
        <h3 className="text-md font-semibold text-ctp-text mt-6 mb-4">Badges</h3>
        <div className="space-y-5">
          {/* Master toggle */}
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-ctp-text font-medium">Enable Badges</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">Show badge indicators on tabs and the project rail</div>
            </div>
            <TriStateToggle
              value={overrides?.enabled}
              onChange={(v) => handleProjectToggle('enabled', v)}
            />
          </div>

          {BADGE_TOGGLES.map(({ key, label, description }) => (
            <div key={key} className="flex items-center justify-between py-2">
              <div>
                <div className="text-sm text-ctp-text font-medium">{label}</div>
                <div className="text-xs text-ctp-subtext0 mt-0.5">{description}</div>
              </div>
              <TriStateToggle
                value={overrides?.[key]}
                onChange={(v) => handleProjectToggle(key, v)}
                disabled={!resolved.enabled}
              />
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <h3 className="text-md font-semibold text-ctp-text mt-6 mb-4">Badges</h3>
      <div className="space-y-5">
        {/* Master toggle */}
        <div className="flex items-center justify-between py-2">
          <div>
            <div className="text-sm text-ctp-text font-medium">Enable Badges</div>
            <div className="text-xs text-ctp-subtext0 mt-0.5">Show badge indicators on tabs and the project rail</div>
          </div>
          <Toggle checked={resolved.enabled} onChange={(v) => handleAppToggle('enabled', v)} />
        </div>

        {BADGE_TOGGLES.map(({ key, label, description }) => (
          <div key={key} className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-ctp-text font-medium">{label}</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">{description}</div>
            </div>
            <Toggle
              checked={resolved[key]}
              onChange={(v) => handleAppToggle(key, v)}
              disabled={!resolved.enabled}
            />
          </div>
        ))}

        <div className="border-t border-surface-0" />

        {/* Clear all badges */}
        <div className="flex items-center justify-between py-2">
          <div>
            <div className="text-sm text-ctp-text font-medium">Clear All Badges</div>
            <div className="text-xs text-ctp-subtext0 mt-0.5">Remove all badge indicators from tabs, projects, and the dock</div>
          </div>
          <button
            type="button"
            onClick={() => useBadgeStore.getState().clearAll()}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-2 text-ctp-text hover:bg-surface-1 transition-colors cursor-pointer"
          >
            Clear All
          </button>
        </div>
      </div>
    </>
  );
}

// ── App-level Sound Section ────────────────────────────────────────────

function AppSoundSection() {
  const { settings, packs, saveSettings, importPack, deletePack, applyAllFromPack } = useSoundStore();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  if (!settings) return null;

  return (
    <>
      <h3 className="text-md font-semibold text-ctp-text mt-6 mb-4">Sounds</h3>

      {/* Per-slot sound selection */}
      <div className="space-y-3 mb-6">
        <h4 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Event Sounds</h4>
        <p className="text-xs text-ctp-subtext0">
          Choose which sound to play for each event. Mix and match sounds from different packs.
        </p>

        <div className="space-y-1">
          {ALL_SOUND_EVENTS.map((event) => (
            <SoundEventRow
              key={event}
              event={event}
              packs={packs}
            />
          ))}
        </div>
      </div>

      <div className="border-t border-surface-0 mb-6" />

      {/* Sound Packs management */}
      <div className="space-y-3">
        <h4 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Sound Packs</h4>
        <p className="text-xs text-ctp-subtext0">
          Sound packs provide sounds for each slot. Use &quot;Apply All&quot; to set every slot from one pack, or mix and match above.
          Drop sound files into ~/.clubhouse/sounds/&lt;pack-name&gt;/ or import a folder.
        </p>

        <div className="space-y-2">
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
            <p className="text-xs text-ctp-subtext0 py-2">No sound packs installed. Import one to get started.</p>
          )}
        </div>

        {/* Import button */}
        <button
          type="button"
          onClick={() => importPack()}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-2 text-ctp-text hover:bg-surface-1 transition-colors cursor-pointer"
        >
          Import Sound Pack...
        </button>

        {/* Reset All to OS Default */}
        {Object.keys(settings.slotAssignments).length > 0 && (
          <button
            type="button"
            onClick={() => saveSettings({ slotAssignments: {} })}
            className="ml-2 px-3 py-1.5 text-xs font-medium rounded-md bg-surface-2 text-ctp-subtext0 hover:bg-surface-1 transition-colors cursor-pointer"
          >
            Reset All to OS Default
          </button>
        )}
      </div>
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
    return <div className="p-6 text-ctp-subtext0 text-sm">Loading...</div>;
  }

  // Project context: badges + sound overrides
  if (projectId) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold text-ctp-text mb-4">Notifications & Alerts</h2>
          <BadgeSettingsSection projectId={projectId} />

          <div className="border-t border-surface-0 mt-6" />
          <ProjectSoundOverrideSection projectId={projectId} packs={packs} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-4">Notifications & Alerts</h2>

        <div className="space-y-5">
          {/* Master toggle */}
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-ctp-text font-medium">Enable Notifications</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">Show desktop notifications for agent events</div>
            </div>
            <Toggle checked={settings.enabled} onChange={(v) => saveSettings({ enabled: v })} />
          </div>

          <div className="border-t border-surface-0" />

          {/* Event toggles */}
          {TOGGLES.map(({ key, label, description }) => (
            <div key={key} className="flex items-center justify-between py-2">
              <div>
                <div className="text-sm text-ctp-text font-medium">{label}</div>
                <div className="text-xs text-ctp-subtext0 mt-0.5">{description}</div>
              </div>
              <Toggle
                checked={settings[key]}
                onChange={(v) => saveSettings({ [key]: v })}
                disabled={!settings.enabled}
              />
            </div>
          ))}

          <div className="border-t border-surface-0" />

          {/* Test notification */}
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-ctp-text font-medium">Test Notification</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">Send a test notification to verify your system permissions</div>
            </div>
            <button
              type="button"
              onClick={() => window.clubhouse.app.sendNotification('Clubhouse', 'Notifications are working!', !settings.playSound)}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-2 text-ctp-text hover:bg-surface-1 transition-colors cursor-pointer"
            >
              Send Test
            </button>
          </div>
        </div>

        <BadgeSettingsSection />

        <div className="border-t border-surface-0 mt-6" />

        <AppSoundSection />
      </div>
    </div>
  );
}
