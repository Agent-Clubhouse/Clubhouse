/**
 * Settings › Dispatcher › Lead (#3351): choose one computer's Dispatcher to
 * talk to, for every computer in this Annex Network. Shown only when this
 * computer is in a network with another computer. A person's choice only.
 */

import { useEffect, useState } from 'react';
import type { DispatcherLeadState, LeadChoice } from '../../../shared/dispatcher-lead';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { SELECT_CLASS } from '../agents/details/AutoSleepRow';
import { SettingsField, SettingsSection, settingsError, settingsHelp } from './SettingsLayout';

const NONE = '';

function useLeadState(): DispatcherLeadState | null {
  const [state, setState] = useState<DispatcherLeadState | null>(null);
  useEffect(() => {
    let live = true;
    const off = window.clubhouse.dispatcher.onLeadChanged((next) => { if (live) setState(next); });
    window.clubhouse.dispatcher.getLead().then((next) => { if (live) setState(next); }, () => { /* telemetry-exempt: the section stays hidden */ });
    return () => { live = false; off(); };
  }, []);
  return state;
}

/** "Desk", "Desk and Laptop", "Desk, Laptop and Studio". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function choiceLabel(choice: LeadChoice): string {
  if (choice.self) return `${choice.name} (this computer)`;
  return choice.online ? choice.name : `${choice.name} (offline)`;
}

/** The line under the picker: where this computer stands. */
export function leadStatus(state: DispatcherLeadState): string {
  if (state.role === 'lead') return 'This computer’s Dispatcher leads. The others follow it.';
  if (state.role === 'follower' && state.lead) return `This computer follows ${state.lead.name}’s Dispatcher.`;
  if (state.clearedFor) return `${state.clearedFor} left the network, so there’s no lead now. Each computer uses its own Dispatcher.`;
  return 'Each computer uses its own Dispatcher.';
}

/** Which members have the same choice, and which haven't heard it yet. */
export function leadConfirmation(state: DispatcherLeadState): string | null {
  if (!state.changedAt) return null;
  if (state.waitingOn.length === 0) return 'Every computer has this choice.';
  if (state.confirmedBy.length === 0) return `Waiting for ${listNames(state.waitingOn)} to get this choice.`;
  return `${listNames(state.confirmedBy)} ${state.confirmedBy.length === 1 ? 'has' : 'have'} this choice. Waiting for ${listNames(state.waitingOn)}.`;
}

export function LeadSection() {
  const state = useLeadState();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!state?.available) return null;

  const choose = async (machine: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await window.clubhouse.dispatcher.setLead(machine);
    } catch (err) {
      // telemetry-exempt: shown under the picker, which keeps the saved choice.
      setError(`Couldn’t change the lead. ${ipcErrorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };
  const confirmation = leadConfirmation(state);

  return (
    <SettingsSection title="Lead">
      <SettingsField
        label="Lead"
        htmlFor="dispatcher-lead"
        help="Talk to one computer’s Dispatcher from every computer in your Annex Network. The others keep doing work on their own computer."
      >
        <select
          id="dispatcher-lead"
          className={SELECT_CLASS}
          value={state.lead?.machine ?? NONE}
          disabled={saving}
          onChange={(e) => void choose(e.target.value === NONE ? null : e.target.value)}
          data-testid="dispatcher-lead"
        >
          <option value={NONE}>None</option>
          {state.choices.map((c) => <option key={c.machine} value={c.machine}>{choiceLabel(c)}</option>)}
        </select>
      </SettingsField>
      <p className={`${settingsHelp} mt-1.5`} role="status" data-testid="dispatcher-lead-status">{leadStatus(state)}</p>
      {confirmation && <p className={`${settingsHelp} mt-1`} data-testid="dispatcher-lead-confirmation">{confirmation}</p>}
      {error && <p className={`${settingsError} mt-1.5`} role="alert" data-testid="dispatcher-lead-error">{error}</p>}
    </SettingsSection>
  );
}
