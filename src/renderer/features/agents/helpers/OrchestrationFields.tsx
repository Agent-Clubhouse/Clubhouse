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
  type ResolvedOrchestrationPolicy,
  type OrchestrationAccess,
  type OrchestrationControl,
} from '../../../../shared/orchestration-policy';
import { AUTO_LOCKED_NOTES } from '../../../../shared/helper-policy-display';
import { Toggle } from '../../../components/Toggle';
import { ACCESS_LEVEL_LABELS, CONTROL_LABELS, aboveCeiling, accessLabel } from './helper-model';
import { parseHelperCount } from './orchestration-hooks';
import { autoPickSentence, useAutoPick } from '../../settings/helper-auto-pick';

/**
 * The help line under the "Connect to Dispatcher" default on templates and New
 * agent (#2534). An existing agent connects from its Dispatcher card in
 * Details (#3049).
 */
export const DISPATCHER_HELP = 'Let the Dispatcher message this agent and get its reports.';

/** The help line under the "Cross-project helpers" switch (#2512). */
export const CROSS_PROJECT_HELP = 'Let this agent start helpers in other projects.';

/** The help line under the Smart routing switch, with what it can pick right now (#3896). */
export function AutoHelpersHelp() {
  const pick = useAutoPick();
  return <>{autoPickSentence(pick, 'Let Clubhouse')} This balances plan use, not cost.</>;
}

export { accessNote } from '../../../../shared/helper-policy-display';

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
/** Why Auto is off where this agent's own switch can't change that. */


/**
 * Whether Auto works for this agent, not only its own switch: the app and the
 * project have a say. A project that turned it off can't be overruled
 * here. "Use the app’s setting" clears this agent's own switch.
 */
export function AutoHelpersToggle({ id, policy, name, disabled, onChange, testId }: {
  id?: string;
  policy: ResolvedOrchestrationPolicy;
  name: string;
  disabled?: boolean;
  onChange: (on: boolean | null) => void;
  testId?: string;
}) {
  const effective = policy.autoEffective?.effective ?? false;
  const locked = policy.autoEffective?.reason ? AUTO_LOCKED_NOTES[policy.autoEffective.reason] : undefined;
  const own = policy.sources.autoHelpers === 'agent';
  return (
    <span className="inline-flex items-center gap-2">
      <Toggle
        id={id}
        checked={effective}
        disabled={disabled || !!locked}
        onChange={onChange}
        aria-label={`Let Clubhouse pick the provider for ${name}’s helpers`}
        data-testid={testId}
      />
      {locked && <span className="text-xs text-ctp-overlay1" data-testid={testId && `${testId}-locked`}>{locked}</span>}
      {!locked && (
        <>
          <span className="text-xs text-ctp-overlay1" data-testid={testId && `${testId}-source`}>{own ? 'Set on this agent' : 'Following the app setting'}</span>
          <button
            type="button"
            className="text-xs text-ctp-accent hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={disabled}
            onClick={() => onChange(own ? null : effective)}
            data-testid={testId && `${testId}-${own ? 'clear' : 'override'}`}
          >
            {own ? 'Use the app’s setting' : 'Set on this agent'}
          </button>
        </>
      )}
    </span>
  );
}

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
