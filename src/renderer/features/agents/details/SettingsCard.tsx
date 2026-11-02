/**
 * The Settings card (#2280): the agent's key settings at the top of Agent
 * details, collapsed to one line ("Chat · Opus 5.5 · Full access · Sleeps
 * after 30 min"), with "All settings" for the full page.
 *
 * Each row says when it can change (`editable`), so a row can become
 * live-editable later without touching the others. A running agent's spawn
 * settings are locked until it sleeps; Auto-sleep is a Clubhouse-side timer
 * and changes live. Model, effort and access keep their composer chips while
 * the agent runs; the rows here only reflect them. Asleep (#2281), the spawn
 * settings are native selects and switches, saved for the next wake; an
 * agent on another machine is read-only here. A new CLI (#2593) resets the
 * model and starts a new session; main does both, whichever path changed it,
 * and an agent with a session to lose asks first.
 */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Agent, DurableConfigUpdates } from '../../../../shared/types';
import type { ChatViewState } from '../../../stores/chatStore';
import { useAgentStore } from '../../../stores/agentStore';
import { useClubhouseModeStore } from '../../../stores/clubhouseModeStore';
import { useOrchestratorStore } from '../../../stores/orchestratorStore';
import { isRemoteProjectId, useRemoteProjectStore } from '../../../stores/remoteProjectStore';
import { Button } from '../../../components/Button';
import { Toggle } from '../../../components/Toggle';
import { useEffectiveOrchestrators } from '../../../hooks/useEffectiveOrchestrators';
import { useModelOptions } from '../../../hooks/useModelOptions';
import { useContextWindowOptions } from '../../../hooks/useContextWindowOptions';
import { ContextWindowSelect, contextSummary, contextWindowHelp, formatContextChoice } from '../ContextWindowField';
import { getPersonaTemplate } from '../../personas';
import { useAgentSettingsPages } from '../agentSettingsPages';
import { buildOrchestratorOptions } from '../orchestrator-options';
import { useCliChangeConfirm } from '../useCliChangeConfirm';
import { LEVEL_LABELS } from '../chat/view-model';
import { useChatFlag } from '../chat/chat-flag';
import { normalizeIdleSleep } from '../../../../shared/idle-sleep';
import { AutoSleepRow, autoSleepSummary, SELECT_CLASS, useAppIdleMinutes } from './AutoSleepRow';
import { CardNote, CardRow, DetailsCard } from './DetailsCard';
import { useAgentDetailsStore } from './detailsStore';
import { useDurableConfig } from './useDurableConfig';
import { isDispatcherAgent } from '../../dispatcher/dispatcherStore';
import { openDispatcherSettings } from '../../dispatcher/dispatcherNav';

/**
 * When a row's setting can change: at any time (applied live), only while the
 * agent sleeps (it's read at spawn), or never here (the full page edits it).
 */
export type RowEditable = 'always' | 'sleeping' | 'never';

/** A row is locked when it could change, but not while the agent is awake. */
export function isRowLocked(editable: RowEditable, awake: boolean): boolean {
  return editable === 'sleeping' && awake;
}

export const LOCKED_HINT = 'Sleep the agent to change these';

export interface SettingsValues {
  runsIn: 'Chat' | 'CLI' | null;
  model: string | null;
  access: string | null;
  autoSleep: string | null;
}

/** The one-line answer, from what's known: "Chat · Opus 5.5 · Full access · Sleeps after 30 min". */
export function settingsSummary(v: SettingsValues): string {
  return [v.runsIn, v.model, v.access, v.autoSleep].filter(Boolean).join(' · ');
}

/** The model as people read it: the session's label for it, or the saved id. */
export function modelLabel(model: string | null | undefined, chat?: Pick<ChatViewState, 'models'>): string {
  if (!model || model === 'default') return 'Default model';
  return chat?.models.find((m) => m.id === model)?.label ?? model;
}

/** Access: the chat's live level, or what Free agent mode gives the terminal. */
export function accessLabel(
  chat: Pick<ChatViewState, 'level' | 'levelNames'> | undefined,
  freeAgentMode: boolean,
  permissionsSupported: boolean,
): string {
  if (chat?.level) return chat.levelNames?.[chat.level] ?? LEVEL_LABELS[chat.level];
  if (!permissionsSupported) return 'Set by the CLI';
  return freeAgentMode ? 'Free agent' : 'Ask before edits';
}

/** "Custom, 12 lines", or null for none. */
export function instructionsLabel(persona: string | undefined, text: string | null): string | null {
  // Hidden personas too, so the Dispatcher's reads "Dispatcher" (#2557).
  if (persona) return getPersonaTemplate(persona)?.name ?? persona;
  if (!text || !text.trim()) return null;
  const lines = text.trimEnd().split(/\r?\n/).length;
  return `Custom, ${lines} ${lines === 1 ? 'line' : 'lines'}`;
}

/** A read the card makes when opened: pending, failed, or its value. */
type Read<T> = { state: 'pending' } | { state: 'failed' } | { state: 'done'; value: T };

const PENDING = { state: 'pending' } as const;
const FAILED = { state: 'failed' } as const;

/**
 * One read keyed by `key`; a change of key drops the old value at once,
 * unless the old key starts with `keepWithin`: then the last answer stays
 * until the new one comes, so a control fed by it doesn't blink out.
 */
function useRead<T>(key: string | null, read: () => Promise<T>, keepWithin?: string): Read<T> {
  const [result, setResult] = useState<{ key: string; read: Read<T> } | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    if (!key) return;
    let alive = true;
    Promise.resolve().then(() => readRef.current()).then(
      (value) => { if (alive) setResult({ key, read: { state: 'done', value } }); },
      // telemetry-exempt: the row says it couldn't read; the full settings page shows the details.
      () => { if (alive) setResult({ key, read: FAILED }); },
    );
    return () => { alive = false; };
  }, [key]);
  if (!key || !result) return PENDING;
  if (result.key === key) return result.read;
  return keepWithin && result.key.startsWith(keepWithin) && result.read.state === 'done' ? result.read : PENDING;
}

/**
 * The servers the agent starts with: its .mcp.json ones (and the user's
 * global ones), plus the launch wrapper's when the project has a wrapper,
 * which are the agent's own pick or else the project defaults (agent-system.ts).
 */
async function readMcpNames(folder: string, projectPath: string, mcpIds: string[] | undefined): Promise<string[]> {
  const [servers, wrapper] = await Promise.all([
    window.clubhouse.agentSettings.readMcpConfig(folder, projectPath),
    window.clubhouse.project.readLaunchWrapper(projectPath),
  ]);
  const names = new Set<string>((Array.isArray(servers) ? servers : []).map((s: { name: string }) => s.name));
  if (wrapper) {
    const ids = mcpIds ?? await window.clubhouse.project.readDefaultMcps(projectPath);
    for (const id of Array.isArray(ids) ? ids : []) names.add(id);
  }
  return [...names];
}

function readText<T>(read: Read<T>, text: (value: T) => string): ReactNode {
  if (read.state === 'pending') return <span className="text-ctp-overlay1">Loading</span>;
  if (read.state === 'failed') return <span className="text-ctp-overlay1">Couldn’t read</span>;
  return text(read.value);
}

interface SettingRow {
  id: string;
  label: string;
  editable: RowEditable;
  /** The value as shown; a row with a control of its own draws it instead. */
  value?: ReactNode;
  /** The control while the row can change, when it has one here. */
  control?: ReactNode;
  /** The row itself, for a row that renders its own control (Auto-sleep). */
  render?: () => ReactNode;
}

/** The saved runtime override as shown; null when unset. */
function runtimeName(mode: string | undefined): 'Chat' | 'CLI' | null {
  return mode === 'chat' ? 'Chat' : mode === 'terminal' ? 'CLI' : null;
}

/** "Applied on the next wake": spawn settings of a sleeping agent take effect when it wakes. */
export const NEXT_WAKE_NOTE = 'Applied on the next wake';

export function SettingsCard({ agent, chat, projectPath, provider }: {
  agent: Agent;
  /** The chat session, when the agent runs in chat. */
  chat?: ChatViewState;
  /** The project folder on this machine; none for an agent on another machine. */
  projectPath: string | undefined;
  /** The CLI's name ("Claude Code"). */
  provider: string;
}) {
  const open = useAgentDetailsStore((s) => s.settingsOpen);
  const setOpen = useAgentDetailsStore((s) => s.setSettingsOpen);
  const hintId = useId();
  const remote = isRemoteProjectId(agent.projectId);
  // Only local durable agents have a config here; one on another machine keeps it there.
  const local = agent.kind === 'durable' && !remote && !!projectPath;
  const { config, loaded, update } = useDurableConfig(local ? projectPath : undefined, agent.id);
  const appMinutes = useAppIdleMinutes();
  const orchestrator = agent.orchestrator ?? 'claude-code';
  const permissionsSupported = useOrchestratorStore((s) => s.allOrchestrators.find((o) => o.id === orchestrator)?.capabilities.permissions ?? true);
  const clubhouseOn = useClubhouseModeStore((s) => (projectPath ? s.isEnabledForProject(projectPath) : false));
  const loadClubhouse = useClubhouseModeStore((s) => s.loadSettings);
  useEffect(() => { if (local) void loadClubhouse(); }, [local, loadClubhouse]);
  const satelliteProjects = useRemoteProjectStore((s) => s.satelliteProjects);
  const host = remote ? Object.values(satelliteProjects).flat().find((p) => p.id === agent.projectId)?.satelliteName : undefined;

  // A sleeping (or failed) agent can change its spawn settings; anything awake or waking can't.
  const asleep = agent.status === 'sleeping' || agent.status === 'error';
  const running = !asleep;
  // A config that couldn't be read has nothing to show or save over.
  const editing = asleep && local && loaded && config !== null;
  const unreadable = asleep && local && loaded && config === null;

  // The MCP count and instructions aren't in the summary, so they're read once the card is open.
  const folder = agent.worktreePath || projectPath;
  const readKey = open && local && loaded && folder ? `${agent.id}\n${folder}` : null;
  const mcpIds = config?.mcpIds;
  const mcp = useRead(readKey && `${readKey}\n${(mcpIds ?? []).join(',')}:${mcpIds === undefined}`, () => readMcpNames(folder!, projectPath!, mcpIds));
  const instructions = useRead(readKey, () => window.clubhouse.agentSettings.readInstructions(folder!, projectPath));

  // Saved values once the config has loaded (main drops unset ones); the agent's own until then.
  const saved = loaded && config ? config : null;
  // Asleep: the runtime the next wake starts in, as main decides it (the override, else the provider setting).
  const chatFlag = useChatFlag();
  const next = useRead(
    asleep && local && chatFlag === true ? `${agent.id}\n${orchestrator}\n${saved?.runtimeMode ?? ''}` : null,
    () => window.clubhouse.chat.getAgentRuntime(agent.id, orchestrator, { projectPath, starting: true }),
    `${agent.id}\n${orchestrator}\n`,
  );
  const nextRuntime = next.state === 'done' ? next.value : null;
  let runsIn: 'Chat' | 'CLI' | null;
  if (!asleep) runsIn = chat ? 'Chat' : 'CLI';
  else if (!local) runsIn = null;
  else if (chatFlag === false) runsIn = 'CLI';
  else if (nextRuntime) runsIn = nextRuntime.chat ? 'Chat' : 'CLI';
  else runsIn = runtimeName(saved?.runtimeMode);
  const modelId = chat && !asleep ? chat.model : (saved ? saved.model : agent.model);
  const model = modelLabel(modelId, asleep ? undefined : chat);
  const freeAgent = saved ? !!saved.freeAgentMode : !!agent.freeAgentMode;
  const access = accessLabel(asleep ? undefined : chat, freeAgent, permissionsSupported);
  // Only chat agents idle-sleep: a running chat, or a sleeping agent that wakes into chat.
  const showAutoSleep = local && (asleep ? runsIn === 'Chat' : !!chat);
  const idle = loaded ? normalizeIdleSleep(config?.idleSleep) : null;
  const summary = settingsSummary({
    runsIn,
    model,
    access,
    autoSleep: showAutoSleep && idle !== null ? autoSleepSummary(idle, appMinutes) : null,
  });
  const effort = !asleep && chat?.effortReported && chat.effort ? chat.effort[0].toUpperCase() + chat.effort.slice(1) + (chat.effortIsDefault ? ' (default)' : '') : null;

  // Saves from the controls: each row says it couldn't save, and the value goes back.
  // Keyed by agent, so a save that ends after switching agents only touches its own agent's rows.
  const [rowState, setRowState] = useState<Record<string, Record<string, 'saving' | 'failed'>>>({});
  const rowStates = rowState[agent.id] ?? {};
  const setRow = (agentId: string, id: string, st: 'saving' | 'failed' | null) => setRowState((prev) => {
    const rows = { ...prev[agentId] };
    if (st) rows[id] = st; else delete rows[id];
    return { ...prev, [agentId]: rows };
  });
  const save = async (id: string, updates: DurableConfigUpdates, patchAgent?: Partial<Agent>) => {
    const agentId = agent.id;
    setRow(agentId, id, 'saving');
    try {
      await update(updates);
      // The toolbar and sidebar read these from the agent store, as the full settings page keeps them.
      if (patchAgent) {
        useAgentStore.setState((st) => {
          const existing = st.agents[agentId];
          return existing ? { agents: { ...st.agents, [agentId]: { ...existing, ...patchAgent } } } : st;
        });
      }
      setRow(agentId, id, null);
    } catch {
      // telemetry-exempt: the row says it couldn't save and shows the saved value again.
      setRow(agentId, id, 'failed');
    }
  };
  const busy = (id: string) => rowStates[id] === 'saving';

  const { options: modelOptions, loading: modelsLoading } = useModelOptions(orchestrator, editing && open ? projectPath : '');
  const modelValue = modelId && modelId !== 'default' ? modelId : 'default';
  const modelChoices = modelOptions.some((o) => o.id === modelValue) ? modelOptions : [...modelOptions, { id: modelValue, label: modelValue }];

  // Only read while the row can change, so a closed card or an awake agent asks nothing of the CLI.
  const contextOptions = useContextWindowOptions(editing && open, projectPath, orchestrator, modelValue);
  // What the session reports now, kept apart from the saved next-start choice.
  const contextNow = !asleep && chat ? contextSummary(chat.contextLimits, chat.usage.context?.size) : null;

  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const { effectiveOrchestrators } = useEffectiveOrchestrators(local ? projectPath : undefined);
  const cliOptions = useMemo(
    () => buildOrchestratorOptions(effectiveOrchestrators, allOrchestrators, orchestrator)
      .map((o) => ({ id: o.id, label: o.displayName })),
    [effectiveOrchestrators, allOrchestrators, orchestrator],
  );

  const { requestCliChange, cliChangeDialog } = useCliChangeConfirm({
    projectPath,
    agentId: agent.id,
    agentName: agent.name,
    enabled: editing,
    apply: (v) => save('cli', { orchestrator: v, model: 'default' }, { orchestrator: v, model: undefined }),
  });

  const rows: SettingRow[] = [
    {
      id: 'cli', label: 'CLI', editable: 'sleeping',
      value: <>{provider}{chat?.cliVersion && !asleep ? <span className="text-ctp-overlay1"> {chat.cliVersion}</span> : null}</>,
      control: editing && cliOptions.length > 1 ? (
        <SelectControl
          label="CLI"
          value={orchestrator}
          disabled={busy('cli')}
          onChange={(v) => { if (v !== orchestrator) void requestCliChange(v); }}
          options={cliOptions}
        />
      ) : undefined,
    },
    ...(runsIn ? [{
      id: 'runs-in', label: 'Runs in', editable: 'sleeping' as const, value: runsIn,
      control: editing && chatFlag === true && nextRuntime?.chatAvailable ? (
        <SelectControl
          label="Runs in"
          value={saved?.runtimeMode ?? ''}
          disabled={busy('runs-in')}
          onChange={(v) => void save('runs-in', { runtimeMode: v === '' ? null : v as 'chat' | 'terminal' })}
          options={[{ id: '', label: 'Provider default' }, { id: 'chat', label: 'Chat' }, { id: 'terminal', label: 'CLI' }]}
        />
      ) : undefined,
    }] : []),
    {
      id: 'model', label: 'Model', editable: 'sleeping', value: model,
      control: editing ? (
        <SelectControl
          label="Model"
          value={modelValue}
          disabled={modelsLoading || busy('model')}
          onChange={(v) => {
            // Only a model the provider listed: a select still loading reads back as '', which main saves as no model.
            if (modelsLoading || !modelOptions.some((o) => o.id === v)) return;
            void save('model', { model: v }, { model: v === 'default' ? undefined : v });
          }}
          options={modelChoices}
        />
      ) : undefined,
    },
    // Effort lives in the chat session; the composer chip changes it.
    ...(effort ? [{ id: 'effort', label: 'Effort', editable: 'never' as const, value: effort }] : []),
    ...(contextNow ? [{ id: 'context-now', label: 'Context now', editable: 'never' as const, value: contextNow }] : []),
    ...(saved?.contextWindow && !asleep ? [{ id: 'context-saved', label: 'Context next start', editable: 'never' as const, value: formatContextChoice(saved.contextWindow) }] : []),
    ...(editing ? [{
      id: 'context', label: contextOptions?.label ?? 'Context', editable: 'sleeping' as const,
      control: (
        <span title={contextWindowHelp(contextOptions)}>
          <ContextWindowSelect
            options={contextOptions}
            value={saved?.contextWindow}
            disabled={busy('context')}
            className={SELECT_CLASS}
            onChange={(v) => void save('context', { contextWindow: v })}
          />
        </span>
      ),
    }] : []),
    {
      id: 'access', label: 'Access', editable: 'sleeping', value: access,
      control: editing && permissionsSupported ? (
        <ToggleControl
          label="Free agent mode"
          text={access}
          checked={freeAgent}
          disabled={busy('access')}
          onChange={(v) => void save('access', { freeAgentMode: v }, { freeAgentMode: v || undefined })}
        />
      ) : undefined,
    },
    ...(showAutoSleep ? [{
      id: 'auto-sleep', label: 'Auto-sleep', editable: 'always' as const,
      render: () => <AutoSleepRow key="auto-sleep" idle={idle} onChange={(next) => update({ idleSleep: next === 'inherit' ? null : next })} />,
    }] : []),
    ...(local ? [
      {
        id: 'clubhouse-mode', label: 'Clubhouse mode', editable: 'sleeping' as const,
        value: !clubhouseOn ? 'Off' : config?.clubhouseModeOverride ? 'Off for this agent' : 'On',
        // Only an agent in a Clubhouse mode project can opt out of it.
        control: editing && clubhouseOn ? (
          <ToggleControl
            label="Clubhouse mode for this agent"
            text={config?.clubhouseModeOverride ? 'Off for this agent' : 'On'}
            checked={!config?.clubhouseModeOverride}
            disabled={busy('clubhouse-mode')}
            onChange={(v) => void save('clubhouse-mode', { clubhouseModeOverride: !v })}
          />
        ) : undefined,
      },
      { id: 'mcp', label: 'MCP servers', editable: 'never' as const, value: readText(mcp, (names) => (names.length === 0 ? 'None' : `${names.length} enabled`)) },
      { id: 'instructions', label: 'Instructions', editable: 'never' as const, value: readText(instructions, (text) => instructionsLabel(config?.persona, typeof text === 'string' ? text : null) ?? 'None') },
    ] : []),
  ];
  const anyLocked = rows.some((r) => isRowLocked(r.editable, running));
  const anyControl = rows.some((r) => r.control);

  return (
    <DetailsCard id="settings" title="Settings" summary={summary} open={open} onToggle={() => setOpen(!open)}>
      {rows.map((r) => {
        if (r.render) return r.render();
        const locked = isRowLocked(r.editable, running);
        const failed = rowStates[r.id] === 'failed';
        return (
          <CardRow key={r.id} label={r.label} labelWidth="wide" testId={`details-setting-${r.id}`} locked={locked} describedBy={locked ? hintId : undefined}>
            {r.control ? (
              <span className="flex flex-col items-start gap-1">
                {r.control}
                {failed && <span className="text-ctp-overlay1" data-testid={`details-setting-${r.id}-error`}>Couldn’t save. Try again.</span>}
              </span>
            ) : r.value}
          </CardRow>
        );
      })}
      {saved?.contextWindowNotice && <CardNote><span data-testid="details-settings-context-notice">{saved.contextWindowNotice}</span></CardNote>}
      {anyLocked && <CardNote><span id={hintId} data-testid="details-settings-locked-hint">{LOCKED_HINT}</span></CardNote>}
      {unreadable && <CardNote><span data-testid="details-settings-unreadable">Couldn’t read this agent’s settings. Try All settings.</span></CardNote>}
      {anyControl && <CardNote><span data-testid="details-settings-next-wake">{NEXT_WAKE_NOTE}</span></CardNote>}
      {remote && agent.kind === 'durable' && (
        <CardNote><span data-testid="details-settings-remote">Change on {host ?? 'the other machine'}</span></CardNote>
      )}
      {local && (
        <div className="pr-3.5 pl-[33px] pt-1">
          <Button kind="ghost" onClick={() => (isDispatcherAgent(agent) ? openDispatcherSettings() : openAllSettings(agent.id))} data-testid="details-all-settings">All settings</Button>
        </div>
      )}
      {cliChangeDialog}
    </DetailsCard>
  );
}

function SelectControl({ label, value, options, disabled, onChange }: {
  label: string;
  value: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={SELECT_CLASS}>
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

function ToggleControl({ label, text, checked, disabled, onChange }: {
  label: string;
  text: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <span className="flex items-center gap-2">
      <Toggle checked={checked} disabled={disabled} onChange={onChange} aria-label={label} />
      <span>{text}</span>
    </span>
  );
}

/** Opens the agent's full settings on General, as the agent menu's Settings does. */
export function openAllSettings(agentId: string): void {
  useAgentStore.getState().openAgentSettings(agentId);
  useAgentSettingsPages.getState().setPage('general');
}
