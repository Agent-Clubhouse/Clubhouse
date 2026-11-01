/**
 * The orchestration policy controls (#2232), shared by the Orchestration card
 * and the agent's Helpers settings page so both write the same fields the
 * same way. Each control saves on change; the helper count saves on blur or
 * Enter and never goes above the app-wide cap.
 */

import { useEffect, useState } from 'react';
import {
  ACCESS_LEVELS,
  ORCHESTRATION_CONTROLS,
  type HelperAccessResolution,
  type OrchestrationAccess,
  type OrchestrationControl,
} from '../../../../shared/orchestration-policy';
import { Toggle } from '../../../components/Toggle';
import { ACCESS_LEVEL_LABELS, CONTROL_LABELS, aboveCeiling, accessLabel } from './helper-model';
import { parseHelperCount } from './orchestration-hooks';

/** The help line under the "Connect to Dispatcher" switch (#2534). */
export const DISPATCHER_HELP = 'Let the Dispatcher message this agent and get its reports.';

/** The help line under the "Cross-project helpers" switch (#2512). */
export const CROSS_PROJECT_HELP = 'Let this agent start helpers in other projects.';

/** The note under the access control: the live ceiling, or the rule when it isn't running. */
export function accessNote(access: HelperAccessResolution | null, running: boolean, name: string): string {
  if (!running || !access) return `Never more than ${name}’s level when a helper starts.`;
  const ceiling = ACCESS_LEVEL_LABELS[access.ceiling];
  if (access.clamped) return `${name} runs at ${ceiling} now, so helpers get ${ACCESS_LEVEL_LABELS[access.level]}.`;
  return `At most ${ceiling}, ${name}’s level now.`;
}

export function AccessSelect({ id, value, access, running, name, disabled, className, onChange, testId }: {
  id: string;
  value: OrchestrationAccess;
  access: HelperAccessResolution | null;
  running: boolean;
  name: string;
  disabled?: boolean;
  className: string;
  onChange: (value: OrchestrationAccess) => void;
  testId?: string;
}) {
  // While it runs the ceiling is known: levels above it can't be picked. A
  // saved value above it still shows, and the note says what helpers get.
  const ceiling = running && access ? access.ceiling : null;
  return (
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as OrchestrationAccess)} className={className} data-testid={testId}>
      <option value="same">{accessLabel('same', name)}</option>
      {ACCESS_LEVELS.map((level) => (
        <option key={level} value={level} disabled={!!ceiling && aboveCeiling(level, ceiling) && level !== value}>
          {ACCESS_LEVEL_LABELS[level]}
        </option>
      ))}
    </select>
  );
}

export function ControlSelect({ id, value, disabled, className, onChange, testId }: {
  id: string;
  value: OrchestrationControl;
  disabled?: boolean;
  className: string;
  onChange: (value: OrchestrationControl) => void;
  testId?: string;
}) {
  return (
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as OrchestrationControl)} className={className} data-testid={testId}>
      {ORCHESTRATION_CONTROLS.map((c) => <option key={c} value={c}>{CONTROL_LABELS[c]}</option>)}
    </select>
  );
}

/**
 * Helpers at once: a whole number from 1 to `ceiling` (the app-wide cap).
 * Saves on blur or Enter; Escape puts the saved value back.
 */
export function HelperCountInput({ id, value, ceiling, disabled, className, onCommit, onError, testId }: {
  id: string;
  value: number;
  ceiling: number;
  disabled?: boolean;
  className: string;
  onCommit: (value: number) => void | Promise<unknown>;
  /** The validation message, or null once the entry is valid again. */
  onError: (message: string | null) => void;
  testId?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = () => {
    const parsed = parseHelperCount(draft, ceiling);
    if ('error' in parsed) { onError(parsed.error); return; }
    onError(null);
    if (parsed.value !== value) void onCommit(parsed.value);
  };

  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      min={1}
      max={ceiling}
      step={1}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape' && draft !== String(value)) { e.preventDefault(); setDraft(String(value)); onError(null); }
      }}
      className={className}
      data-testid={testId}
    />
  );
}

/** "Cross-project helpers" (#2512): may this agent start helpers in other registered projects. */
export function CrossProjectToggle({ id, checked, name, disabled, onChange, testId }: {
  id?: string;
  checked: boolean;
  name: string;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  testId?: string;
}) {
  return (
    <Toggle
      id={id}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label={`Let ${name} start helpers in other projects`}
      data-testid={testId}
    />
  );
}

/** "Connect to Dispatcher" (#2534): may the Dispatcher message this agent and get its reports. */
export function DispatcherToggle({ id, checked, name, disabled, onChange, testId }: {
  id?: string;
  checked: boolean;
  name: string;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  testId?: string;
}) {
  return (
    <Toggle
      id={id}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label={`Connect ${name} to the Dispatcher`}
      data-testid={testId}
    />
  );
}
