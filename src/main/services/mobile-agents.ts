/**
 * Durable agents from a phone (#2451, #2452): what the New agent page and the
 * Details → Settings card offer, and the agent.create / agent.update mobile
 * commands. Validation and writes go through the same services the desktop
 * uses. A paired phone has full control, Access included (#2462, #3207):
 * it can already approve every request one by one.
 */

import { mobileHelperRoutingDetail } from './mobile-helper-routing';
import { CONTEXT_WINDOW_APPLIES, type ContextWindowOptions } from '../../shared/context-window';
import { contextWindowCheck, contextWindowOptionsFor } from './context-window';
import type { DurableAgentConfig, DurableConfigUpdates, McpCatalogEntry, StartDurableCreationParams } from '../../shared/types';
import { dispatcherNotHonored, type MobileAccess, type MobileAccessLevel, type MobileAgentCreate, type MobileAgentUpdate, type MobileContextWindow, type MobileSettingEditable } from '../../shared/mobile-control';
import {
  ACCESS_DESCRIPTIONS, ACCESS_LEVELS as AGENT_ACCESS_LEVELS, accessLabel, accessLevelsFor, startableAccess, type AccessLevel, type AccessRuntime,
} from '../../shared/agent-access';
import { agentAccess, getDefaultAccess } from './free-agent-settings';
import { AGENT_IDLE_SLEEP_MINUTES, normalizeIdleSleep, resolveIdleSleep } from '../../shared/idle-sleep';
import { AGENT_COLORS, generateDurableName } from '../../shared/name-generator';
import { validateAgentGitName } from '../../shared/agent-name';
import * as agentConfig from './agent-config';
import { parseStartCreationParams, startDurableCreation } from './agent-creation';
import { checkAvailability, getAvailableOrchestrators, resolveOrchestrator } from './agent-system';
import { readDefaultMcps, readMcpCatalog } from './agent-settings-service';
import * as orchestratorSettings from './orchestrator-settings';
import { chatIdleSettings } from './chat-idle-settings';
import { isChatEnabled, resolveRuntimeMode } from './chat-runtime-settings';
import { resolveChatDriver } from './agent-runtime/chat-drivers';
import { isChatAgent } from './agent-runtime';
import { getBranchChanges, isInsideGitRepo } from './git-service';
import { MobileControlError } from './mobile-control';
import * as orchestrationPolicy from './orchestration-policy';
import * as orchestrationSettings from './orchestration-settings';
import { dispatcherEnablement } from './dispatcher/dispatcher-settings';
import { modelsChosenByHand } from './dispatcher/dispatcher-models';
import {
  ACCESS_LEVELS, MAX_HELPER_LIMIT, ORCHESTRATION_CONTROLS, validateOrchestrationPatch,
  type OrchestrationAccess, type OrchestrationPolicyPatch, type ResolvedOrchestrationPolicy,
} from '../../shared/orchestration-policy';

export interface MobileAgentProject { id: string; path: string }

/** A durable agent's state as a phone needs it for editing. */
export type MobileAgentState = 'creating' | 'failed' | 'starting' | 'running' | 'sleeping';

const DEFAULT_ORCHESTRATOR = 'claude-code';
/** agent.update settings read at spawn: everything but auto-sleep. */
const SPAWN_SETTINGS = ['name', 'color', 'emoji', 'orchestrator', 'model', 'runtime', 'persona', 'clubhouseMode', 'freeAgentMode', 'access', 'contextWindow'] as const satisfies ReadonlyArray<keyof MobileAgentUpdate>;
/** Shown when a spawn setting changes on an awake agent, as on the Settings card. */
const LOCKED_DETAIL = 'Sleep the agent to change these';

export const MOBILE_AGENT_COLORS = AGENT_COLORS.map(({ id, label, hex }) => ({ id, label, hex }));

/** The orchestrators the New agent page offers: the enabled ones. */
export function effectiveOrchestrators() {
  const enabled = orchestratorSettings.getSettings().enabled ?? [DEFAULT_ORCHESTRATOR];
  return getAvailableOrchestrators().filter((o) => enabled.includes(o.id));
}

const chatAvailable = (orchestrator: string): boolean => isChatEnabled() && !!resolveChatDriver(orchestrator, resolveRuntimeMode(orchestrator).driver);
/** Free Agent Mode needs a CLI with permission support, as the New agent page and Settings card require. */
const permissionsSupported = (orchestrator: string): boolean =>
  getAvailableOrchestrators().find((o) => o.id === orchestrator)?.capabilities?.permissions ?? false;

/** One level as the desktop's Access picker names it (#3207). */
const accessLevel = (id: AccessLevel): MobileAccessLevel => ({ id, label: accessLabel(id), description: ACCESS_DESCRIPTIONS[id] });
/** Every level, in ladder order, for a phone's picker. */
export const MOBILE_ACCESS_LEVELS: readonly MobileAccessLevel[] = AGENT_ACCESS_LEVELS.map(accessLevel);

/**
 * The levels the Access picker offers for this CLI (#3207): with a runtime,
 * the ones it can start at there; without, the ones either runtime has, as
 * the New agent page offers. A CLI that sets access itself offers Ask first only.
 */
function accessChoices(orchestrator: string, runtime?: AccessRuntime): readonly AccessLevel[] {
  return permissionsSupported(orchestrator) ? accessLevelsFor(orchestrator, runtime) : ['ask'];
}

/** The runtime an asleep agent's next wake uses, as the Settings card reads it. */
function nextRuntime(orchestrator: string, runtimeMode: DurableAgentConfig['runtimeMode']): AccessRuntime {
  const mode = resolveRuntimeMode(orchestrator, runtimeMode);
  return mode.mode === 'chat' && resolveChatDriver(orchestrator, mode.driver) ? 'chat' : 'terminal';
}

/** A level the picker wouldn't offer is 409 access_unavailable. Keeping the saved one is always allowed. */
function assertAccess(level: AccessLevel, orchestrator: string, runtime: AccessRuntime | undefined, saved?: AccessLevel): void {
  if (level === saved || accessChoices(orchestrator, runtime).includes(level)) return;
  const cli = getAvailableOrchestrators().find((o) => o.id === orchestrator)?.displayName ?? orchestrator;
  throw new MobileControlError('access_unavailable', 409, 'rejected', `${accessLabel(level)} isn't a level ${cli} can start at.`);
}

/** `settings.access` (#3207): the saved level, what it can be set to, and what it really starts at. */
export function mobileAccess(config: DurableAgentConfig, projectPath: string, orchestrator: string, runtime: AccessRuntime, editable: MobileSettingEditable): MobileAccess {
  const value = agentAccess(config, projectPath);
  return {
    value,
    editable: permissionsSupported(orchestrator) ? editable : 'never',
    choices: accessChoices(orchestrator, runtime).map(accessLevel),
    startsAt: permissionsSupported(orchestrator) ? startableAccess(value, orchestrator, runtime) : 'ask',
    default: getDefaultAccess(),
    applies: 'next_start',
  };
}

async function modelOptions(projectPath: string, orchestrator: string): Promise<Array<{ id: string; label: string }>> {
  try {
    const provider = await resolveOrchestrator(projectPath, orchestrator);
    const options = await provider.getModelOptions();
    if (Array.isArray(options) && options.length > 0) return options;
  } catch {
    // telemetry-exempt: the picker falls back to the provider default, as useModelOptions does.
  }
  return [{ id: 'default', label: 'Default' }];
}

/**
 * Orchestrators, models per orchestrator and colours: what both the create form and settings pick from.
 * `personas` is always empty: personas were retired (#2901), and the key stays for phones that read it.
 */
export async function buildAgentOptions(projectPath: string) {
  const orchestrators = effectiveOrchestrators();
  const rows = await Promise.all(orchestrators.map(async (o) => {
    const [availability, models] = await Promise.all([
      checkAvailability(projectPath, o.id).catch((err: unknown) => ({ available: false, error: err instanceof Error ? err.message : 'unavailable' })),
      modelOptions(projectPath, o.id),
    ]);
    return {
      id: o.id, displayName: o.displayName, shortName: o.shortName, ...(o.badge ? { badge: o.badge } : {}),
      available: availability.available, ...(availability.error ? { unavailableReason: availability.error } : {}),
      // Without permission support the CLI sets access itself; the phone shows "Set by the CLI".
      permissions: o.capabilities?.permissions ?? false,
      // The Access levels a new agent on this CLI can be given (#3207), as the New agent page offers them.
      accessLevels: [...accessChoices(o.id)],
      chat: chatAvailable(o.id),
      models,
    };
  }));
  const personas: Array<{ id: string; name: string; source: 'builtin' | 'user' | 'project' }> = [];
  return { orchestrators: rows, personas, colors: MOBILE_AGENT_COLORS, accessLevels: [...MOBILE_ACCESS_LEVELS] };
}

/** The New agent page's form for one project (#2451). */
export async function buildCreateOptions(project: MobileAgentProject) {
  const [options, isGitRepo, catalog, defaultMcps] = await Promise.all([
    buildAgentOptions(project.path),
    isInsideGitRepo(project.path).catch(() => false),
    readMcpCatalog(project.path).catch((): McpCatalogEntry[] => []),
    readDefaultMcps(project.path).catch((): string[] => []),
  ]);
  return {
    projectId: project.id,
    ...options,
    mcp: { catalog: catalog.map(({ id, name, description }) => ({ id, name, description })), defaults: defaultMcps },
    isGitRepo,
    suggestedName: generateDurableName(),
    defaults: {
      orchestrator: options.orchestrators[0]?.id ?? DEFAULT_ORCHESTRATOR,
      color: AGENT_COLORS[0].id,
      model: 'default',
      useWorktree: isGitRepo,
      // What a new agent starts at when `access` is left out (#3207).
      access: getDefaultAccess(),
    },
    // Offered for orchestrators with `permissions`, as on the desktop page.
    freeAgentMode: { allowed: true },
  };
}

/** The most helpers one agent may have: the app-wide cap, never above the hard limit (as the desktop's Helpers at once). */
export function maxHelpersCap(): number {
  return Math.max(1, Math.min(MAX_HELPER_LIMIT, orchestrationSettings.getGlobalHelperCap()));
}

const ACCESS_CHOICES: readonly OrchestrationAccess[] = ['same', ...ACCESS_LEVELS];

/**
 * An agent's orchestration policy as a phone shows and edits it: the resolved
 * fields, where each came from (`agent` is an override agent.update can clear
 * with null), and the choices the Orchestration card offers. `mcpEnabled` is
 * always true: the Clubhouse MCP always runs. It stays in the contract.
 */
export function mobileOrchestration(policy: ResolvedOrchestrationPolicy) {
  const { orchestrate, access, control, maxHelpers, crossProjectHelpers, connectToDispatcher, sources } = policy;
  return {
    orchestrate, access, control, maxHelpers, crossProjectHelpers, connectToDispatcher,
    // This agent's own switch, or null while it follows the app. Whether Auto works is autoHelpersEffective.
    autoHelpers: sources.autoHelpers === 'agent' ? policy.autoHelpers : null,
    autoHelpersEffective: policy.autoEffective?.effective ?? false,
    mcpEnabled: true as const,
    sources: {
      orchestrate: sources.orchestrate, access: sources.access, control: sources.control, maxHelpers: sources.maxHelpers,
      crossProjectHelpers: sources.crossProjectHelpers, connectToDispatcher: sources.connectToDispatcher, autoHelpers: sources.autoHelpers,
    },
    maxHelpersCap: maxHelpersCap(), controls: [...ORCHESTRATION_CONTROLS], accessLevels: [...ACCESS_CHOICES],
  };
}
export type MobileOrchestration = ReturnType<typeof mobileOrchestration>;

/**
 * Every policy field a phone shows, for agent.update's `orchestration: null`
 * (clear every override). Phones gate cross-project helpers (#2512) and
 * Connect to Dispatcher (#2534) on capabilities; one that doesn't know them
 * clears them too, as Reset on the desktop would.
 */
const CLEAR_ALL: OrchestrationPolicyPatch = {
  orchestrate: null, access: null, control: null, maxHelpers: null, crossProjectHelpers: null, connectToDispatcher: null, autoHelpers: null,
};

/**
 * A phone's orchestration patch, checked with the desktop's rules: the shared
 * validator, and Helpers at once no higher than the app-wide cap. `null`
 * clears a field on update; create only sets fields.
 */
export function parseMobileOrchestration(raw: unknown, mode: 'update' | 'create'): OrchestrationPolicyPatch {
  if (raw === null && mode === 'update') return { ...CLEAR_ALL };
  const cap = maxHelpersCap();
  const capMessage = `maxHelpers must be a whole number from 1 to ${cap}`;
  let patch: OrchestrationPolicyPatch;
  try {
    patch = validateOrchestrationPatch(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : undefined;
    throw invalid('invalid_orchestration', message?.startsWith('maxHelpers ') ? capMessage : message);
  }
  if (Object.keys(patch).length === 0) throw invalid('invalid_orchestration', 'Set at least one orchestration field');
  if (mode === 'create' && Object.values(patch).some((v) => v === null)) throw invalid('invalid_orchestration', 'A new agent has no orchestration overrides to clear');
  if (typeof patch.maxHelpers === 'number' && patch.maxHelpers > cap) throw invalid('invalid_orchestration', capMessage);
  // The Orchestration card offers Connect to Dispatcher only while the Dispatcher is on (#2534); off is always allowed.
  if (patch.connectToDispatcher === true) {
    if (!dispatcherEnablement().enabled) throw new MobileControlError('dispatcher_off', 409, 'rejected', 'Turn on the Dispatcher first.');
  }
  return patch;
}

/** Write a policy patch through the desktop's own service; a refused change is a command error. */
async function writeOrchestration(projectPath: string, agentId: string, patch: OrchestrationPolicyPatch): Promise<void> {
  const result = await orchestrationPolicy.setOrchestrationPolicy(projectPath, agentId, patch, { surface: 'mobile' });
  if (result.ok) return;
  if (result.needsHelperChoice) throw new MobileControlError('orchestration_has_helpers', 409, 'rejected', result.message);
  throw new MobileControlError('orchestration_refused', 409, 'rejected', result.message);
}

async function orchestrationOf(projectPath: string, config: DurableAgentConfig): Promise<MobileOrchestration> {
  const policies = await orchestrationPolicy.resolveOrchestrationPolicies(projectPath, [config]);
  return mobileOrchestration(policies.get(config.id)!);
}

function stateOf(config: DurableAgentConfig, live: 'running' | 'starting' | undefined): MobileAgentState {
  if (config.creation?.state === 'creating') return 'creating';
  if (live) return live;
  return config.creation?.state === 'failed' ? 'failed' : 'sleeping';
}

const field = <T>(value: T, editable: MobileSettingEditable) => ({ value, editable });

/** The saved next-start choice with what the CLI offers for this model (#2660). `chatControls.context` is what a session runs with. */
export function mobileContextWindow(config: DurableAgentConfig, options: ContextWindowOptions, editable: MobileSettingEditable): MobileContextWindow {
  const notice = config.contextWindowNotice ?? null;
  const value = config.contextWindow ?? null;
  if (options.configurable === false) {
    return {
      value, editable: 'never', configurable: false, kind: null, label: options.label, description: null, defaultLabel: null,
      choices: [], defaultTokens: null, maxTokens: null, costNote: null, applies: CONTEXT_WINDOW_APPLIES, state: options.state, reason: options.reason, notice,
    };
  }
  return {
    value, editable, configurable: true, kind: options.kind, label: options.label, description: options.description, defaultLabel: options.defaultLabel,
    choices: options.choices, defaultTokens: options.defaultTokens, maxTokens: options.maxTokens, costNote: options.costNote, applies: options.applies,
    state: null, reason: null, notice,
  };
}

/** Tells the phone this update cleared the saved context choice, with the reason, so it needn't refetch. */
function contextWindowReset(previous: string | undefined, saved: DurableAgentConfig, command: MobileAgentUpdate) {
  if (!previous || saved.contextWindow || command.contextWindow === null) return {};
  return { contextWindowReset: { previous, reason: saved.contextWindowNotice ?? 'The saved context choice was cleared.' } };
}

/** agent.update's contextWindow: null clears; anything else must be on offer. Checked here so the phone gets the stable code. */
async function assertContextWindow(project: MobileAgentProject, orchestrator: string, model: string | undefined, value: string | null | undefined): Promise<void> {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') throw invalid('invalid_context_window', 'contextWindow must be a choice id or null.');
  const check = await contextWindowCheck(project.path, orchestrator, model && model !== 'default' ? model : undefined, value);
  if (check.state !== 'ok') throw invalid('invalid_context_window', check.message);
}

/**
 * One agent's settings as the Settings card shows them, each with when it can
 * change (#2452). The Dispatcher's are Settings > Dispatcher's: CLI, model,
 * runtime, Access and auto-sleep, at any time (they apply the next time it
 * starts); its name, colour, emoji and orchestration never.
 */
export async function buildAgentSettings(
  project: MobileAgentProject,
  config: DurableAgentConfig,
  live: 'running' | 'starting' | undefined,
  { dispatcher = false }: { dispatcher?: boolean } = {},
) {
  const state = stateOf(config, live);
  const orchestrator = config.orchestrator
    || await resolveOrchestrator(project.path).then((p) => p.id).catch(() => DEFAULT_ORCHESTRATOR);
  /** What a spawn setting's `sleeping` becomes: any time for the Dispatcher, never for its locked ones. */
  const spawn: MobileSettingEditable = dispatcher ? 'always' : 'sleeping';
  const identity: MobileSettingEditable = dispatcher ? 'never' : 'sleeping';
  const runtimeEditable: MobileSettingEditable = chatAvailable(orchestrator) ? spawn : 'never';
  // Awake, the runtime it runs in; asleep, the one the next wake starts in.
  const runtime: AccessRuntime = live ? (isChatAgent(config.id) ? 'chat' : 'terminal') : nextRuntime(orchestrator, config.runtimeMode);
  const appMinutes = chatIdleSettings.getSettings().idleTimeoutMinutes;
  const idle = normalizeIdleSleep(config.idleSleep);
  const resolved = resolveIdleSleep(idle, appMinutes);
  // Personas and Clubhouse Mode were retired (#2901): `persona` and `clubhouseMode` are always null
  // and never editable, and `projectEnabled` is false, kept for phones that read them.
  // The Dispatcher's orchestration settings are locked (#2533), so it has none to show.
  const orchestration = dispatcher ? null : await orchestrationOf(project.path, config);
  const routing = mobileHelperRoutingDetail(config.routing);
  return {
    ...(routing && { routing }),
    agentId: config.id,
    projectId: project.id,
    ...(dispatcher && { isDispatcher: true as const }),
    /** The Dispatcher's settings here that Settings > Dispatcher no longer offers, so a phone hides them (#3206). */
    ...(dispatcher && { notHonored: dispatcherNotHonored(modelsChosenByHand()) }),
    /** The agent that started it, so a controller can tell a helper. Absent on a top-level agent. */
    ...(config.parentAgentId && { parentAgentId: config.parentAgentId }),
    state,
    /** Settings marked `sleeping` can change now. */
    sleeping: state === 'sleeping' || state === 'failed',
    settings: {
      name: field(config.name, identity),
      color: field(config.color, identity),
      emoji: field(config.emoji ?? null, identity),
      hasImageIcon: !!config.icon,
      // A new CLI can't resume this session (#2593), so a phone can warn before sending the change.
      orchestrator: { ...field(config.orchestrator ?? null, spawn), resolved: orchestrator, changeStartsNewSession: !!config.lastSessionId },
      model: field(config.model ?? 'default', spawn),
      runtime: { ...field(config.runtimeMode ?? 'default', runtimeEditable), resolved: runtime },
      persona: field(null, 'never'),
      clubhouseMode: { ...field(null, 'never'), projectEnabled: false },
      // The legacy on/off for older phones: true at Auto or Full access. `access` is the level (#3207).
      freeAgentMode: field(!!config.freeAgentMode, permissionsSupported(orchestrator) ? spawn : 'never'),
      access: mobileAccess(config, project.path, orchestrator, runtime, spawn),
      // Only chat agents idle-sleep; the value is kept either way.
      idleSleep: { ...field(idle, 'always'), minutes: resolved.minutes, source: resolved.source, applies: runtime === 'chat' },
      contextWindow: mobileContextWindow(config, await contextWindowOptionsFor(project.path, orchestrator, config.model), spawn),
    },
    /** Changes at any time, as on the Orchestration card; agent.update's `orchestration`. Null for the Dispatcher. */
    orchestration,
  };
}

/** The branch against main as a phone shows it: counts only, never file names or diffs. */
export interface MobileAgentChanges {
  /** False when the agent's folder isn't in a git work tree. */
  available: boolean;
  /** Short name of the main line ("main"). */
  base: string | null;
  /** No main line to compare with. */
  noBase: boolean;
  files: number;
  additions: number;
  deletions: number;
  /** Commits on the branch since it left main. */
  ahead: number | null;
  /** Uncommitted and untracked files. */
  uncommitted: number | null;
}

/** `path` under `root` as the hover card shows it, or the path itself when it's elsewhere. */
function underProject(root: string, path: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root);
  const p = norm(path);
  return r && p.startsWith(`${r}/`) ? p.slice(r.length + 1) : path;
}

/**
 * What Agent details shows besides the settings (#157): the branch and
 * worktree, the MCP servers set for the agent, and its branch's changes
 * against main as on the Changes card. Changes are null while the agent is
 * still being created or when git can't be read.
 */
export async function buildAgentDetails(project: MobileAgentProject, config: DurableAgentConfig, { dispatcher = false }: { dispatcher?: boolean } = {}) {
  const creating = config.creation?.state === 'creating';
  // The Dispatcher's folder is no git repo (#2533): no Changes.
  const changes = creating || dispatcher ? null : await getBranchChanges(config.worktreePath || project.path, undefined, true).then(
    (c): MobileAgentChanges => ({
      available: c.available,
      base: c.base ?? null,
      noBase: !!c.noBase,
      files: c.files.length,
      additions: c.files.reduce((n, f) => n + f.additions, 0),
      deletions: c.files.reduce((n, f) => n + f.deletions, 0),
      ahead: c.ahead ?? null,
      uncommitted: c.uncommitted ?? null,
    }),
    // telemetry-exempt: the phone shows the changes as unavailable.
    (): null => null,
  );
  return {
    branch: config.branch ?? null,
    worktreePath: config.worktreePath ?? null,
    worktree: config.worktreePath ? underProject(project.path, config.worktreePath) : null,
    mcpIds: config.mcpIds ?? [],
    changes,
  };
}

/** Option lists for an agent's settings: the create form's, plus auto-sleep. */
export async function buildAgentSettingsOptions(projectPath: string) {
  return {
    ...await buildAgentOptions(projectPath),
    idleSleep: { minutes: [...AGENT_IDLE_SLEEP_MINUTES], appMinutes: chatIdleSettings.getSettings().idleTimeoutMinutes },
  };
}

function invalid(code: string, detail?: string): MobileControlError {
  return new MobileControlError(code, 400, 'rejected', detail);
}

function assertGitName(value: string, kind: 'folder' | 'branch', code: string): void {
  const problem = validateAgentGitName(value, kind);
  if (problem) throw invalid(code, problem);
}

function assertOrchestrator(orchestrator: string): void {
  if (!effectiveOrchestrators().some((o) => o.id === orchestrator)) throw new MobileControlError('orchestrator_unavailable', 409);
}

/**
 * Personas were retired (#2901): a persona in a command is refused, and
 * nothing in it is saved. `null` (clear it) is a no-op: there is none to clear.
 */
function refusePersona(name: string): never {
  throw new MobileControlError('managed_agent', 409, 'rejected', `Personas were retired, so ${name} can't take one. Clubhouse-managed agents get their instructions from their setup.`);
}

/** Clubhouse Mode was retired (#2901): any clubhouseMode in a command is refused, and nothing in it is saved. */
function refuseClubhouseMode(name: string): never {
  throw new MobileControlError('managed_agent', 409, 'rejected', `Clubhouse Mode was retired, so ${name} can't use it. Clubhouse-managed agents get their instructions, skills and MCP servers from their setup.`);
}

const assertColor = (color: string): void => {
  if (!AGENT_COLORS.some((c) => c.id === color)) throw invalid('invalid_color');
};

/**
 * agent.create (#2451): the New agent page's durable create. Returns once the
 * agent's record exists; its worktree is made in the background, as on the
 * desktop, and the snapshot shows it creating, then sleeping (or failed).
 */
export async function createMobileAgent(project: MobileAgentProject, command: MobileAgentCreate, assertAuthorized: () => void) {
  const name = command.name.trim();
  if (!name) throw invalid('invalid_name');
  assertColor(command.color);
  const isGit = await isInsideGitRepo(project.path).catch(() => false);
  const useWorktree = command.useWorktree ?? isGit;
  if (useWorktree && !isGit) throw new MobileControlError('not_git_repo', 409);
  const { folderName, branchName, branchFrom } = command;
  if (!useWorktree && (folderName !== undefined || branchName !== undefined || branchFrom !== undefined)) throw invalid('worktree_options_require_worktree');
  // The name (or folder) becomes a folder and a git branch on this machine (#2221).
  if (useWorktree) assertGitName(folderName ?? name, 'folder', folderName === undefined ? 'invalid_name' : 'invalid_folder_name');
  if (branchName !== undefined) assertGitName(branchName, 'branch', 'invalid_branch_name');
  const orchestrator = command.orchestrator ?? effectiveOrchestrators()[0]?.id ?? DEFAULT_ORCHESTRATOR;
  assertOrchestrator(orchestrator);
  // A level wins over the legacy on/off beside it (#3207), as callerAccess does on the desktop.
  if (command.access !== undefined) assertAccess(command.access, orchestrator, undefined);
  else if (command.freeAgentMode && !permissionsSupported(orchestrator)) throw new MobileControlError('free_agent_mode_unavailable');
  if (command.persona != null) refusePersona(name);
  const orchestration = command.orchestration !== undefined ? parseMobileOrchestration(command.orchestration, 'create') : undefined;
  if (command.mcpIds?.length) {
    const catalog = new Set((await readMcpCatalog(project.path).catch((): McpCatalogEntry[] => [])).map((m) => m.id));
    if (command.mcpIds.some((id) => !catalog.has(id))) throw invalid('unknown_mcp');
  }
  let params: StartDurableCreationParams;
  try {
    params = parseStartCreationParams({
      name, color: command.color, model: command.model, useWorktree, orchestrator,
      freeAgentMode: command.access === undefined ? command.freeAgentMode : undefined,
      mcpIds: command.mcpIds?.length ? command.mcpIds : undefined,
      folderName, branchName, branchFrom,
    });
    if (command.access !== undefined) params = { ...params, access: command.access };
  } catch (err) {
    throw invalid('invalid_command', err instanceof Error ? err.message : undefined);
  }
  assertAuthorized();
  let started: Awaited<ReturnType<typeof startDurableCreation>>;
  try {
    started = await startDurableCreation(project.path, params);
  } catch (err) {
    // telemetry-exempt: startDurableCreation records the refusal in its clubhouse.agent.create flow.
    throw new MobileControlError('create_refused', 409, 'rejected', err instanceof Error ? err.message : undefined);
  }
  const { config } = started;
  // Checked above; a new agent has no helpers, so the desktop's service saves it as the Orchestration card would.
  if (orchestration) await writeOrchestration(project.path, config.id, orchestration);
  return {
    agentId: config.id, projectId: project.id, name: config.name,
    branch: config.branch ?? null, worktreePath: config.worktreePath ?? null,
    state: config.creation?.state === 'creating' ? 'creating' as const : 'sleeping' as const,
  };
}

/**
 * agent.update's Access (#3207): a level, checked against what the picker
 * offers for the CLI and runtime the agent will start on, wins over a legacy
 * `freeAgentMode` beside it. The legacy on/off alone keeps the desktop's
 * rules: off always, on only with permission support, and agent-config moves
 * it to the nearest level.
 */
function applyAccess(command: MobileAgentUpdate, config: DurableAgentConfig, projectPath: string, orchestrator: string, updates: DurableConfigUpdates): void {
  if (command.access !== undefined) {
    const runtimeMode = command.runtime === undefined ? config.runtimeMode : command.runtime === 'default' ? undefined : command.runtime;
    // A new CLI can't keep a level it doesn't have, so only the same CLI keeps the saved one.
    const saved = command.orchestrator === undefined || command.orchestrator === config.orchestrator ? agentAccess(config, projectPath) : undefined;
    assertAccess(command.access, orchestrator, nextRuntime(orchestrator, runtimeMode), saved);
    updates.access = command.access;
    return;
  }
  if (command.freeAgentMode === undefined) return;
  // Turning it off is always allowed; on needs a CLI with permission support.
  if (command.freeAgentMode && !permissionsSupported(orchestrator)) throw new MobileControlError('free_agent_mode_unavailable');
  updates.freeAgentMode = command.freeAgentMode;
}

/**
 * agent.update (#2452): the Settings card's rules. Auto-sleep changes at any
 * time; everything else is read at spawn, so it only changes while the agent
 * sleeps. Everything is checked before anything is written.
 */
export async function updateMobileAgent(
  project: MobileAgentProject,
  config: DurableAgentConfig,
  command: MobileAgentUpdate,
  { live, assertAuthorized }: { live: 'running' | 'starting' | undefined; assertAuthorized: () => void },
) {
  const state = stateOf(config, live);
  if (state === 'creating') throw new MobileControlError('agent_creating');
  if (command.persona != null) refusePersona(config.name);
  if (command.clubhouseMode !== undefined) refuseClubhouseMode(config.name);
  const { idleSleep } = command;
  const awake = state === 'running' || state === 'starting';
  // Only the settings themselves: the server passes the whole command, with its version, epoch and id.
  // `persona: null` changes nothing, so it doesn't count.
  if (awake && SPAWN_SETTINGS.some((k) => (k === 'persona' ? command.persona != null : command[k] !== undefined))) throw new MobileControlError('agent_running', 409, 'rejected', LOCKED_DETAIL);

  const identity: { name?: string; color?: string; emoji?: string | null } = {};
  const updates: DurableConfigUpdates = {};
  if (command.name !== undefined) {
    const name = command.name.trim();
    if (!name) throw invalid('invalid_name');
    // An agent with a worktree keeps names that work as a folder and a git branch (#2221).
    if (config.worktreePath) assertGitName(name, 'folder', 'invalid_name');
    identity.name = name;
  }
  if (command.color !== undefined) { assertColor(command.color); identity.color = command.color; }
  if (command.emoji !== undefined) identity.emoji = command.emoji;
  const orchestrator = command.orchestrator
    ?? (config.orchestrator || await resolveOrchestrator(project.path).then((p) => p.id).catch(() => DEFAULT_ORCHESTRATOR));
  if (command.orchestrator !== undefined) {
    assertOrchestrator(command.orchestrator);
    updates.orchestrator = command.orchestrator as DurableConfigUpdates['orchestrator'];
  }
  if (command.model !== undefined) updates.model = command.model;
  if (command.runtime !== undefined) {
    if (command.runtime !== 'default' && !chatAvailable(orchestrator)) throw new MobileControlError('runtime_unavailable');
    updates.runtimeMode = command.runtime === 'default' ? null : command.runtime;
  }
  applyAccess(command, config, project.path, orchestrator, updates);
  if (idleSleep !== undefined) updates.idleSleep = idleSleep === 'inherit' ? null : idleSleep;
  if (command.contextWindow !== undefined) {
    await assertContextWindow(project, orchestrator, command.model ?? (command.orchestrator !== undefined ? undefined : config.model), command.contextWindow);
    updates.contextWindow = command.contextWindow;
  }
  const orchestration = command.orchestration !== undefined ? parseMobileOrchestration(command.orchestration, 'update') : undefined;

  assertAuthorized();
  const hadSession = !!config.lastSessionId;
  const previousChoice = config.contextWindow;
  // First, so a refused policy change (helpers to settle) leaves the other settings unwritten too.
  if (orchestration) await writeOrchestration(project.path, config.id, orchestration);
  if (Object.keys(updates).length > 0) await agentConfig.updateDurableConfig(project.path, config.id, updates);
  if (Object.keys(identity).length > 0) await agentConfig.updateDurable(project.path, config.id, identity);
  const saved = (await agentConfig.getDurableConfig(project.path, config.id)) ?? config;
  return { ...await buildAgentSettings(project, saved, live), ...sessionReset(command, hadSession, saved), ...contextWindowReset(previousChoice, saved, command) };
}

/** Tells the phone a new CLI dropped the agent's session (#2593): the next wake starts a new one. */
function sessionReset(command: MobileAgentUpdate, hadSession: boolean, saved: DurableAgentConfig) {
  return command.orchestrator !== undefined && hadSession && !saved.lastSessionId ? { sessionReset: true as const } : {};
}

/** agent.update fields Settings > Dispatcher doesn't offer (#2535): the same rules as the desktop's IPC guards. */
const DISPATCHER_LOCKED = ['name', 'color', 'emoji', 'persona', 'clubhouseMode', 'orchestration'] as const satisfies ReadonlyArray<keyof MobileAgentUpdate>;

/**
 * agent.update for the Dispatcher: Settings > Dispatcher's rules. CLI, model,
 * runtime, Access and auto-sleep change at any time and apply the
 * next time it starts. A new CLI resets the model to its default, and a model
 * must be one the CLI lists. Everything else is `dispatcher_locked`.
 *
 * With Choose models yourself on (#3191), a phone's CLI, model and context
 * are the pick for talking with you, the job a phone talks to, so they're
 * saved as that pick: the same as the row in Settings > Dispatcher, and
 * never overwritten at its next start.
 */
export async function updateMobileDispatcher(
  project: MobileAgentProject,
  config: DurableAgentConfig,
  command: MobileAgentUpdate,
  { live, assertAuthorized }: { live: 'running' | 'starting' | undefined; assertAuthorized: () => void },
) {
  const locked = DISPATCHER_LOCKED.filter((k) => command[k] !== undefined);
  if (locked.length > 0) {
    throw new MobileControlError('dispatcher_locked', 409, 'rejected', `The Dispatcher's ${locked.join(', ')} can't be changed.`);
  }
  const updates: DurableConfigUpdates = {};
  const current = config.orchestrator
    || await resolveOrchestrator(project.path).then((p) => p.id).catch(() => DEFAULT_ORCHESTRATOR);
  const orchestrator = command.orchestrator ?? current;
  if (command.orchestrator !== undefined && command.orchestrator !== config.orchestrator) {
    // The current CLI stays listed even when it has since been turned off for new agents.
    if (command.orchestrator !== current) assertOrchestrator(command.orchestrator);
    updates.orchestrator = command.orchestrator as DurableConfigUpdates['orchestrator'];
    updates.model = 'default';
  }
  if (command.model !== undefined) {
    if (command.model !== 'default' && !(await modelOptions(project.path, orchestrator)).some((o) => o.id === command.model)) {
      throw invalid('invalid_model', `${command.model} isn't a model this CLI lists.`);
    }
    updates.model = command.model;
  }
  if (command.runtime !== undefined) {
    if (command.runtime !== 'default' && !chatAvailable(orchestrator)) throw new MobileControlError('runtime_unavailable');
    updates.runtimeMode = command.runtime === 'default' ? null : command.runtime;
  }
  applyAccess(command, config, project.path, orchestrator, updates);
  if (command.idleSleep !== undefined) updates.idleSleep = command.idleSleep === 'inherit' ? null : command.idleSleep;
  if (command.contextWindow !== undefined) {
    const model = updates.model ?? config.model;
    await assertContextWindow(project, orchestrator, model, command.contextWindow);
    updates.contextWindow = command.contextWindow;
  }

  assertAuthorized();
  const hadSession = !!config.lastSessionId;
  const previousChoice = config.contextWindow;
  const pick: { provider?: string; model?: string; contextWindow?: string | null } = {};
  if (modelsChosenByHand()) {
    if (updates.orchestrator !== undefined) pick.provider = updates.orchestrator;
    if (command.model !== undefined) pick.model = command.model;
    if (command.contextWindow !== undefined) pick.contextWindow = command.contextWindow;
    delete updates.orchestrator;
    delete updates.model;
    delete updates.contextWindow;
  }
  // The pick first: main checks it against the record, and a refusal leaves everything unwritten.
  if (Object.keys(pick).length > 0) {
    // Loaded here: dispatcher-service is heavy, and imports what imports this module.
    const { setDispatcherModels } = await import('./dispatcher/dispatcher-service');
    try {
      await setDispatcherModels({ role: 'chat', ...pick });
    } catch (err) {
      if (err instanceof MobileControlError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw pick.contextWindow ? invalid('invalid_context_window', message) : invalid('invalid_model', message);
    }
  }
  if (Object.keys(updates).length > 0) await agentConfig.updateDurableConfig(project.path, config.id, updates);
  const saved = (await agentConfig.getDurableConfig(project.path, config.id)) ?? config;
  return { ...await buildAgentSettings(project, saved, live, { dispatcher: true }), ...sessionReset(command, hadSession, saved), ...contextWindowReset(previousChoice, saved, command) };
}
