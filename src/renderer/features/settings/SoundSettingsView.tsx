import { useEffect, useState } from 'react';
import { useSoundStore } from '../../stores/soundStore';
import {
  SoundEvent,
  ALL_SOUND_EVENTS,
  SOUND_EVENT_LABELS,
  SoundPackInfo,
} from '../../../shared/types';
import { Toggle } from '../../components/Toggle';

// ── Volume Slider ─────────────────────────────────────────────────────

function VolumeSlider({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <div className={`flex items-center gap-2 ${disabled ? 'opacity-40' : ''}`}>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className="w-24 h-1 accent-indigo-500 cursor-pointer"
      />
      <span className="text-xs text-ctp-subtext0 w-8 text-right">{value}%</span>
    </div>
  );
}

// ── Sound Event Row ───────────────────────────────────────────────────

function SoundEventRow({
  event,
  activePack,
  disabled,
}: {
  event: SoundEvent;
  activePack: string | null;
  disabled?: boolean;
}) {
  const { settings, saveSettings, previewSound } = useSoundStore();
  const eventSettings = settings?.eventSettings[event];
  if (!eventSettings) return null;

  const canPreview = activePack !== null;

  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-ctp-text font-medium">{SOUND_EVENT_LABELS[event]}</div>
      </div>
      <div className="flex items-center gap-3">
        <VolumeSlider
          value={eventSettings.volume}
          onChange={(v) => {
            if (!settings) return;
            saveSettings({
              eventSettings: {
                ...settings.eventSettings,
                [event]: { ...eventSettings, volume: v },
              },
            });
          }}
          disabled={disabled || !eventSettings.enabled}
        />
        {canPreview && (
          <button
            type="button"
            onClick={() => previewSound(activePack!, event)}
            disabled={disabled || !eventSettings.enabled}
            className="px-2 py-1 text-xs font-medium rounded-md bg-surface-2 text-ctp-text hover:bg-surface-1 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Preview
          </button>
        )}
        <Toggle
          checked={eventSettings.enabled}
          onChange={(v) => {
            if (!settings) return;
            saveSettings({
              eventSettings: {
                ...settings.eventSettings,
                [event]: { ...eventSettings, enabled: v },
              },
            });
          }}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

// ── Sound Pack Card ───────────────────────────────────────────────────

function SoundPackCard({
  pack,
  isActive,
  onSelect,
  onDelete,
}: {
  pack: SoundPackInfo;
  isActive: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}) {
  const soundCount = Object.keys(pack.sounds).length;
  const events = Object.keys(pack.sounds) as SoundEvent[];

  return (
    <div
      onClick={onSelect}
      className={`
        p-3 rounded-lg border cursor-pointer transition-colors
        ${isActive ? 'border-indigo-500 bg-indigo-500/10' : 'border-surface-1 bg-surface-0 hover:border-surface-2'}
      `}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ctp-text">{pack.name}</span>
          {pack.source === 'plugin' && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-surface-2 text-ctp-subtext0 rounded">Plugin</span>
          )}
          {isActive && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-indigo-500 text-white rounded">Active</span>
          )}
        </div>
        {onDelete && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="text-xs text-ctp-subtext0 hover:text-red-400 transition-colors cursor-pointer"
          >
            Delete
          </button>
        )}
      </div>
      {pack.description && (
        <p className="text-xs text-ctp-subtext0 mb-1">{pack.description}</p>
      )}
      {pack.author && (
        <p className="text-xs text-ctp-subtext0 mb-1">by {pack.author}</p>
      )}
      <div className="flex gap-1.5 flex-wrap">
        {events.map((event) => (
          <span key={event} className="px-1.5 py-0.5 text-[10px] bg-surface-1 text-ctp-subtext0 rounded">
            {SOUND_EVENT_LABELS[event]}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Project Override Section ──────────────────────────────────────────

function ProjectOverrideSection({ projectId }: { projectId: string }) {
  const { settings, saveSettings, packs } = useSoundStore();
  if (!settings) return null;

  const projectOverride = settings.projectOverrides?.[projectId]?.activePack;
  const hasOverride = projectOverride !== undefined;
  const effectivePack = hasOverride ? projectOverride : settings.activePack;

  const setProjectPack = (packId: string | null | undefined) => {
    const overrides = { ...settings.projectOverrides };
    if (packId === undefined) {
      // Remove override
      delete overrides[projectId];
    } else {
      overrides[projectId] = { activePack: packId };
    }
    saveSettings({ projectOverrides: overrides });
  };

  return (
    <div className="space-y-3">
      <h3 className="text-md font-semibold text-ctp-text">Sound Pack Override</h3>
      <p className="text-xs text-ctp-subtext0">Override the active sound pack for this project.</p>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setProjectPack(undefined)}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer
            ${!hasOverride ? 'bg-indigo-500 text-white' : 'bg-surface-2 text-ctp-text hover:bg-surface-1'}`}
        >
          Use Global Default
        </button>
        <button
          type="button"
          onClick={() => setProjectPack(null)}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer
            ${hasOverride && projectOverride === null ? 'bg-indigo-500 text-white' : 'bg-surface-2 text-ctp-text hover:bg-surface-1'}`}
        >
          OS Default
        </button>
        {packs.map((pack) => (
          <button
            key={pack.id}
            type="button"
            onClick={() => setProjectPack(pack.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer
              ${hasOverride && projectOverride === pack.id ? 'bg-indigo-500 text-white' : 'bg-surface-2 text-ctp-text hover:bg-surface-1'}`}
          >
            {pack.name}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main View ─────────────────────────────────────────────────────────

export function SoundSettingsView({ projectId }: { projectId?: string }) {
  const { settings, loadSettings, packs, loadPacks, saveSettings, importPack, deletePack } = useSoundStore();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
    loadPacks();
  }, [loadSettings, loadPacks]);

  if (!settings) {
    return <div className="p-6 text-ctp-subtext0 text-sm">Loading...</div>;
  }

  // Project context: only show pack override
  if (projectId) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold text-ctp-text mb-4">Sounds</h2>
          <ProjectOverrideSection projectId={projectId} />
        </div>
      </div>
    );
  }

  const activePack = settings.activePack;

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-4">Sounds</h2>

        {/* Active Pack Selection */}
        <div className="space-y-3 mb-6">
          <h3 className="text-md font-semibold text-ctp-text">Sound Pack</h3>
          <p className="text-xs text-ctp-subtext0">
            Choose which sound pack to use for notification sounds. Drop sound files into ~/.clubhouse/sounds/&lt;pack-name&gt;/ or import a folder.
          </p>

          <div className="space-y-2">
            {/* OS Default option */}
            <div
              onClick={() => saveSettings({ activePack: null })}
              className={`
                p-3 rounded-lg border cursor-pointer transition-colors
                ${activePack === null ? 'border-indigo-500 bg-indigo-500/10' : 'border-surface-1 bg-surface-0 hover:border-surface-2'}
              `}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-ctp-text">OS Default</span>
                {activePack === null && (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium bg-indigo-500 text-white rounded">Active</span>
                )}
              </div>
              <p className="text-xs text-ctp-subtext0 mt-0.5">Use the operating system's default notification sound</p>
            </div>

            {/* Sound packs */}
            {packs.map((pack) => (
              <SoundPackCard
                key={pack.id}
                pack={pack}
                isActive={activePack === pack.id}
                onSelect={() => saveSettings({ activePack: pack.id })}
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
          </div>

          {/* Import button */}
          <button
            type="button"
            onClick={() => importPack()}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-2 text-ctp-text hover:bg-surface-1 transition-colors cursor-pointer"
          >
            Import Sound Pack...
          </button>
        </div>

        <div className="border-t border-surface-0 mb-6" />

        {/* Per-event settings */}
        <div className="space-y-3">
          <h3 className="text-md font-semibold text-ctp-text">Event Sounds</h3>
          <p className="text-xs text-ctp-subtext0">
            Toggle and adjust volume for each notification event.
          </p>

          <div className="space-y-1">
            {ALL_SOUND_EVENTS.map((event) => (
              <SoundEventRow
                key={event}
                event={event}
                activePack={activePack}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
