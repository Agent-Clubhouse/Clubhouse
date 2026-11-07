/**
 * The rows a managed agent's Settings page adds to the Runtime and Helpers
 * controls it shares with other agents (#2895): effort, auto-sleep and the
 * helper template. Each saves on change to the agent's own setting, through
 * the same call templates and the builder use. A running agent picks the
 * change up at its next start, and the setup-changed bar offers Restart.
 */
import { useEffect, useId, useState } from 'react';
import type { DurableAgentConfig } from '../../../shared/types';
import { normalizeIdleSleep } from '../../../shared/idle-sleep';
import type { ManagedTemplateSettings } from '../../../shared/managed-agents-types';
import { Field, selectClass } from '../agents/agentSettingsUi';
import { errorText, managed, unwrap } from './managedApi';
import {
  EffortSelect, HELPER_TEMPLATE_HELP, HelperTemplateSelect, IDLE_SLEEP_HELP, IdleSleepSelect, effortHelp, useModelEfforts,
} from './settings-fields';

/**
 * The agent's saved config, read again after each save here and whenever a
 * managed setting or setup changes (a new model clears the effort).
 */
function useLiveSetting(projectPath: string, agentId: string) {
  const [config, setConfig] = useState<DurableAgentConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      window.clubhouse.agent.getDurableConfig(projectPath, agentId)
        .then((c) => { if (!cancelled) setConfig(c ?? null); })
        .catch(() => { /* telemetry-exempt: the rows stay disabled until a read works */ });
    };
    load();
    const off = managed().onChanged(load);
    return () => { cancelled = true; off(); };
  }, [projectPath, agentId, nonce]);
  const save = async (settings: ManagedTemplateSettings) => {
    setSaving(true);
    setError(null);
    try {
      await unwrap(managed().applySettings(projectPath, agentId, settings));
    } catch (err) {
      // telemetry-exempt: shown under the row, which goes back to the saved value.
      setError(errorText(err));
    } finally {
      setSaving(false);
      setNonce((n) => n + 1);
    }
  };
  return { config, saving, error, save };
}

/** Effort, for the model and CLI it runs. Changing either clears it, as main does. */
export function ManagedEffortField({ projectPath, agentId, orchestrator, model, disabled }: {
  projectPath: string;
  agentId: string;
  orchestrator: string;
  model: string;
  disabled?: boolean;
}) {
  const { config, saving, error, save } = useLiveSetting(projectPath, agentId);
  const { levelsFor, loading } = useModelEfforts(orchestrator, projectPath);
  const levels = levelsFor(model);
  const value = config?.effort ?? '';
  const id = useId();
  return (
    <Field
      label="Effort"
      htmlFor={id}
      help={error ? <span className="text-ctp-error">{error}</span> : effortHelp(levels, loading)}
      testId="agent-settings-effort"
    >
      <EffortSelect
        id={id}
        value={value}
        levels={levels}
        disabled={disabled || !config || saving || loading || (levels.length === 0 && !value)}
        className={selectClass}
        onChange={(next) => void save({ effort: next || null })}
      />
    </Field>
  );
}

/** Auto-sleep: its own idle timeout, or the app's. */
export function ManagedIdleSleepField({ projectPath, agentId }: { projectPath: string; agentId: string }) {
  const { config, saving, error, save } = useLiveSetting(projectPath, agentId);
  const id = useId();
  return (
    <Field label="Auto-sleep" htmlFor={id} help={error ? <span className="text-ctp-error">{error}</span> : IDLE_SLEEP_HELP} testId="agent-settings-idle-sleep">
      <IdleSleepSelect
        id={id}
        value={normalizeIdleSleep(config?.idleSleep)}
        disabled={!config || saving}
        className={selectClass}
        onChange={(next) => void save({ idleSleep: next === 'inherit' ? null : next })}
      />
    </Field>
  );
}

/** The template its helpers start from when start_helper names none. */
export function ManagedHelperTemplateField({ projectPath, agentId, disabled }: { projectPath: string; agentId: string; disabled?: boolean }) {
  const { config, saving, error, save } = useLiveSetting(projectPath, agentId);
  const id = useId();
  return (
    <Field label="Helper template" htmlFor={id} help={error ? <span className="text-ctp-error">{error}</span> : HELPER_TEMPLATE_HELP} testId="agent-settings-helper-template">
      <HelperTemplateSelect
        id={id}
        value={config?.helperTemplateId ?? ''}
        disabled={disabled || !config || saving}
        className={selectClass}
        onChange={(next) => void save({ helperTemplateId: next || null })}
      />
    </Field>
  );
}
