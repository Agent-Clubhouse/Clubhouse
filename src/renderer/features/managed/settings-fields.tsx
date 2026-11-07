/**
 * Settings controls the builder's Settings tab, the template editor and a
 * managed agent's Settings page share (#2895, #2898): effort, helper
 * selection, the helper template and auto-sleep. Each surface lays them out
 * in its own rows and saves them its own way. Each edits an ordinary agent
 * setting, stored where it always is.
 */
import { useEffect, useState } from 'react';
import { AGENT_IDLE_SLEEP_MINUTES, formatIdleMinutes, normalizeIdleSleep, resolveIdleSleep, type AgentIdleSleep } from '../../../shared/idle-sleep';
import { effortWord } from '../agents/chat/Composer';
import { useAppIdleMinutes } from '../agents/details/AutoSleepRow';
import { managed, unwrap, useManagedTemplates } from './managedApi';

/**
 * The effort levels each model of a CLI takes, read from its model list.
 * `levelsFor('default')` is the CLI's default model's. Nothing while loading,
 * or when the list can't be read.
 */
export function useModelEfforts(cli: string | undefined, projectPath?: string): { levelsFor: (model: string) => string[]; loading: boolean } {
  const key = cli ? `${cli}\n${projectPath ?? ''}` : null;
  const [loaded, setLoaded] = useState<{ key: string; levels: Record<string, string[]> } | null>(null);
  useEffect(() => {
    if (!cli || !key) return;
    let cancelled = false;
    void unwrap(managed().modelEfforts(cli, projectPath))
      .then((levels) => { if (!cancelled) setLoaded({ key, levels }); })
      // telemetry-exempt: the Effort row offers only the CLI default.
      .catch(() => { if (!cancelled) setLoaded({ key, levels: {} }); });
    return () => { cancelled = true; };
  }, [cli, projectPath, key]);
  const current = loaded && loaded.key === key ? loaded.levels : null;
  return {
    levelsFor: (model: string) => {
      const id = model && model !== 'default' ? model : 'default';
      return current?.[id] ?? current?.[id.replace(/\[1m\]$/i, '')] ?? [];
    },
    loading: !!key && !current,
  };
}

/** The Effort row's note: what the list offers for this model. */
export function effortHelp(levels: string[], loading: boolean): string {
  if (loading) return 'Reading the levels this model takes.';
  if (levels.length === 0) return 'This model has no effort levels to choose, so the CLI decides.';
  return 'How hard the model thinks. A new model or CLI goes back to the CLI default.';
}

export function EffortSelect({ id, value, levels, disabled, className, onChange, testId }: {
  id?: string;
  /** Empty: the CLI's default. */
  value: string;
  levels: string[];
  disabled?: boolean;
  className: string;
  onChange: (effort: string) => void;
  testId?: string;
}) {
  // A saved level the list doesn't have still shows as itself.
  const shown = value && !levels.includes(value) ? [...levels, value] : levels;
  return (
    <select id={id} aria-label="Effort" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={className} data-testid={testId}>
      <option value="">CLI default</option>
      {shown.map((level) => <option key={level} value={level}>{effortWord(level)}</option>)}
    </select>
  );
}

/** "Helper selection": Smart is Auto (#2671). Unset follows the app setting. */
export function HelperSelectionSelect({ id, value, disabled, className, onChange, testId }: {
  id?: string;
  value: boolean | undefined;
  disabled?: boolean;
  className: string;
  onChange: (autoHelpers: boolean | undefined) => void;
  testId?: string;
}) {
  const current = value === undefined ? 'app' : value ? 'smart' : 'fixed';
  return (
    <select
      id={id}
      aria-label="Helper selection"
      value={current}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === 'app' ? undefined : e.target.value === 'smart')}
      className={className}
      data-testid={testId}
    >
      <option value="app">App setting</option>
      <option value="smart">Smart</option>
      <option value="fixed">Fixed</option>
    </select>
  );
}

export const HELPER_SELECTION_HELP = 'Smart lets Clubhouse pick between Claude Code and Codex for each helper, from helper counts and plan limits. Fixed keeps the CLI the agent names.';

/** The app's default helper template id, or null until read. */
export function useDefaultHelperTemplate(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void unwrap(managed().getDefaultHelperTemplate())
        .then((v) => { if (!cancelled) setId(v); })
        .catch(() => { /* telemetry-exempt: the row says "App default" without the name */ });
    };
    load();
    const off = managed().onChanged(load);
    return () => { cancelled = true; off(); };
  }, []);
  return id;
}

/** "Helper template": which template its helpers start from when start_helper names none. Empty is the app's default. */
export function HelperTemplateSelect({ id, value, disabled, className, onChange, testId }: {
  id?: string;
  value: string;
  disabled?: boolean;
  className: string;
  onChange: (templateId: string) => void;
  testId?: string;
}) {
  const templates = useManagedTemplates();
  const defaultId = useDefaultHelperTemplate();
  const all = templates.value ?? [];
  const defaultName = all.find((t) => t.id === defaultId)?.name;
  // A template that was deleted reads as the app's default, as start_helper treats it.
  const current = value && (templates.value === null || all.some((t) => t.id === value)) ? value : '';
  return (
    <select id={id} aria-label="Helper template" value={current} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={className} data-testid={testId}>
      <option value="">{defaultName ? `App default (${defaultName})` : 'App default'}</option>
      {value && templates.value === null && <option value={value}>{value}</option>}
      {all.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  );
}

export const HELPER_TEMPLATE_HELP = 'What its helpers start from when it names no template. App default follows Settings › Managed agents › Helpers.';

/** "Auto-sleep": this agent's idle timeout, or the app's. Only chat sessions sleep. */
export function IdleSleepSelect({ id, value, disabled, className, onChange, testId }: {
  id?: string;
  value: AgentIdleSleep;
  disabled?: boolean;
  className: string;
  onChange: (idle: AgentIdleSleep) => void;
  testId?: string;
}) {
  const appMinutes = useAppIdleMinutes();
  const app = formatIdleMinutes(resolveIdleSleep('inherit', appMinutes).minutes);
  // A hand-edited value outside the list still shows as itself.
  const minutes: number[] = [...AGENT_IDLE_SLEEP_MINUTES];
  if (typeof value === 'number' && !minutes.includes(value)) minutes.push(value);
  minutes.sort((a, b) => a - b);
  return (
    <select
      id={id}
      aria-label="Auto-sleep"
      value={typeof value === 'number' ? String(value) : value}
      disabled={disabled}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === 'inherit' || v === 'never' ? v : normalizeIdleSleep(Number(v)));
      }}
      className={className}
      data-testid={testId}
    >
      <option value="inherit">App default ({app})</option>
      {minutes.map((m) => <option key={m} value={String(m)}>After {formatIdleMinutes(m)} idle</option>)}
      <option value="never">Never</option>
    </select>
  );
}

export const IDLE_SLEEP_HELP = 'How long it waits idle before it sleeps. Only chat sessions sleep on their own.';
