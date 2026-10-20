/**
 * The Settings card (#2280): the agent's key settings at the top of Agent
 * details, collapsed to one line ("Chat · Opus 5.5 · Full access · Sleeps
 * after 30 min"), with "All settings" for the full page.
 *
 * Each row says when it can change (`editable`), so a row can become
 * live-editable later without touching the others. A running agent's spawn
 * settings are locked until it sleeps; Auto-sleep is a Clubhouse-side timer
 * and changes live. Model, effort and access keep their composer chips while
 * the agent runs; the rows here only reflect them.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Agent } from '../../../../shared/types';
import type { ChatViewState } from '../../../stores/chatStore';
import { useAgentStore } from '../../../stores/agentStore';
import { useClubhouseModeStore } from '../../../stores/clubhouseModeStore';
import { useOrchestratorStore } from '../../../stores/orchestratorStore';
import { isRemoteProjectId } from '../../../stores/remoteProjectStore';
import { Button } from '../../../components/Button';
import { PERSONA_TEMPLATES } from '../../personas';
import { useAgentSettingsPages } from '../agentSettingsPages';
import { LEVEL_LABELS } from '../chat/view-model';
import { normalizeIdleSleep } from '../../../../shared/idle-sleep';
import { AutoSleepRow, autoSleepSummary, useAppIdleMinutes } from './AutoSleepRow';
import { CardNote, CardRow, DetailsCard } from './DetailsCard';
import { useAgentDetailsStore } from './detailsStore';
import { useDurableConfig } from './useDurableConfig';

/**
 * When a row's setting can change: at any time (applied live), only while the
 * agent sleeps (it's read at spawn), or never here (the full page edits it).
 */
export type RowEditable = 'always' | 'sleeping' | 'never';

/** A row is locked when it could change, but not while the agent runs. */
export function isRowLocked(editable: RowEditable, running: boolean): boolean {
  return editable === 'sleeping' && running;
}

export const LOCKED_HINT = 'Sleep the agent to change these';

export interface SettingsValues {
  runsIn: 'Chat' | 'Terminal' | null;
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
  if (persona) return PERSONA_TEMPLATES.find((p) => p.id === persona)?.name ?? persona;
  if (!text || !text.trim()) return null;
  const lines = text.trimEnd().split(/\r?\n/).length;
  return `Custom, ${lines} ${lines === 1 ? 'line' : 'lines'}`;
}

/** A read the card makes when opened: pending, failed, or its value. */
type Read<T> = { state: 'pending' } | { state: 'failed' } | { state: 'done'; value: T };

const PENDING = { state: 'pending' } as const;
const FAILED = { state: 'failed' } as const;

/** One read keyed by `key`; a change of key drops the old value at once. */
function useRead<T>(key: string | null, read: () => Promise<T>): Read<T> {
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
  return key && result?.key === key ? result.read : PENDING;
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
  /** The row itself, for a row that renders its own control (Auto-sleep). */
  render?: () => ReactNode;
}

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
  // Only local durable agents have a config here; one on another machine keeps it there.
  const local = agent.kind === 'durable' && !isRemoteProjectId(agent.projectId) && !!projectPath;
  const { config, loaded, update } = useDurableConfig(local ? projectPath : undefined, agent.id);
  const appMinutes = useAppIdleMinutes();
  const permissionsSupported = useOrchestratorStore((s) => s.allOrchestrators.find((o) => o.id === (agent.orchestrator ?? 'claude-code'))?.capabilities.permissions ?? true);
  const clubhouseOn = useClubhouseModeStore((s) => (projectPath ? s.isEnabledForProject(projectPath) : false));
  const loadClubhouse = useClubhouseModeStore((s) => s.loadSettings);
  useEffect(() => { if (local) void loadClubhouse(); }, [local, loadClubhouse]);

  // The MCP count and instructions aren't in the summary, so they're read once the card is open.
  const folder = agent.worktreePath || projectPath;
  const readKey = open && local && loaded && folder ? `${agent.id}\n${folder}` : null;
  const mcpIds = config?.mcpIds;
  const mcp = useRead(readKey && `${readKey}\n${(mcpIds ?? []).join(',')}:${mcpIds === undefined}`, () => readMcpNames(folder!, projectPath!, mcpIds));
  const instructions = useRead(readKey, () => window.clubhouse.agentSettings.readInstructions(folder!, projectPath));

  const running = agent.status === 'running';
  // Saved values once the config has loaded (main drops unset ones); the agent's own until then.
  const saved = loaded && config ? config : null;
  const savedRunsIn = saved?.runtimeMode;
  const runsIn = running ? (chat ? 'Chat' : 'Terminal') : savedRunsIn === 'chat' ? 'Chat' : savedRunsIn === 'terminal' ? 'Terminal' : null;
  const model = modelLabel(chat?.model ?? (saved ? saved.model : agent.model), chat);
  const access = accessLabel(chat, saved ? !!saved.freeAgentMode : !!agent.freeAgentMode, permissionsSupported);
  // Only chat agents idle-sleep.
  const showAutoSleep = !!chat && local;
  const idle = loaded ? normalizeIdleSleep(config?.idleSleep) : null;
  const summary = settingsSummary({
    runsIn,
    model,
    access,
    autoSleep: showAutoSleep && idle !== null ? autoSleepSummary(idle, appMinutes) : null,
  });
  const effort = chat?.effortReported && chat.effort ? chat.effort[0].toUpperCase() + chat.effort.slice(1) + (chat.effortIsDefault ? ' (default)' : '') : null;

  const rows: SettingRow[] = [
    { id: 'cli', label: 'CLI', editable: 'never', value: <>{provider}{chat?.cliVersion ? <span className="text-ctp-overlay1"> {chat.cliVersion}</span> : null}</> },
    ...(runsIn ? [{ id: 'runs-in', label: 'Runs in', editable: 'sleeping' as const, value: runsIn }] : []),
    { id: 'model', label: 'Model', editable: 'sleeping', value: model },
    // Effort lives in the chat session; the composer chip changes it.
    ...(effort ? [{ id: 'effort', label: 'Effort', editable: 'never' as const, value: effort }] : []),
    { id: 'access', label: 'Access', editable: 'sleeping', value: access },
    ...(showAutoSleep ? [{
      id: 'auto-sleep', label: 'Auto-sleep', editable: 'always' as const,
      render: () => <AutoSleepRow key="auto-sleep" idle={idle} onChange={(next) => update({ idleSleep: next === 'inherit' ? null : next })} />,
    }] : []),
    ...(local ? [
      { id: 'clubhouse-mode', label: 'Clubhouse mode', editable: 'sleeping' as const, value: !clubhouseOn ? 'Off' : config?.clubhouseModeOverride ? 'Off for this agent' : 'On' },
      { id: 'mcp', label: 'MCP servers', editable: 'never' as const, value: readText(mcp, (names) => (names.length === 0 ? 'None' : `${names.length} enabled`)) },
      { id: 'instructions', label: 'Instructions', editable: 'never' as const, value: readText(instructions, (text) => instructionsLabel(config?.persona, typeof text === 'string' ? text : null) ?? 'None') },
    ] : []),
  ];
  const anyLocked = rows.some((r) => isRowLocked(r.editable, running));

  return (
    <DetailsCard id="settings" title="Settings" summary={summary} open={open} onToggle={() => setOpen(!open)}>
      {rows.map((r) => {
        if (r.render) return r.render();
        const locked = isRowLocked(r.editable, running);
        return (
          <CardRow key={r.id} label={r.label} labelWidth="wide" testId={`details-setting-${r.id}`} locked={locked} describedBy={locked ? hintId : undefined}>
            {r.value}
          </CardRow>
        );
      })}
      {anyLocked && <CardNote><span id={hintId} data-testid="details-settings-locked-hint">{LOCKED_HINT}</span></CardNote>}
      {agent.kind === 'durable' && (
        <div className="pr-3.5 pl-[33px] pt-1">
          <Button kind="ghost" onClick={() => openAllSettings(agent.id)} data-testid="details-all-settings">All settings</Button>
        </div>
      )}
    </DetailsCard>
  );
}

/** Opens the agent's full settings on General, as the agent menu's Settings does. */
export function openAllSettings(agentId: string): void {
  useAgentStore.getState().openAgentSettings(agentId);
  useAgentSettingsPages.getState().setPage('general');
}
