/**
 * Auto-sleep in the Settings card (#2143, #2280): this agent's own idle
 * timeout, or the app's. Saved to the agent's config; a running chat session
 * re-arms its idle timer at once, counting from the change. It's the one
 * setting a running agent can change here.
 */

import { useEffect, useId, useState } from 'react';
import {
  AGENT_IDLE_SLEEP_MINUTES, formatIdleMinutes, normalizeIdleSleep, resolveIdleSleep, type AgentIdleSleep,
} from '../../../../shared/idle-sleep';
import { useChatIdleSettingsStore } from '../../../stores/chatIdleSettingsStore';
import { CardRow } from './DetailsCard';

export const SELECT_CLASS = 'h-6 max-w-full px-1.5 rounded-md border border-surface-1 bg-ctp-crust text-xs text-ctp-text focus-ring disabled:opacity-50';

function valueOf(idle: AgentIdleSleep): string {
  return typeof idle === 'number' ? String(idle) : idle;
}

function idleFrom(value: string): AgentIdleSleep {
  return value === 'inherit' || value === 'never' ? value : normalizeIdleSleep(Number(value));
}

/** The line under the select: where the value comes from. */
export function autoSleepSource(idle: AgentIdleSleep, appMinutes: number): string {
  const app = formatIdleMinutes(resolveIdleSleep('inherit', appMinutes).minutes);
  return idle === 'inherit' ? `App default: ${app}` : `Set for this agent. App default: ${app}`;
}

/** For the Settings card summary: "Sleeps after 30 min" or "Never sleeps". */
export function autoSleepSummary(idle: AgentIdleSleep, appMinutes: number): string {
  const { minutes } = resolveIdleSleep(idle, appMinutes);
  return minutes > 0 ? `Sleeps after ${formatIdleMinutes(minutes)}` : 'Never sleeps';
}

/** The app's idle timeout, loaded once. */
export function useAppIdleMinutes(): number {
  const appMinutes = useChatIdleSettingsStore((s) => s.idleTimeoutMinutes as number);
  const loadApp = useChatIdleSettingsStore((s) => s.loadSettings);
  useEffect(() => { void loadApp(); }, [loadApp]);
  return appMinutes;
}

export function AutoSleepRow({ idle, onChange }: {
  /** The saved value; null while the config loads. */
  idle: AgentIdleSleep | null;
  /** Saves the value; throws when it couldn't, after the value has gone back. */
  onChange: (next: AgentIdleSleep) => Promise<void>;
}) {
  const appMinutes = useAppIdleMinutes();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const id = useId();

  const change = async (next: AgentIdleSleep) => {
    setSaving(true);
    setError(false);
    try {
      await onChange(next);
    } catch {
      // telemetry-exempt: the row says it couldn't save and goes back to the saved value.
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const shown = idle ?? 'inherit';
  const app = formatIdleMinutes(resolveIdleSleep('inherit', appMinutes).minutes);
  // A hand-edited value outside the list still shows as itself.
  const minutes: number[] = [...AGENT_IDLE_SLEEP_MINUTES];
  if (typeof shown === 'number' && !minutes.includes(shown)) minutes.push(shown);
  minutes.sort((a, b) => a - b);

  return (
    <CardRow label="Auto-sleep" labelWidth="wide" testId="details-setting-auto-sleep">
      <span className="flex flex-col items-start gap-1">
        <label htmlFor={id} className="sr-only">Auto-sleep after idle</label>
        <select
          id={id}
          value={valueOf(shown)}
          disabled={idle === null || saving}
          onChange={(e) => void change(idleFrom(e.target.value))}
          className={SELECT_CLASS}
          data-testid="details-auto-sleep"
        >
          <option value="inherit">App default ({app})</option>
          {minutes.map((m) => <option key={m} value={String(m)}>After {formatIdleMinutes(m)} idle</option>)}
          <option value="never">Never</option>
        </select>
        <span className="text-ctp-overlay1" data-testid="details-auto-sleep-source">
          {error ? 'Couldn’t save. Try again.' : autoSleepSource(shown, appMinutes)}
        </span>
      </span>
    </CardRow>
  );
}
