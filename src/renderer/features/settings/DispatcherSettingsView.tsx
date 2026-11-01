/**
 * App settings, Dispatcher (#2535): the switch that turns the app-wide
 * Dispatcher on, and its agent settings once it exists. Shown only while the
 * experimental flag is on. Its persona, orchestration settings and folder
 * can't change here or anywhere else.
 */

import { useEffect, useState } from 'react';
import type { DurableConfigUpdates } from '../../../shared/types';
import { AGENT_IDLE_SLEEP_MINUTES, formatIdleMinutes, normalizeIdleSleep } from '../../../shared/idle-sleep';
import { Toggle } from '../../components/Toggle';
import { useModelOptions } from '../../hooks/useModelOptions';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useAppIdleMinutes, SELECT_CLASS } from '../agents/details/AutoSleepRow';
import { useDispatcherState } from '../dispatcher/useDispatcherEnabled';
import { SettingsField, SettingsPage, SettingsSection, settingsHelp } from './SettingsLayout';

export function DispatcherSettingsView() {
  const state = useDispatcherState();
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const enabledIds = useOrchestratorStore((s) => s.enabled);
  const loadOrchestrators = useOrchestratorStore((s) => s.loadSettings);
  useEffect(() => { void loadOrchestrators(); }, [loadOrchestrators]);
  const appMinutes = useAppIdleMinutes();

  const config = state?.config ?? null;
  const path = state?.path ?? undefined;
  const orchestrator = config?.orchestrator ?? '';
  const { options: modelOptions, loading: modelsLoading } = useModelOptions(orchestrator || undefined, path ?? '');

  const turn = async (on: boolean) => {
    setSwitching(true);
    setSwitchError(null);
    try {
      await window.clubhouse.dispatcher.setEnabled(on);
    } catch (err) {
      // telemetry-exempt: shown under the switch, which keeps the saved value.
      setSwitchError(`Couldn’t turn it ${on ? 'on' : 'off'}. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSwitching(false);
    }
  };

  const save = async (updates: DurableConfigUpdates) => {
    if (!config || !path) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Main broadcasts the new config, which this page then shows.
      await window.clubhouse.agent.updateDurableConfig(path, config.id, updates);
    } catch (err) {
      // telemetry-exempt: shown under the settings, which keep the saved values.
      setSaveError(`Couldn’t save. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  if (!state) return null;

  // The current CLI stays listed even when it has since been turned off for new agents.
  const cliChoices = allOrchestrators.filter((o) => enabledIds.includes(o.id) || o.id === orchestrator);
  const modelValue = config?.model && config.model !== 'default' ? config.model : 'default';
  const modelChoices = modelOptions.some((o) => o.id === modelValue) ? modelOptions : [...modelOptions, { id: modelValue, label: modelValue }];
  const idle = normalizeIdleSleep(config?.idleSleep);
  const idleValue = typeof idle === 'number' ? String(idle) : idle;
  const minutes: number[] = [...AGENT_IDLE_SLEEP_MINUTES];
  if (typeof idle === 'number' && !minutes.includes(idle)) minutes.push(idle);
  minutes.sort((a, b) => a - b);
  const permissionsSupported = allOrchestrators.find((o) => o.id === orchestrator)?.capabilities.permissions ?? true;

  return (
    <SettingsPage
      title="Dispatcher"
      description="One agent for the whole app that coordinates the orchestrators in your projects."
    >
      <SettingsSection title="Dispatcher">
        <SettingsField
          label="Turn on Dispatcher"
          help="Turning it off stops it. Its folder and notes are kept, so turning it back on carries on where it left off."
        >
          <Toggle
            aria-label="Turn on Dispatcher"
            checked={state.enabled}
            disabled={switching}
            onChange={(on) => void turn(on)}
            data-testid="dispatcher-enabled"
          />
        </SettingsField>
        {switchError && <p className={settingsHelp} data-testid="dispatcher-enabled-error">{switchError}</p>}
        {state.path && <p className={`${settingsHelp} mt-2`} data-testid="dispatcher-folder">Its folder is {state.path}</p>}
      </SettingsSection>

      {state.enabled && config && (
        <SettingsSection title="Agent">
          <p className={settingsHelp}>Changes apply the next time the Dispatcher starts. Auto-sleep applies at once.</p>
          <SettingsField label="CLI" htmlFor="dispatcher-cli" help="Changing it writes the Dispatcher’s instructions for the new CLI.">
            <select
              id="dispatcher-cli"
              className={SELECT_CLASS}
              value={orchestrator}
              disabled={saving}
              onChange={(e) => void save({ orchestrator: e.target.value, model: 'default' })}
            >
              {!orchestrator && <option value="">App default</option>}
              {cliChoices.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
            </select>
          </SettingsField>
          <SettingsField label="Model" htmlFor="dispatcher-model" help="Effort is set from the chat composer, as for other agents.">
            <select
              id="dispatcher-model"
              className={SELECT_CLASS}
              value={modelValue}
              disabled={saving || modelsLoading}
              onChange={(e) => {
                const v = e.target.value;
                // Only a model the CLI listed: a select still loading reads back as the placeholder.
                if (modelsLoading || !modelOptions.some((o) => o.id === v)) return;
                void save({ model: v });
              }}
            >
              {modelChoices.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </SettingsField>
          <SettingsField label="Runs in" htmlFor="dispatcher-runtime">
            <select
              id="dispatcher-runtime"
              className={SELECT_CLASS}
              value={config.runtimeMode ?? ''}
              disabled={saving}
              onChange={(e) => void save({ runtimeMode: e.target.value === '' ? null : e.target.value as 'chat' | 'terminal' })}
            >
              <option value="">Provider default</option>
              <option value="chat">Chat</option>
              <option value="terminal">Terminal</option>
            </select>
          </SettingsField>
          <SettingsField label="Auto-sleep" htmlFor="dispatcher-auto-sleep" help="Only applies in chat.">
            <select
              id="dispatcher-auto-sleep"
              className={SELECT_CLASS}
              value={idleValue}
              disabled={saving}
              onChange={(e) => {
                const v = e.target.value;
                void save({ idleSleep: v === 'inherit' ? null : v === 'never' ? 'never' : normalizeIdleSleep(Number(v)) });
              }}
            >
              <option value="never">Never</option>
              <option value="inherit">App default ({formatIdleMinutes(appMinutes)})</option>
              {minutes.map((m) => <option key={m} value={String(m)}>After {formatIdleMinutes(m)}</option>)}
            </select>
          </SettingsField>
          {permissionsSupported && (
            <SettingsField label="Free agent mode" help="Runs without asking for permission. Turn it off to approve its tool calls.">
              <Toggle
                aria-label="Free agent mode"
                checked={!!config.freeAgentMode}
                disabled={saving}
                onChange={(on) => void save({ freeAgentMode: on })}
              />
            </SettingsField>
          )}
          {saveError && <p className={settingsHelp} data-testid="dispatcher-save-error">{saveError}</p>}
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
