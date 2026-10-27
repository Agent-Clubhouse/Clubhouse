/**
 * Durable agents from a phone (#2451, #2452): what the New agent page and the
 * Details → Settings card offer, and the agent.create / agent.update mobile
 * commands. Validation and writes go through the same services the desktop
 * uses; Free Agent Mode is read-only here, since remote commands cannot
 * elevate permissions.
 */

import type { DurableAgentConfig, DurableConfigUpdates, McpCatalogEntry, StartDurableCreationParams } from '../../shared/types';
import type { MobileAgentCreate, MobileAgentUpdate, MobileSettingEditable } from '../../shared/mobile-control';
import { AGENT_IDLE_SLEEP_MINUTES, normalizeIdleSleep, resolveIdleSleep } from '../../shared/idle-sleep';
import { AGENT_COLORS, generateDurableName } from '../../shared/name-generator';
import { validateAgentGitName } from '../../shared/agent-name';
import * as agentConfig from './agent-config';
import { parseStartCreationParams, personaInjection, startDurableCreation } from './agent-creation';
import { checkAvailability, getAvailableOrchestrators, resolveOrchestrator } from './agent-system';
import { readDefaultMcps, readMcpCatalog, readProjectAgentDefaults } from './agent-settings-service';
import { listAvailablePersonas } from './materialization-service';
import * as orchestratorSettings from './orchestrator-settings';
import * as profileSettings from './profile-settings';
import { isClubhouseModeEnabled } from './clubhouse-mode-settings';
import { chatIdleSettings } from './chat-idle-settings';
import { isChatEnabled, resolveRuntimeMode } from './chat-runtime-settings';
import { resolveChatDriver } from './agent-runtime/chat-drivers';
import { isChatAgent } from './agent-runtime';
import { isInsideGitRepo } from './git-service';
import { MobileControlError } from './mobile-control';

export interface MobileAgentProject { id: string; path: string }

/** A durable agent's state as a phone needs it for editing. */
export type MobileAgentState = 'creating' | 'failed' | 'starting' | 'running' | 'sleeping';

const DEFAULT_ORCHESTRATOR = 'claude-code';
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

async function modelOptions(projectPath: string, orchestrator: string): Promise<Array<{ id: string; label: string }>> {
  try {
    const options = await (await resolveOrchestrator(projectPath, orchestrator)).getModelOptions();
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
    freeAgentMode: { allowed: false },
  };
}

function stateOf(config: DurableAgentConfig, live: 'running' | 'starting' | undefined): MobileAgentState {
  if (config.creation?.state === 'creating') return 'creating';
  if (live) return live;
  return config.creation?.state === 'failed' ? 'failed' : 'sleeping';
}

const field = <T>(value: T, editable: MobileSettingEditable) => ({ value, editable });

/** One agent's settings as the Settings card shows them, each with when it can change (#2452). */
export async function buildAgentSettings(project: MobileAgentProject, config: DurableAgentConfig, live: 'running' | 'starting' | undefined) {
  const state = stateOf(config, live);
  const orchestrator = config.orchestrator
    || await resolveOrchestrator(project.path).then((p) => p.id).catch(() => DEFAULT_ORCHESTRATOR);
  const runtimeEditable: MobileSettingEditable = chatAvailable(orchestrator) ? 'sleeping' : 'never';
  const mode = resolveRuntimeMode(orchestrator, config.runtimeMode);
  // Awake, the runtime it runs in; asleep, the one the next wake starts in.
  const runtime = live ? (isChatAgent(config.id) ? 'chat' : 'terminal')
    : mode.mode === 'chat' && resolveChatDriver(orchestrator, mode.driver) ? 'chat' : 'terminal';
  const appMinutes = chatIdleSettings.getSettings().idleTimeoutMinutes;
  const idle = normalizeIdleSleep(config.idleSleep);
  const resolved = resolveIdleSleep(idle, appMinutes);
  const clubhouseProject = isClubhouseModeEnabled(project.path);
  return {
    agentId: config.id,
    projectId: project.id,
    state,
    /** Settings marked `sleeping` can change now. */
    sleeping: state === 'sleeping' || state === 'failed',
    settings: {
      name: field(config.name, 'sleeping'),
      color: field(config.color, 'sleeping'),
      emoji: field(config.emoji ?? null, 'sleeping'),
      hasImageIcon: !!config.icon,
      orchestrator: { ...field(config.orchestrator ?? null, 'sleeping'), resolved: orchestrator },
      model: field(config.model ?? 'default', 'sleeping'),
      runtime: { ...field(config.runtimeMode ?? 'default', runtimeEditable), resolved: runtime },
      persona: field(config.persona ?? null, 'sleeping'),
      clubhouseMode: { ...field(clubhouseProject ? !config.clubhouseModeOverride : null, clubhouseProject ? 'sleeping' : 'never'), projectEnabled: clubhouseProject },
      freeAgentMode: field(!!config.freeAgentMode, 'never'),
      // Only chat agents idle-sleep; the value is kept either way.
      idleSleep: { ...field(idle, 'always'), minutes: resolved.minutes, source: resolved.source, applies: runtime === 'chat' },
    },
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
  if (command.persona !== undefined) await assertPersona(project.path, command.persona);
  if (command.mcpIds?.length) {
    const catalog = new Set((await readMcpCatalog(project.path).catch((): McpCatalogEntry[] => [])).map((m) => m.id));
    if (command.mcpIds.some((id) => !catalog.has(id))) throw invalid('unknown_mcp');
  }
  let params: StartDurableCreationParams;
  try {
    params = parseStartCreationParams({
      name, color: command.color, model: command.model, useWorktree, orchestrator,
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
  const { idleSleep, agentId: _agentId, ...spawnSettings } = command;
  const awake = state === 'running' || state === 'starting';
  if (awake && Object.values(spawnSettings).some((v) => v !== undefined)) throw new MobileControlError('agent_running', 409, 'rejected', LOCKED_DETAIL);

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
  if (idleSleep !== undefined) updates.idleSleep = idleSleep === 'inherit' ? null : idleSleep;

  assertAuthorized();
  if (Object.keys(updates).length > 0) await agentConfig.updateDurableConfig(project.path, config.id, updates);
  if (Object.keys(identity).length > 0) await agentConfig.updateDurable(project.path, config.id, identity);
  const saved = (await agentConfig.getDurableConfig(project.path, config.id)) ?? config;
  return buildAgentSettings(project, saved, live);
}
