/**
 * Auto-sleep in the Session card (#2143): this agent's own idle timeout, or
 * the app's. Saved to the agent's config; a running chat session re-arms its
 * idle timer at once, counting from the change.
 */

import { useEffect, useId, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import {
  AGENT_IDLE_SLEEP_MINUTES, formatIdleMinutes, normalizeIdleSleep, resolveIdleSleep, type AgentIdleSleep,
} from '../../../../shared/idle-sleep';
import { useChatIdleSettingsStore } from '../../../stores/chatIdleSettingsStore';
import { CardRow } from './DetailsCard';

const SELECT_CLASS = 'h-6 max-w-full px-1.5 rounded-md border border-surface-1 bg-ctp-crust text-xs text-ctp-text focus-ring disabled:opacity-50';

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

export function AutoSleepRow({ agent, projectPath }: { agent: Agent; projectPath: string }) {
  const appMinutes = useChatIdleSettingsStore((s) => s.idleTimeoutMinutes as number);
  const loadApp = useChatIdleSettingsStore((s) => s.loadSettings);
  const [idle, setIdle] = useState<AgentIdleSleep | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const id = useId();

  useEffect(() => { void loadApp(); }, [loadApp]);
  useEffect(() => {
    let alive = true;
    setIdle(null);
    Promise.resolve().then(() => window.clubhouse.agent.getDurableConfig(projectPath, agent.id)).then(
      (config) => { if (alive) setIdle(normalizeIdleSleep(config?.idleSleep)); },
      // telemetry-exempt: the row shows the app default and stays editable.
      () => { if (alive) setIdle('inherit'); },
    );
    return () => { alive = false; };
  }, [projectPath, agent.id]);

  const change = async (next: AgentIdleSleep) => {
    const previous = idle;
    setIdle(next);
    setSaving(true);
    setError(false);
    try {
      await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, { idleSleep: next === 'inherit' ? null : next });
    } catch {
      // telemetry-exempt: the row says it couldn't save and goes back to the saved value.
      setIdle(previous);
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
    <CardRow label="Auto-sleep">
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
