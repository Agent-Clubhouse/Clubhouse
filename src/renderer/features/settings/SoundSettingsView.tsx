import { useEffect, useState } from 'react';
import { useSoundStore } from '../../stores/soundStore';
import {
  SoundEvent,
  ALL_SOUND_EVENTS,
  SOUND_EVENT_LABELS,
  SoundPackInfo,
  SlotAssignment,
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

// ── Slot Dropdown ─────────────────────────────────────────────────────

/** Build options list: packs that have a sound for this event. */
function buildSlotOptions(event: SoundEvent, packs: SoundPackInfo[]): { packId: string; label: string }[] {
  const options: { packId: string; label: string }[] = [];
  for (const pack of packs) {
    if (pack.sounds[event]) {
      options.push({ packId: pack.id, label: pack.name });
    }
  }
  return options;
}

function SlotDropdown({
  event,
  packs,
  selectedPackId,
  onChange,
  disabled,
}: {
  event: SoundEvent;
  packs: SoundPackInfo[];
  selectedPackId: string | null;
  onChange: (packId: string | null) => void;
  disabled?: boolean;
}) {
  const options = buildSlotOptions(event, packs);

  return (
    <select
      value={selectedPackId ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      disabled={disabled}
      className="px-2 py-1 text-xs rounded-md bg-surface-2 text-ctp-text border border-surface-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed min-w-[120px]"
    >
      <option value="">OS Default</option>
      {options.map((opt) => (
        <option key={opt.packId} value={opt.packId}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

// ── Sound Event Row ───────────────────────────────────────────────────

function SoundEventRow({
  event,
  packs,
  disabled,
}: {
  event: SoundEvent;
  packs: SoundPackInfo[];
  disabled?: boolean;
}) {
  const { settings, saveSettings, previewSound } = useSoundStore();
  const eventSettings = settings?.eventSettings[event];
  if (!eventSettings || !settings) return null;

  const slotPackId = settings.slotAssignments[event]?.packId ?? null;

  const setSlotPack = (packId: string | null) => {
    const slots = { ...settings.slotAssignments };
    if (packId) {
      slots[event] = { packId };
    } else {
      delete slots[event];
    }
    saveSettings({ slotAssignments: slots });
  };

  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-ctp-text font-medium">{SOUND_EVENT_LABELS[event]}</div>
      </div>
      <div className="flex items-center gap-3">
        <SlotDropdown
          event={event}
          packs={packs}
          selectedPackId={slotPackId}
          onChange={setSlotPack}
          disabled={disabled || !eventSettings.enabled}
        />
        <VolumeSlider
          value={eventSettings.volume}
          onChange={(v) => {
            saveSettings({
              eventSettings: {
                ...settings.eventSettings,
                [event]: { ...eventSettings, volume: v },
              },
            });
          }}
          disabled={disabled || !eventSettings.enabled}
        />
        {slotPackId && (
          <button
            type="button"
            onClick={() => previewSound(slotPackId, event)}
            disabled={disabled || !eventSettings.enabled}
            className="px-2 py-1 text-xs font-medium rounded-md bg-surface-2 text-ctp-text hover:bg-surface-1 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Preview
          </button>
        )}
        <Toggle
          checked={eventSettings.enabled}
          onChange={(v) => {
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

// ── Sound Pack Card (for pack management) ────────────────────────────

function SoundPackCard({
  pack,
  onApplyAll,
  onDelete,
}: {
  pack: SoundPackInfo;
  onApplyAll: () => void;
  onDelete?: () => void;
}) {
  const events = Object.keys(pack.sounds) as SoundEvent[];

  return (
    <div className="p-3 rounded-lg border border-surface-1 bg-surface-0">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ctp-text">{pack.name}</span>
          {pack.source === 'plugin' && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-surface-2 text-ctp-subtext0 rounded">Plugin</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onApplyAll}
            className="px-2 py-1 text-xs font-medium rounded-md bg-indigo-500 text-white hover:bg-indigo-600 transition-colors cursor-pointer"
          >
            Apply All
          </button>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="text-xs text-ctp-subtext0 hover:text-red-400 transition-colors cursor-pointer"
            >
              Delete
            </button>
          )}
        </div>
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

function ProjectOverrideSection({ projectId, packs }: { projectId: string; packs: SoundPackInfo[] }) {
  const { settings, saveSettings } = useSoundStore();
  if (!settings) return null;

  const projectSlots = settings.projectOverrides?.[projectId]?.slotAssignments;
  const hasOverrides = projectSlots && Object.keys(projectSlots).length > 0;

  const clearOverrides = () => {
    const overrides = { ...settings.projectOverrides };
    delete overrides[projectId];
    saveSettings({ projectOverrides: overrides });
  };

  const applyAllForProject = (packId: string) => {
    const overrides = { ...settings.projectOverrides };
    const slots: Partial<Record<SoundEvent, SlotAssignment>> = {};
    for (const event of ALL_SOUND_EVENTS) {
      slots[event] = { packId };
    }
    overrides[projectId] = { slotAssignments: slots };
    saveSettings({ projectOverrides: overrides });
  };

  return (
    <div className="space-y-3">
      <h3 className="text-md font-semibold text-ctp-text">Sound Pack Override</h3>
      <p className="text-xs text-ctp-subtext0">Override sounds for this project. Each slot can use a different pack.</p>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={clearOverrides}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer
            ${!hasOverrides ? 'bg-indigo-500 text-white' : 'bg-surface-2 text-ctp-text hover:bg-surface-1'}`}
        >
          Use Global Default
        </button>
        {packs.map((pack) => (
          <button
            key={pack.id}
            type="button"
            onClick={() => applyAllForProject(pack.id)}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-2 text-ctp-text hover:bg-surface-1 transition-colors cursor-pointer"
          >
            Apply All: {pack.name}
          </button>
        ))}
      </div>

      {hasOverrides && (
        <div className="space-y-1 mt-3">
          {ALL_SOUND_EVENTS.map((event) => {
            const slotPackId = projectSlots?.[event]?.packId ?? null;
            return (
              <div key={event} className="flex items-center justify-between py-1">
                <span className="text-xs text-ctp-text">{SOUND_EVENT_LABELS[event]}</span>
                <SlotDropdown
                  event={event}
                  packs={packs}
                  selectedPackId={slotPackId}
                  onChange={(packId) => {
                    const overrides = { ...settings.projectOverrides };
                    const slots = { ...(overrides[projectId]?.slotAssignments ?? {}) };
                    if (packId) {
                      slots[event] = { packId };
                    } else {
                      delete slots[event];
                    }
                    overrides[projectId] = { slotAssignments: slots };
                    saveSettings({ projectOverrides: overrides });
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main View ─────────────────────────────────────────────────────────

export function SoundSettingsView({ projectId }: { projectId?: string }) {
  const { settings, loadSettings, packs, loadPacks, saveSettings, importPack, deletePack, applyAllFromPack } = useSoundStore();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
    loadPacks();
  }, [loadSettings, loadPacks]);

  if (!settings) {
    return <div className="p-6 text-ctp-subtext0 text-sm">Loading...</div>;
  }

  // Project context: show per-slot override UI
  if (projectId) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold text-ctp-text mb-4">Sounds</h2>
          <ProjectOverrideSection projectId={projectId} packs={packs} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-4">Sounds</h2>

        {/* Per-slot sound selection */}
        <div className="space-y-3 mb-6">
          <h3 className="text-md font-semibold text-ctp-text">Event Sounds</h3>
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
          <h3 className="text-md font-semibold text-ctp-text">Sound Packs</h3>
          <p className="text-xs text-ctp-subtext0">
            Sound packs provide sounds for each slot. Use "Apply All" to set every slot from one pack, or mix and match above.
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
      </div>
    </div>
  );
}
