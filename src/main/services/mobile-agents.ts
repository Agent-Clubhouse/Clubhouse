/**
 * Durable agents from a phone (#2451, #2452): what the New agent page and the
 * Details → Settings card offer, and the agent.create / agent.update mobile
 * commands. Validation and writes go through the same services the desktop
 * uses. A paired phone has full control, Free Agent Mode included (#2462):
 * it can already approve every request one by one.
 */

import type { DurableAgentConfig, DurableConfigUpdates, McpCatalogEntry, StartDurableCreationParams } from '../../shared/types';
import type { MobileAgentCreate, MobileAgentUpdate, MobileSettingEditable } from '../../shared/mobile-control';
import { AGENT_IDLE_SLEEP_MINUTES, normalizeIdleSleep, resolveIdleSleep } from '../../shared/idle-sleep';
import { AGENT_COLORS, generateDurableName } from '../../shared/name-generator';
import { validateAgentGitName } from '../../shared/agent-name';
import * as agentConfig from './agent-config';
import { parseStartCreationParams, personaInjection, startDurableCreation } from './agent-creation';
import { checkAvailability, getAvailableOrchestrators, resolveOrchestrator, resolveProfileEnv } from './agent-system';
import { readDefaultMcps, readMcpCatalog, readProjectAgentDefaults } from './agent-settings-service';
import { listAvailablePersonas } from './materialization-service';
import * as orchestratorSettings from './orchestrator-settings';
import * as profileSettings from './profile-settings';
import { isClubhouseModeEnabled } from './clubhouse-mode-settings';
import { chatIdleSettings } from './chat-idle-settings';
import { isChatEnabled, resolveRuntimeMode } from './chat-runtime-settings';
import { resolveChatDriver } from './agent-runtime/chat-drivers';
import { isChatAgent } from './agent-runtime';
import { getBranchChanges, isInsideGitRepo } from './git-service';
import { MobileControlError } from './mobile-control';
import * as orchestrationPolicy from './orchestration-policy';
import * as orchestrationSettings from './orchestration-settings';
import { isDispatcherEnabled } from './dispatcher/dispatcher-settings';
import {
  ACCESS_LEVELS, MAX_HELPER_LIMIT, ORCHESTRATION_CONTROLS, validateOrchestrationPatch,
  type OrchestrationAccess, type OrchestrationPolicyPatch, type ResolvedOrchestrationPolicy,
} from '../../shared/orchestration-policy';

export interface MobileAgentProject { id: string; path: string }

/** A durable agent's state as a phone needs it for editing. */
export type MobileAgentState = 'creating' | 'failed' | 'starting' | 'running' | 'sleeping';

const DEFAULT_ORCHESTRATOR = 'claude-code';
/** agent.update settings read at spawn: everything but auto-sleep. */
const SPAWN_SETTINGS = ['name', 'color', 'emoji', 'orchestrator', 'model', 'runtime', 'persona', 'clubhouseMode', 'freeAgentMode'] as const satisfies ReadonlyArray<keyof MobileAgentUpdate>;
/** Shown when a spawn setting changes on an awake agent, as on the Settings card. */
const LOCKED_DETAIL = 'Sleep the agent to change these';

export const MOBILE_AGENT_COLORS = AGENT_COLORS.map(({ id, label, hex }) => ({ id, label, hex }));

/** The orchestrators the New agent page offers: the enabled ones, narrowed to the project's profile when it covers any. */
export async function effectiveOrchestrators(projectPath: string) {
  const enabled = orchestratorSettings.getSettings().enabled ?? [DEFAULT_ORCHESTRATOR];
  const all = getAvailableOrchestrators().filter((o) => enabled.includes(o.id));
  const profileId = (await readProjectAgentDefaults(projectPath).catch((): undefined => undefined))?.profileId;
  const profile = profileId ? profileSettings.getProfile(profileId) : undefined;
  if (!profile) return all;
  const inProfile = all.filter((o) => o.id in profile.orchestrators);
  return inProfile.length > 0 ? inProfile : all;
}

const chatAvailable = (orchestrator: string): boolean => isChatEnabled() && !!resolveChatDriver(orchestrator);
/** Free Agent Mode needs a CLI with permission support, as the New agent page and Settings card require. */
const permissionsSupported = (orchestrator: string): boolean =>
  getAvailableOrchestrators().find((o) => o.id === orchestrator)?.capabilities?.permissions ?? false;

async function modelOptions(projectPath: string, orchestrator: string): Promise<Array<{ id: string; label: string }>> {
  try {
    const provider = await resolveOrchestrator(projectPath, orchestrator);
    // A profile can change the CLI's login, and so the models it lists (#2569), as GET_MODEL_OPTIONS passes it.
    const env = await resolveProfileEnv(projectPath, provider.id);
    const options = await provider.getModelOptions(env ? { env } : undefined);
    if (Array.isArray(options) && options.length > 0) return options;
  } catch {
    // telemetry-exempt: the picker falls back to the provider default, as useModelOptions does.
  }
  return [{ id: 'default', label: 'Default' }];
}

/** Orchestrators, models per orchestrator, personas and colours: what both the create form and settings pick from. */
export async function buildAgentOptions(projectPath: string) {
  const orchestrators = await effectiveOrchestrators(projectPath);
  const [rows, personas] = await Promise.all([
    Promise.all(orchestrators.map(async (o) => {
      const [availability, models] = await Promise.all([
        checkAvailability(projectPath, o.id).catch((err: unknown) => ({ available: false, error: err instanceof Error ? err.message : 'unavailable' })),
        modelOptions(projectPath, o.id),
      ]);
      return {
        id: o.id, displayName: o.displayName, shortName: o.shortName, ...(o.badge ? { badge: o.badge } : {}),
        available: availability.available, ...(availability.error ? { unavailableReason: availability.error } : {}),
        // Without permission support the CLI sets access itself; the phone shows "Set by the CLI".
        permissions: o.capabilities?.permissions ?? false,
        chat: chatAvailable(o.id),
        models,
      };
    })),
    listAvailablePersonas(projectPath).catch((): Awaited<ReturnType<typeof listAvailablePersonas>> => []),
  ]);
  return { orchestrators: rows, personas, colors: MOBILE_AGENT_COLORS };
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
 * with null), and the choices the Orchestrate card offers.
 */
export function mobileOrchestration(policy: ResolvedOrchestrationPolicy) {
  const { orchestrate, access, control, maxHelpers, crossProjectHelpers, connectToDispatcher, sources } = policy;
  return {
    orchestrate, access, control, maxHelpers, crossProjectHelpers, connectToDispatcher,
    sources: {
      orchestrate: sources.orchestrate, access: sources.access, control: sources.control, maxHelpers: sources.maxHelpers,
      crossProjectHelpers: sources.crossProjectHelpers, connectToDispatcher: sources.connectToDispatcher,
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
  orchestrate: null, access: null, control: null, maxHelpers: null, crossProjectHelpers: null, connectToDispatcher: null,
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
  // The Orchestrate card offers Connect to Dispatcher only while the Dispatcher is on (#2534); off is always allowed.
  if (patch.connectToDispatcher === true && !isDispatcherEnabled()) {
    throw new MobileControlError('dispatcher_off', 409, 'rejected', 'Turn on the Dispatcher first.');
  }
  return patch;
}

/** Write a policy patch through the desktop's own service; a refused change is a command error. */
async function writeOrchestration(projectPath: string, agentId: string, patch: OrchestrationPolicyPatch): Promise<void> {
  const result = await orchestrationPolicy.setOrchestrationPolicy(projectPath, agentId, patch);
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

/**
 * One agent's settings as the Settings card shows them, each with when it can
 * change (#2452). The Dispatcher's are Settings > Dispatcher's: CLI, model,
 * runtime, Free agent mode and auto-sleep, at any time (they apply the next
 * time it starts); its name, colour, emoji, persona and orchestration never.
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
  const mode = resolveRuntimeMode(orchestrator, config.runtimeMode);
  // Awake, the runtime it runs in; asleep, the one the next wake starts in.
  const runtime = live ? (isChatAgent(config.id) ? 'chat' : 'terminal')
    : mode.mode === 'chat' && resolveChatDriver(orchestrator, mode.driver) ? 'chat' : 'terminal';
  const appMinutes = chatIdleSettings.getSettings().idleTimeoutMinutes;
  const idle = normalizeIdleSleep(config.idleSleep);
  const resolved = resolveIdleSleep(idle, appMinutes);
  const clubhouseProject = !dispatcher && isClubhouseModeEnabled(project.path);
  // The Dispatcher's orchestration settings are locked (#2533), so it has none to show.
  const orchestration = dispatcher ? null : await orchestrationOf(project.path, config);
  return {
    agentId: config.id,
    projectId: project.id,
    ...(dispatcher && { isDispatcher: true as const }),
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
      persona: field(config.persona ?? null, identity),
      clubhouseMode: { ...field(clubhouseProject ? !config.clubhouseModeOverride : null, clubhouseProject ? 'sleeping' : 'never'), projectEnabled: clubhouseProject },
      freeAgentMode: field(!!config.freeAgentMode, permissionsSupported(orchestrator) ? spawn : 'never'),
      // Only chat agents idle-sleep; the value is kept either way.
      idleSleep: { ...field(idle, 'always'), minutes: resolved.minutes, source: resolved.source, applies: runtime === 'chat' },
    },
    /** Changes at any time, as on the Orchestrate card; agent.update's `orchestration`. Null for the Dispatcher. */
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

async function assertOrchestrator(projectPath: string, orchestrator: string): Promise<void> {
  if (!(await effectiveOrchestrators(projectPath)).some((o) => o.id === orchestrator)) throw new MobileControlError('orchestrator_unavailable', 409);
}

async function assertPersona(projectPath: string, persona: string): Promise<void> {
  if (!(await listAvailablePersonas(projectPath)).some((p) => p.id === persona)) throw invalid('unknown_persona');
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
  const orchestrator = command.orchestrator ?? (await effectiveOrchestrators(project.path))[0]?.id ?? DEFAULT_ORCHESTRATOR;
  await assertOrchestrator(project.path, orchestrator);
  if (command.freeAgentMode && !permissionsSupported(orchestrator)) throw new MobileControlError('free_agent_mode_unavailable');
  if (command.persona !== undefined) await assertPersona(project.path, command.persona);
  const orchestration = command.orchestration !== undefined ? parseMobileOrchestration(command.orchestration, 'create') : undefined;
  if (command.mcpIds?.length) {
    const catalog = new Set((await readMcpCatalog(project.path).catch((): McpCatalogEntry[] => [])).map((m) => m.id));
    if (command.mcpIds.some((id) => !catalog.has(id))) throw invalid('unknown_mcp');
  }
  let params: StartDurableCreationParams;
  try {
    params = parseStartCreationParams({
      name, color: command.color, model: command.model, useWorktree, orchestrator, freeAgentMode: command.freeAgentMode,
      mcpIds: command.mcpIds?.length ? command.mcpIds : undefined, persona: command.persona,
      folderName, branchName, branchFrom,
    });
  } catch (err) {
    throw invalid('invalid_command', err instanceof Error ? err.message : undefined);
  }
  assertAuthorized();
  let started: Awaited<ReturnType<typeof startDurableCreation>>;
  try {
    started = await startDurableCreation(project.path, params, personaInjection(project.path, params));
  } catch (err) {
    // telemetry-exempt: startDurableCreation records the refusal in its clubhouse.agent.create flow.
    throw new MobileControlError('create_refused', 409, 'rejected', err instanceof Error ? err.message : undefined);
  }
  const { config } = started;
  // Checked above; a new agent has no helpers, so the desktop's service saves it as the Orchestrate card would.
  if (orchestration) await writeOrchestration(project.path, config.id, orchestration);
  return {
    agentId: config.id, projectId: project.id, name: config.name,
    branch: config.branch ?? null, worktreePath: config.worktreePath ?? null,
    state: config.creation?.state === 'creating' ? 'creating' as const : 'sleeping' as const,
  };
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
  const { idleSleep } = command;
  const awake = state === 'running' || state === 'starting';
  // Only the settings themselves: the server passes the whole command, with its version, epoch and id.
  if (awake && SPAWN_SETTINGS.some((k) => command[k] !== undefined)) throw new MobileControlError('agent_running', 409, 'rejected', LOCKED_DETAIL);

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
    await assertOrchestrator(project.path, command.orchestrator);
    updates.orchestrator = command.orchestrator as DurableConfigUpdates['orchestrator'];
  }
  if (command.model !== undefined) updates.model = command.model;
  if (command.runtime !== undefined) {
    if (command.runtime !== 'default' && !chatAvailable(orchestrator)) throw new MobileControlError('runtime_unavailable');
    updates.runtimeMode = command.runtime === 'default' ? null : command.runtime;
  }
  if (command.persona !== undefined) {
    if (command.persona !== null) await assertPersona(project.path, command.persona);
    updates.persona = command.persona ?? '';
  }
  if (command.clubhouseMode !== undefined) {
    // Only an agent in a Clubhouse mode project can opt out of it.
    if (!isClubhouseModeEnabled(project.path)) throw new MobileControlError('clubhouse_mode_unavailable');
    updates.clubhouseModeOverride = !command.clubhouseMode;
  }
  if (command.freeAgentMode !== undefined) {
    // Turning it off is always allowed; on needs a CLI with permission support.
    if (command.freeAgentMode && !permissionsSupported(orchestrator)) throw new MobileControlError('free_agent_mode_unavailable');
    updates.freeAgentMode = command.freeAgentMode;
  }
  if (idleSleep !== undefined) updates.idleSleep = idleSleep === 'inherit' ? null : idleSleep;
  const orchestration = command.orchestration !== undefined ? parseMobileOrchestration(command.orchestration, 'update') : undefined;

  assertAuthorized();
  const hadSession = !!config.lastSessionId;
  // First, so a refused policy change (helpers to settle) leaves the other settings unwritten too.
  if (orchestration) await writeOrchestration(project.path, config.id, orchestration);
  if (Object.keys(updates).length > 0) await agentConfig.updateDurableConfig(project.path, config.id, updates);
  if (Object.keys(identity).length > 0) await agentConfig.updateDurable(project.path, config.id, identity);
  const saved = (await agentConfig.getDurableConfig(project.path, config.id)) ?? config;
  return { ...await buildAgentSettings(project, saved, live), ...sessionReset(command, hadSession, saved) };
}

/** Tells the phone a new CLI dropped the agent's session (#2593): the next wake starts a new one. */
function sessionReset(command: MobileAgentUpdate, hadSession: boolean, saved: DurableAgentConfig) {
  return command.orchestrator !== undefined && hadSession && !saved.lastSessionId ? { sessionReset: true as const } : {};
}

/** agent.update fields Settings > Dispatcher doesn't offer (#2535): the same rules as the desktop's IPC guards. */
const DISPATCHER_LOCKED = ['name', 'color', 'emoji', 'persona', 'clubhouseMode', 'orchestration'] as const satisfies ReadonlyArray<keyof MobileAgentUpdate>;

/**
 * agent.update for the Dispatcher: Settings > Dispatcher's rules. CLI, model,
 * runtime, Free agent mode and auto-sleep change at any time and apply the
 * next time it starts. A new CLI resets the model to its default, and a model
 * must be one the CLI lists. Everything else is `dispatcher_locked`.
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
    if (command.orchestrator !== current) await assertOrchestrator(project.path, command.orchestrator);
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
  if (command.freeAgentMode !== undefined) {
    if (command.freeAgentMode && !permissionsSupported(orchestrator)) throw new MobileControlError('free_agent_mode_unavailable');
    updates.freeAgentMode = command.freeAgentMode;
  }
  if (command.idleSleep !== undefined) updates.idleSleep = command.idleSleep === 'inherit' ? null : command.idleSleep;

  assertAuthorized();
  const hadSession = !!config.lastSessionId;
  if (Object.keys(updates).length > 0) await agentConfig.updateDurableConfig(project.path, config.id, updates);
  const saved = (await agentConfig.getDurableConfig(project.path, config.id)) ?? config;
  return { ...await buildAgentSettings(project, saved, live, { dispatcher: true }), ...sessionReset(command, hadSession, saved) };
}
