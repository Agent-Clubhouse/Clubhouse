import { useSoundStore } from '../../stores/soundStore';
import {
  SoundEvent,
  ALL_SOUND_EVENTS,
  SOUND_EVENT_LABELS,
  SoundPackInfo,
  SlotAssignment,
} from '../../../shared/types';
import { Toggle } from '../../components/Toggle';
import { SettingsField, SettingsSection, settingsButton, settingsInput, settingsHelp } from './SettingsLayout';

// ── Volume Slider ─────────────────────────────────────────────────────

export function VolumeSlider({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <div className={`flex items-center gap-2 ${disabled ? 'opacity-40' : ''}`}>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className="w-24 h-1 accent-ctp-accent cursor-pointer"
      />
      <span className="text-xs text-ctp-overlay1 w-8 text-right tabular-nums">{value}%</span>
    </div>
  );
}

// ── Slot Dropdown ─────────────────────────────────────────────────────

function buildSlotOptions(event: SoundEvent, packs: SoundPackInfo[]): { packId: string; label: string }[] {
  const options: { packId: string; label: string }[] = [];
  for (const pack of packs) {
    if (pack.sounds[event]) {
      options.push({ packId: pack.id, label: pack.name });
    }
  }
  return options;
}

export function SlotDropdown({
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
      className={`${settingsInput} cursor-pointer disabled:cursor-not-allowed min-w-[140px]`}
    >
      <option value="">System default</option>
      {options.map((opt) => (
        <option key={opt.packId} value={opt.packId}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

// ── Sound Event Row ───────────────────────────────────────────────────

export function SoundEventRow({
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
    <SettingsField label={SOUND_EVENT_LABELS[event]}>
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
            className={settingsButton.ghost}
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
          ariaLabel={`${SOUND_EVENT_LABELS[event]} sound`}
        />
    </SettingsField>
  );
}

// ── Sound Pack Card ────────────────────────────────────────────────────

export function SoundPackCard({
  pack,
  onApplyAll,
  onDelete,
}: {
  pack: SoundPackInfo;
  onApplyAll: () => void;
  onDelete?: () => void;
}) {
  const events = Object.keys(pack.sounds) as SoundEvent[];
  const meta = [
    pack.source === 'plugin' ? 'From a plugin' : null,
    pack.author ? `by ${pack.author}` : null,
    `${events.length} ${events.length === 1 ? 'sound' : 'sounds'}`,
  ].filter(Boolean).join(' · ');

  return (
    <SettingsField
      label={<>{pack.name}<span className="ml-2 text-xs text-ctp-overlay1">{meta}</span></>}
      help={pack.description || undefined}
    >
      <button type="button" onClick={onApplyAll} className={settingsButton.ghost}>
        Apply to all
      </button>
      {onDelete && (
        <button type="button" onClick={onDelete} className={settingsButton.danger}>
          Delete
        </button>
      )}
    </SettingsField>
  );
}

// ── Project Sound Override Section ──────────────────────────────────────

export function ProjectSoundOverrideSection({ projectId, packs }: { projectId: string; packs: SoundPackInfo[] }) {
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
    <SettingsSection title="Sound pack override">
      <SettingsField label="Sounds for this project" help="Each slot can use a different pack.">
        <select
          aria-label="Sound pack for this project"
          value=""
          onChange={(e) => {
            if (e.target.value === '__global') clearOverrides();
            else if (e.target.value) applyAllForProject(e.target.value);
          }}
          className={`${settingsInput} cursor-pointer min-w-[160px]`}
        >
          <option value="" disabled>{hasOverrides ? 'Custom' : 'Global default'}</option>
          <option value="__global">Use global default</option>
          {packs.map((pack) => (
            <option key={pack.id} value={pack.id}>Apply all: {pack.name}</option>
          ))}
        </select>
      </SettingsField>

      {hasOverrides && ALL_SOUND_EVENTS.map((event) => {
        const slotPackId = projectSlots?.[event]?.packId ?? null;
        return (
          <SettingsField key={event} label={SOUND_EVENT_LABELS[event]}>
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
          </SettingsField>
        );
      })}
      {!hasOverrides && <p className={`${settingsHelp} pt-1`}>This project uses the global sounds.</p>}
    </SettingsSection>
  );
}
