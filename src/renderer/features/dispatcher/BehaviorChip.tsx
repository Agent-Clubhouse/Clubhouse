/**
 * The Behavior chip (#3045): in the Dispatcher's composer it takes the place
 * of the model, effort and permission pickers. One choice, Light, Standard or
 * Thorough, covers which models it uses and how often it checks in. The words
 * come from shared/dispatcher-behavior.ts and never give an exact frequency.
 *
 * The chip shows main's state, as Settings > Dispatcher does, so the two stay
 * in step: a pick here saves through main and comes back on the next state.
 */

import { useEffect, useState } from 'react';
import {
  DISPATCHER_BEHAVIORS,
  DISPATCHER_BEHAVIOR_LABELS,
  behaviorAutoNote,
  canSetUpAuto,
  type DispatcherBehavior,
  type DispatcherBehaviorState,
} from '../../../shared/dispatcher-behavior';
import { ChevronDown, GaugeIcon } from '../agents/chat/icons';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { useDispatcherBehavior } from './dispatcherStore';
import { openAutoSettings } from './dispatcherNav';

export interface BehaviorChipProps {
  behavior: DispatcherBehaviorState;
  /** The provider's display name, for the line shown when Auto can't give the models. */
  providerName: string;
  /** Saves a level. A rejection is shown in the menu. */
  onChange: (level: DispatcherBehavior) => Promise<unknown> | void;
  onSetUpAuto: () => void;
  disabled?: boolean;
  /** Narrow composer: the icon only, with the level in the tooltip. */
  compact?: boolean;
}

export function BehaviorChip({ behavior, providerName, onChange, onSetUpAuto, disabled, compact }: BehaviorChipProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = behavior.level;
  const label = DISPATCHER_BEHAVIOR_LABELS[current].label;
  const note = behaviorAutoNote(behavior.auto, providerName);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const pick = async (level: DispatcherBehavior) => {
    if (level === current) {
      setOpen(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onChange(level);
      setOpen(false);
    } catch (err) {
      // telemetry-exempt: shown in the menu, which keeps the saved level.
      setError(`Couldn’t change it. ${ipcErrorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => { setError(null); setOpen((o) => !o); }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Behavior: ${label}`}
        aria-label={`Behavior: ${label}`}
        className={`h-[26px] flex items-center gap-1.5 rounded-md bg-surface-0 text-ctp-subtext1 text-[12px] whitespace-nowrap disabled:opacity-60 ${compact ? 'px-2' : 'px-2.5'}`}
        data-testid="dispatcher-behavior-chip"
        data-level={current}
      >
        <GaugeIcon size={13} className="text-ctp-overlay1" />
        {!compact && label}
        <ChevronDown className="text-ctp-overlay1" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Behavior"
          className="absolute left-0 bottom-9 w-[300px] bg-ctp-crust border border-surface-1 rounded-lg shadow-xl p-1.5 z-dropdown flex flex-col gap-px"
          onMouseDown={(e) => e.stopPropagation()}
          data-testid="dispatcher-behavior-menu"
        >
          <div className="px-2 py-1.5 text-[11.5px] font-semibold text-ctp-overlay1">Behavior</div>
          {DISPATCHER_BEHAVIORS.map((level) => (
            <button
              key={level}
              type="button"
              role="menuitemradio"
              aria-checked={level === current}
              disabled={saving}
              onClick={() => void pick(level)}
              className={`flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left text-[12.5px] text-ctp-text disabled:opacity-60 ${level === current ? 'bg-surface-0' : 'hover:bg-surface-0/60'}`}
              data-testid={`dispatcher-behavior-${level}`}
            >
              <span className={`w-3 h-3 rounded-full flex-shrink-0 ${level === current ? 'border-[3.5px] border-ctp-accent' : 'border-[1.5px] border-surface-2'}`} />
              <span className="flex flex-col">
                <span>{DISPATCHER_BEHAVIOR_LABELS[level].label}</span>
                <span className="text-[11px] text-ctp-overlay1">{DISPATCHER_BEHAVIOR_LABELS[level].description}</span>
              </span>
            </button>
          ))}
          {note && (
            <div className="mt-1 pt-1.5 px-2 pb-1 border-t border-surface-0 flex flex-col gap-1.5" data-testid="dispatcher-behavior-auto">
              <p className="text-[11.5px] text-ctp-subtext0">{note}</p>
              {canSetUpAuto(behavior.auto) && (
                <button
                  type="button"
                  onClick={() => { setOpen(false); onSetUpAuto(); }}
                  className="self-start h-6 px-2 rounded-md bg-surface-0 text-[12px] text-ctp-text hover:bg-surface-1"
                  data-testid="dispatcher-behavior-setup-auto"
                >
                  Set up Auto
                </button>
              )}
            </div>
          )}
          {error && <p className="px-2 py-1 text-[11.5px] text-ctp-error" role="alert" data-testid="dispatcher-behavior-error">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** A provider's display name, or its id until the list loads. */
export function useProviderName(provider: string | null): string {
  return useOrchestratorStore((s) => s.allOrchestrators.find((o) => o.id === provider)?.displayName) ?? provider ?? 'this provider';
}

/** The chip for the Dispatcher's composer, on main's state. Nothing until that state lands. */
export function DispatcherBehaviorChip({ disabled, compact }: { disabled?: boolean; compact?: boolean }) {
  const behavior = useDispatcherBehavior();
  const providerName = useProviderName(behavior?.provider ?? null);
  if (!behavior) return null;
  return (
    <BehaviorChip
      behavior={behavior}
      providerName={providerName}
      onChange={(level) => window.clubhouse.dispatcher.setBehavior(level)}
      onSetUpAuto={openAutoSettings}
      disabled={disabled}
      compact={compact}
    />
  );
}
