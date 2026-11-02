/**
 * Scoped settings reads (#2653): the list_settings and read_settings MCP tools
 * sit on this, and it knows nothing about MCP. See docs/settings-read-mcp.md.
 *
 * An allowlist: only the fields named in the catalog below ever come out, each
 * read by name, never by spreading a config. A setting nobody lists doesn't
 * appear. Effective values come from the resolvers the app itself uses.
 *
 * Who can read what:
 * - An agent, helpers included: itself, its own project and `app.defaults`,
 *   which feed its own effective values. Anything else gets one fixed refusal
 *   before any lookup, so it says nothing about what exists.
 * - The running Dispatcher: every agent, every project, all app settings.
 *
 * Reads change nothing: no writes, no gate changes, no wake, no broadcast. So
 * this uses peekDurableConfigs and peekProjects rather than the loading reads,
 * resolveOrchestrationPolicies rather than getOrchestrationPolicy (which can
 * close the tool gate), and never asks a CLI for its models or availability.
 */

import { clubhouseMcpOverride, isDisposedAgent } from '../../shared/agent-helpers';
import { COPILOT_SDK_FLAG } from '../../shared/chat';
import { DISPATCHER_PROJECT_ID } from '../../shared/dispatcher-types';
import { CHAT_IDLE_SETTINGS, MCP_SETTINGS } from '../../shared/settings-definitions';
import type { DurableAgentConfig, Project, ProjectAgentDefaults } from '../../shared/types';
import * as agentConfig from './agent-config';
import { agentRegistry, DEFAULT_ORCHESTRATOR, readProjectOrchestrator } from './agent-registry';
import { readDefaultMcps, readProjectAgentDefaults } from './agent-settings-service';
import { getAvailableOrchestrators } from './agent-system';
import * as annexSettings from './annex-settings';
import { AppearanceError, findOwnProject, findProject } from './appearance-service';
import { chatIdleSettings } from './chat-idle-settings';
import * as chatRuntimeSettings from './chat-runtime-settings';
import * as clubhouseModeSettings from './clubhouse-mode-settings';
import { getDispatcherPath } from './dispatcher/dispatcher-paths';
import { getDispatcherState, isDispatcherAgentId } from './dispatcher/dispatcher-service';
import * as dispatcherSettings from './dispatcher/dispatcher-settings';
import * as freeAgentSettings from './free-agent-settings';
import { appLog } from './log-service';
import { resolveMissionId, resolvePersonaId } from './materialization-service';
import { resolveMcpEnabled, getSettings as getMcpSettings } from './mcp-settings';
import { peekStoredSettings } from './settings-store';
import { buildAgentSettings } from './mobile-agents';
import * as orchestrationSettings from './orchestration-settings';
import * as orchestratorSettings from './orchestrator-settings';
import * as projectStore from './project-store';

/** `uncertain`: the app's settings file couldn't be read, so nothing proves whether the value is saved. */
export type SettingSource = 'agent' | 'project' | 'persona' | 'app' | 'default' | 'uncertain';

export interface SettingValue {
  /** What is saved at this level; null when nothing is. Only with `detail`. */
  stored: unknown;
  /** What applies: what an awake agent runs with, or what the next start uses. */
  effective: unknown;
  /** The level that decided `effective`. */
  source: SettingSource;
  /** Present and false when the setting has no effect on this target. */
  applies?: false;
}

/** Who is asking. The tools say; this enforces. */
export type SettingsActor =
  | { scope: 'own'; agentId: string; projectPath: string }
  | { scope: 'all'; agentId: string };

export type SettingsReadErrorCode = 'out_of_scope' | 'not_found' | 'invalid';

/** A refused read. The message says why, for the caller to show as is. */
export class SettingsReadError extends Error {
  constructor(readonly code: SettingsReadErrorCode, message: string) {
    super(message);
    this.name = 'SettingsReadError';
  }
}

export const MAX_SELECT = 40;
export const MAX_AGENT_IDS = 100;
export const DEFAULT_PAGE = 10;
export const MAX_PAGE = 25;
/** The most JSON one page of targets may hold, however many targets and keys were asked for. */
export const MAX_PAGE_CHARS = 8000;

const OWN_AGENT_ONLY = 'You can read only your own settings.';
const OWN_PROJECT_ONLY = 'You can read only your own project.';

// ── What the app's settings files hold ───────────────────────────────────

const APP_FILES = {
  chatIdle: CHAT_IDLE_SETTINGS.filename,
  chatRuntime: 'chat-runtime-settings.json',
  mcp: MCP_SETTINGS.filename,
  clubhouseMode: 'clubhouse-mode-settings.json',
  freeAgent: 'free-agent-settings.json',
  orchestration: 'orchestration-settings.json',
  orchestrator: 'orchestrator-settings.json',
  experimental: 'experimental-settings.json',
  dispatcher: 'dispatcher-settings.json',
  annex: 'annex-settings.json',
} as const;

type AppFiles = Record<keyof typeof APP_FILES, Awaited<ReturnType<typeof peekStoredSettings>>>;

async function peekAppFiles(): Promise<AppFiles> {
  const names = Object.keys(APP_FILES) as Array<keyof typeof APP_FILES>;
  const contents = await Promise.all(names.map((name) => peekStoredSettings(APP_FILES[name])));
  return Object.fromEntries(names.map((name, i) => [name, contents[i]])) as AppFiles;
}

/**
 * Whether a key is in the file, not what its value looks like: the stores merge
 * their defaults in and save whole, so a value that equals the default may be
 * saved, and one that differs may be a save still queued. `keys` are the current
 * name and any older one the store still migrates.
 */
function savedLevel(file: AppFiles[keyof AppFiles], ...keys: string[]): { stored: unknown; source: SettingSource } {
  if (file === 'unreadable') return { stored: null, source: 'uncertain' };
  if (file === 'missing') return { stored: null, source: 'default' };
  const key = keys.find((k) => k in file);
  return key ? { stored: file[key], source: 'app' } : { stored: null, source: 'default' };
}

// ── The catalog ──────────────────────────────────────────────────────────

interface AppContext {
  files: AppFiles;
}

interface AgentContext extends AppContext {
  path: string;
  config: DurableAgentConfig;
  view: Awaited<ReturnType<typeof buildAgentSettings>>;
  defaults: ProjectAgentDefaults;
  defaultMcps: string[];
  projectOrchestrator: string | undefined;
}

interface ProjectContext extends AppContext {
  project: Project;
  defaults: ProjectAgentDefaults;
  defaultMcps: string[];
  projectOrchestrator: string | undefined;
}

/** A field's read returns undefined where it doesn't apply to this target. */
type Field<C> = readonly [name: string, read: (ctx: C) => SettingValue | undefined];

interface Section<C> {
  name: string;
  /** Only the Dispatcher may read it. */
  dispatcherOnly?: boolean;
  fields: ReadonlyArray<Field<C>>;
}

/** A value only this level holds: unset falls to the default. */
function held(value: unknown, source: SettingSource): SettingValue {
  const present = value !== undefined && value !== null && value !== '';
  return { stored: present ? value : null, effective: present ? value : null, source: present ? source : 'default' };
}

/** An app-level value: what is saved, if anything, and what the app's own getter says applies. */
function appValue(file: AppFiles[keyof AppFiles], key: string | string[], effective: unknown): SettingValue {
  return { ...savedLevel(file, ...[key].flat()), effective };
}

/** Agent over project, as resolvePersonaId and the rest do it. `effective` is the resolver's answer. */
function agentOverProject(own: unknown, project: unknown, effective: unknown): SettingValue {
  const hasOwn = own !== undefined && own !== null;
  const hasProject = project !== undefined && project !== null;
  return { stored: hasOwn ? own : null, effective: effective ?? null, source: hasOwn ? 'agent' : hasProject ? 'project' : 'default' };
}

function clubhouseModeLevel(path: string, { files }: AppContext): SettingSource {
  return clubhouseModeSettings.getSettings().projectOverrides?.[path] !== undefined ? 'project' : savedLevel(files.clubhouseMode, 'enabled').source;
}

function permissionModeLevel(path: string, { files }: AppContext): SettingSource {
  return freeAgentSettings.getSettings().projectOverrides?.[path] ? 'project' : savedLevel(files.freeAgent, 'defaultMode').source;
}

/** resolveMcpEnabled's answer, with its `app` narrowed to the setting that decided it. */
function mcpLevel(path: string | undefined, override: boolean | undefined, ctx: AppContext): { enabled: boolean; source: SettingSource } {
  const { enabled, source } = resolveMcpEnabled(path, override);
  if (source !== 'app') return { enabled, source };
  return { enabled, source: getMcpSettings().enabled ? savedLevel(ctx.files.mcp, 'enabled').source : savedLevel(ctx.files.clubhouseMode, 'enabled').source };
}

function runtimeSource(ctx: AgentContext): SettingSource {
  if (!chatRuntimeSettings.isChatEnabled()) return savedLevel(ctx.files.experimental, chatRuntimeSettings.CHAT_EXPERIMENTAL_FLAG).source;
  if (ctx.config.runtimeMode) return 'agent';
  const providers = ctx.files.chatRuntime;
  if (providers === 'unreadable') return 'uncertain';
  const saved = providers === 'missing' ? undefined : providers[ctx.view.settings.orchestrator.resolved] as { mode?: unknown } | undefined;
  return saved?.mode ? 'app' : 'default';
}

const orchestrationField = (key: keyof NonNullable<AgentContext['view']['orchestration']>['sources'], name: string): Field<AgentContext> => [
  name,
  ({ config, view }) => view.orchestration
    ? { stored: config.orchestration?.[key] ?? null, effective: view.orchestration[key], source: view.orchestration.sources[key] }
    : undefined,
];

const AGENT_SECTIONS: ReadonlyArray<Section<AgentContext>> = [
  {
    name: 'agent.identity',
    fields: [
      ['name', ({ config }) => held(config.name, 'agent')],
      ['color', ({ config }) => held(config.color, 'agent')],
      ['emoji', ({ config }) => held(config.emoji, 'agent')],
      ['has_image', ({ config }) => ({ stored: !!config.icon, effective: !!config.icon, source: config.icon ? 'agent' : 'default' })],
    ],
  },
  {
    name: 'agent.cli',
    fields: [
      ['orchestrator', ({ config, view, projectOrchestrator }) => agentOverProject(config.orchestrator || undefined, projectOrchestrator, view.settings.orchestrator.resolved)],
      ['model', ({ config, view }) => ({
        stored: config.model ?? null,
        effective: view.settings.model.value,
        source: config.model && config.model !== 'default' ? 'agent' : 'default',
      })],
      ['runtime', (ctx) => ({ stored: ctx.config.runtimeMode ?? null, effective: ctx.view.settings.runtime.resolved, source: runtimeSource(ctx) })],
    ],
  },
  {
    name: 'agent.persona',
    fields: [
      ['persona', ({ config, defaults }) => agentOverProject(config.persona, defaults.persona, resolvePersonaId(config, defaults) || null)],
      ['mission', ({ config, defaults }) => agentOverProject(config.mission, defaults.mission, resolveMissionId(config, defaults) || null)],
    ],
  },
  {
    name: 'agent.access',
    fields: [
      ['free_agent_mode', ({ config, view }) => {
        const running = agentRegistry.get(config.id);
        const supported = view.settings.freeAgentMode.editable !== 'never';
        return {
          stored: config.freeAgentMode ?? null,
          effective: running ? running.launchAccess?.freeAgentMode === true : supported && !!config.freeAgentMode,
          source: config.freeAgentMode === undefined ? 'default' : 'agent',
        };
      }],
      ['permission_mode', (ctx) => {
        const saved = freeAgentSettings.getPermissionMode(ctx.path);
        return {
          stored: null,
          effective: agentRegistry.get(ctx.config.id)?.launchAccess?.permissionMode ?? saved,
          source: permissionModeLevel(ctx.path, ctx),
        };
      }],
    ],
  },
  {
    name: 'agent.mcp',
    fields: [
      ['clubhouse_mcp', (ctx) => {
        const { config } = ctx;
        const { enabled, source } = mcpLevel(ctx.path, clubhouseMcpOverride(config), ctx);
        // A helper always gets the bridge, whatever is saved.
        return { stored: config.mcpOverride ?? null, effective: enabled, source: config.parentAgentId ? 'default' : source };
      }],
      ['clubhouse_mode', (ctx) => {
        const projectOn = ctx.view.settings.clubhouseMode.projectEnabled;
        const optedOut = ctx.config.clubhouseModeOverride;
        return {
          stored: optedOut === undefined ? null : !optedOut,
          effective: projectOn && !optedOut,
          source: optedOut !== undefined && projectOn ? 'agent' : clubhouseModeLevel(ctx.path, ctx),
        };
      }],
      ['mcp_ids', ({ config, defaultMcps }) => agentOverProject(config.mcpIds, defaultMcps.length > 0 ? defaultMcps : undefined, config.mcpIds || defaultMcps)],
    ],
  },
  {
    name: 'agent.idle',
    fields: [
      ['idle_sleep', ({ config, view, files }) => ({
        stored: config.idleSleep ?? null,
        effective: view.settings.idleSleep.minutes,
        source: view.settings.idleSleep.source === 'agent' ? 'agent' : savedLevel(files.chatIdle, 'idleTimeoutMinutes').source,
        ...(!view.settings.idleSleep.applies && { applies: false as const }),
      })],
    ],
  },
  {
    name: 'agent.orchestration',
    fields: [
      orchestrationField('orchestrate', 'orchestrate'),
      orchestrationField('access', 'access'),
      orchestrationField('control', 'control'),
      orchestrationField('maxHelpers', 'max_helpers'),
      orchestrationField('crossProjectHelpers', 'cross_project_helpers'),
      orchestrationField('connectToDispatcher', 'connect_to_dispatcher'),
    ],
  },
];

const PROJECT_SECTIONS: ReadonlyArray<Section<ProjectContext>> = [
  {
    name: 'project.identity',
    fields: [
      ['name', ({ project }) => held(project.name, 'project')],
      ['display_name', ({ project }) => held(project.displayName, 'project')],
      ['color', ({ project }) => held(project.color, 'project')],
      ['emoji', ({ project }) => held(project.emoji, 'project')],
      ['has_image', ({ project }) => ({ stored: !!project.icon, effective: !!project.icon, source: project.icon ? 'project' : 'default' })],
    ],
  },
  {
    name: 'project.defaults',
    fields: [
      ['orchestrator', ({ projectOrchestrator }) => ({
        stored: projectOrchestrator ?? null,
        effective: projectOrchestrator ?? DEFAULT_ORCHESTRATOR,
        source: projectOrchestrator ? 'project' : 'default',
      })],
      ['persona', ({ defaults }) => held(defaults.persona, 'project')],
      ['mission', ({ defaults }) => held(defaults.mission, 'project')],
      ['free_agent_mode', ({ defaults }) => held(defaults.freeAgentMode, 'project')],
      ['profile_id', ({ defaults }) => held(defaults.profileId, 'project')],
      ['source_control_provider', ({ defaults }) => held(defaults.sourceControlProvider, 'project')],
      ['default_mcps', ({ defaultMcps }) => ({ stored: defaultMcps, effective: defaultMcps, source: defaultMcps.length > 0 ? 'project' : 'default' })],
    ],
  },
  {
    name: 'project.modes',
    fields: [
      ['clubhouse_mode', (ctx) => ({
        stored: clubhouseModeSettings.getSettings().projectOverrides?.[ctx.project.path] ?? null,
        effective: clubhouseModeSettings.isClubhouseModeEnabled(ctx.project.path),
        source: clubhouseModeLevel(ctx.project.path, ctx),
      })],
      ['mcp', (ctx) => {
        const { enabled, source } = mcpLevel(ctx.project.path, undefined, ctx);
        return { stored: getMcpSettings().projectOverrides?.[ctx.project.path] ?? null, effective: enabled, source };
      }],
      ['permission_mode', (ctx) => ({
        stored: freeAgentSettings.getSettings().projectOverrides?.[ctx.project.path] ?? null,
        effective: freeAgentSettings.getPermissionMode(ctx.project.path),
        source: permissionModeLevel(ctx.project.path, ctx),
      })],
    ],
  },
];

const chatFlag = chatRuntimeSettings.CHAT_EXPERIMENTAL_FLAG;

const APP_SECTIONS: ReadonlyArray<Section<AppContext>> = [
  {
    name: 'app.defaults',
    fields: [
      ['idle_timeout_minutes', ({ files }) => appValue(files.chatIdle, 'idleTimeoutMinutes', chatIdleSettings.getSettings().idleTimeoutMinutes)],
      ['chat_enabled', ({ files }) => appValue(files.experimental, chatFlag, chatRuntimeSettings.isChatEnabled())],
      ['provider_runtime', ({ files }) => {
        const saved = chatRuntimeSettings.getSettings();
        const stored: Record<string, string> = {};
        const effective: Record<string, string> = {};
        for (const { id } of getAvailableOrchestrators()) {
          const mode = saved[id]?.mode;
          if (mode) stored[id] = mode;
          effective[id] = chatRuntimeSettings.resolveRuntimeMode(id).mode;
        }
        if (files.chatRuntime === 'unreadable') return { stored: null, effective, source: 'uncertain' };
        return { stored, effective, source: Object.keys(stored).length > 0 ? 'app' : 'default' };
      }],
      ['mcp_enabled', ({ files }) => appValue(files.mcp, 'enabled', resolveMcpEnabled().enabled)],
      ['clubhouse_mode_enabled', ({ files }) => appValue(files.clubhouseMode, 'enabled', clubhouseModeSettings.getSettings().enabled)],
      ['permission_mode', ({ files }) => appValue(files.freeAgent, 'defaultMode', freeAgentSettings.getSettings().defaultMode)],
      ['global_helper_cap', ({ files }) => {
        const effective = orchestrationSettings.getGlobalHelperCap();
        const value = appValue(files.orchestration, 'globalHelperCap', effective);
        // The store drops an invalid saved cap for the default.
        return value.source === 'app' && value.stored !== effective ? { ...value, source: 'default' } : value;
      }],
      ['enabled_orchestrators', ({ files }) => appValue(files.orchestrator, 'enabled', orchestratorSettings.getSettings().enabled ?? [DEFAULT_ORCHESTRATOR])],
    ],
  },
  {
    name: 'app.system',
    dispatcherOnly: true,
    fields: [
      ['dispatcher_enabled', ({ files }) => appValue(files.dispatcher, 'enabled', dispatcherSettings.isDispatcherEnabled())],
      ['experimental_chat', ({ files }) => appValue(files.experimental, chatFlag, chatRuntimeSettings.isChatEnabled())],
      ['experimental_copilot_sdk', ({ files }) => appValue(files.experimental, COPILOT_SDK_FLAG, chatRuntimeSettings.isCopilotSdkEnabled())],
      ['experimental_dispatcher', ({ files }) => appValue(files.experimental, dispatcherSettings.DISPATCHER_FLAG, dispatcherSettings.isDispatcherFlagOn())],
      ['annex_server_enabled', ({ files }) => appValue(files.annex, ['enableServer', 'enabled'], annexSettings.getSettings().enableServer)],
      ['annex_client_enabled', ({ files }) => appValue(files.annex, ['enableClient', 'enabled'], annexSettings.getSettings().enableClient)],
    ],
  },
];

function visible<C>(sections: ReadonlyArray<Section<C>>, actor: SettingsActor): ReadonlyArray<Section<C>> {
  return sections.filter((s) => !s.dispatcherOnly || actor.scope === 'all');
}

/**
 * Discovery: the sections and keys this actor can read now, and nothing else.
 * An agent with no saved config has no agent.* to read; one outside a
 * registered project has no project.*.
 */
export async function listSettings(actor: SettingsActor): Promise<{ sections: Array<{ section: string; keys: string[] }> }> {
  const describe = <C>(sections: ReadonlyArray<Section<C>>) =>
    visible(sections, actor).map((s) => ({ section: s.name, keys: s.fields.map(([name]) => `${s.name}.${name}`) }));
  let hasAgent = true;
  let hasProject = true;
  if (actor.scope === 'own') {
    hasAgent = (await agentConfig.peekDurableConfigs(actor.projectPath)).some((a) => a.id === actor.agentId && !isDisposedAgent(a));
    hasProject = !!await findOwnProject(await projectStore.peekProjects(), actor.projectPath);
  }
  return {
    sections: [...(hasAgent ? describe(AGENT_SECTIONS) : []), ...(hasProject ? describe(PROJECT_SECTIONS) : []), ...describe(APP_SECTIONS)],
  };
}

/** `select` narrowed to one target's fields, as full keys. An entry names a section or a key. */
function pick<C>(sections: ReadonlyArray<Section<C>>, select: ReadonlySet<string>, used: Set<string>): Array<{ key: string; read: Field<C>[1] }> {
  const picked: Array<{ key: string; read: Field<C>[1] }> = [];
  for (const section of sections) {
    const whole = select.has(section.name);
    if (whole) used.add(section.name);
    for (const [name, read] of section.fields) {
      const key = `${section.name}.${name}`;
      if (select.has(key)) used.add(key);
      if (whole || select.has(key)) picked.push({ key, read });
    }
  }
  return picked;
}

/** A value as it goes out: compact unless the caller asked for detail. */
function shown({ stored, ...compact }: SettingValue, detail: boolean | undefined) {
  return detail ? { stored, ...compact } : compact;
}

function readFields<C>(fields: Array<{ key: string; read: Field<C>[1] }>, ctx: C, detail: boolean | undefined) {
  const settings: Record<string, ReturnType<typeof shown>> = {};
  const notApplicable: string[] = [];
  for (const { key, read } of fields) {
    const value = read(ctx);
    if (value) settings[key] = shown(value, detail);
    else notApplicable.push(key);
  }
  return { settings, ...(notApplicable.length > 0 && { not_applicable: notApplicable }) };
}

/** One target too big for a page on its own: as many of its settings as fit, naming the rest. */
function truncateRow(row: Record<string, unknown>): Record<string, unknown> {
  const settings = { ...row.settings as Record<string, unknown> };
  const omitted: string[] = [];
  const size = () => JSON.stringify({ ...row, settings, truncated: true, omitted }).length;
  const keys = Object.keys(settings);
  while (keys.length > 0 && size() > MAX_PAGE_CHARS) {
    const key = keys.pop()!;
    delete settings[key];
    omitted.unshift(key);
  }
  return { ...row, settings, truncated: true, omitted };
}

// ── Reading ──────────────────────────────────────────────────────────────

export interface ReadSettingsRequest {
  select: string[];
  agentIds?: string[];
  project?: string;
  allAgents?: boolean;
  allProjects?: boolean;
  limit?: number;
  cursor?: string;
  /** Add stored values, and each agent's name and project. */
  detail?: boolean;
}

interface Located { project: { id: string; path: string }; config: DurableAgentConfig }

async function readAgentTarget({ project, config }: Located, fields: ReturnType<typeof pick<AgentContext>>, files: AppFiles, detail: boolean | undefined) {
  const dispatcher = isDispatcherAgentId(config.id);
  const [view, defaults, defaultMcps, projectOrchestrator] = await Promise.all([
    buildAgentSettings(project, config, agentRegistry.get(config.id) ? 'running' : undefined, { dispatcher }),
    readProjectAgentDefaults(project.path),
    readDefaultMcps(project.path),
    readProjectOrchestrator(project.path),
  ]);
  return {
    target: 'agent' as const, id: config.id,
    ...(detail && { name: config.name, project_id: project.id }),
    ...readFields(fields, { files, path: project.path, config, view, defaults, defaultMcps, projectOrchestrator }, detail),
  };
}

async function readProjectTarget(project: Project, fields: ReturnType<typeof pick<ProjectContext>>, files: AppFiles, detail: boolean | undefined) {
  const [defaults, defaultMcps, projectOrchestrator] = await Promise.all([
    readProjectAgentDefaults(project.path),
    readDefaultMcps(project.path),
    readProjectOrchestrator(project.path),
  ]);
  return { target: 'project' as const, id: project.id, ...readFields(fields, { files, project, defaults, defaultMcps, projectOrchestrator }, detail) };
}

/** Whether `ref` names this project, by id, name or path. Never looks at any other project. */
async function namesProject(project: Project, ref: string): Promise<boolean> {
  return ref === project.id || ref === (project.displayName || project.name) || agentConfig.isSameProject(project.path, ref);
}

/** Find an agent for the Dispatcher: its own folder, or where it runs, or the registered projects in turn. */
async function locateAgent(id: string, projects: Project[], only: Project | undefined): Promise<Located | null> {
  if (!only && isDispatcherAgentId(id)) {
    const path = getDispatcherPath();
    const config = (await agentConfig.peekDurableConfigs(path)).find((a) => a.id === id) ?? getDispatcherState().config;
    return config ? { project: { id: DISPATCHER_PROJECT_ID, path }, config } : null;
  }
  const runningIn = agentRegistry.get(id)?.projectPath;
  const ordered = only ? [only] : [...projects].sort((a, b) => Number(b.path === runningIn) - Number(a.path === runningIn));
  for (const project of ordered) {
    const config = (await agentConfig.peekDurableConfigs(project.path)).find((a) => a.id === id);
    if (config && !isDisposedAgent(config)) return { project, config };
  }
  return null;
}

function pageOf(limit: number | undefined, cursor: string | undefined): { offset: number; size: number } {
  const size = limit ?? DEFAULT_PAGE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE) throw new SettingsReadError('invalid', `limit must be a whole number from 1 to ${MAX_PAGE}.`);
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) throw new SettingsReadError('invalid', 'That cursor isn\'t one read_settings returned.');
  return { offset, size };
}

/** One page of targets, each with the selected settings. Throws SettingsReadError for a refused read. */
export async function readSettings(actor: SettingsActor, request: ReadSettingsRequest) {
  const { select, agentIds, project: projectRef, allAgents, allProjects, detail } = request;
  // The scope comes first, so a refusal doesn't depend on what else was asked or what exists.
  if (actor.scope === 'own') {
    if (allAgents || agentIds?.some((id) => id !== actor.agentId)) throw new SettingsReadError('out_of_scope', OWN_AGENT_ONLY);
    if (allProjects) throw new SettingsReadError('out_of_scope', OWN_PROJECT_ONLY);
  }

  if (select.length === 0 || select.length > MAX_SELECT) throw new SettingsReadError('invalid', `select takes 1 to ${MAX_SELECT} sections or keys. list_settings shows them.`);
  if (agentIds && agentIds.length > MAX_AGENT_IDS) throw new SettingsReadError('invalid', `agent_ids takes at most ${MAX_AGENT_IDS} ids.`);
  const { offset, size } = pageOf(request.limit, request.cursor);

  const wanted = new Set(select);
  const used = new Set<string>();
  const agentFields = pick(visible(AGENT_SECTIONS, actor), wanted, used);
  const projectFields = pick(visible(PROJECT_SECTIONS, actor), wanted, used);
  const appFields = pick(visible(APP_SECTIONS, actor), wanted, used);
  // Dispatcher-only keys read as unknown to everyone else, so the two refusals are the same.
  const unknown = select.filter((entry) => !used.has(entry));
  if (unknown.length > 0) throw new SettingsReadError('invalid', `Unknown setting: ${unknown.join(', ')}. list_settings shows what you can read.`);
  if ((agentIds || allAgents) && agentFields.length === 0) throw new SettingsReadError('invalid', 'agent_ids and all_agents need an agent.* entry in select.');
  if (allProjects && projectFields.length === 0) throw new SettingsReadError('invalid', 'all_projects needs a project.* entry in select.');
  if (allAgents && !projectRef) throw new SettingsReadError('invalid', 'all_agents needs a project.');

  const [projects, files] = await Promise.all([projectStore.peekProjects(), peekAppFiles()]);
  const needsProject = projectRef !== undefined || (projectFields.length > 0 && !allProjects);

  let named: Project | undefined;
  if (actor.scope === 'own') {
    if (needsProject) {
      const own = await findOwnProject(projects, actor.projectPath);
      if (projectRef !== undefined && !(own && await namesProject(own, projectRef))) throw new SettingsReadError('out_of_scope', OWN_PROJECT_ONLY);
      if (!own) throw new SettingsReadError('not_found', 'You aren\'t in a registered project.');
      named = own;
    }
  } else if (projectRef !== undefined) {
    named = await findProject(projects, projectRef).catch((err: unknown) => {
      if (err instanceof AppearanceError) throw new SettingsReadError(err.code === 'ambiguous_project' ? 'invalid' : 'not_found', err.message);
      throw err;
    });
  } else if (needsProject) {
    throw new SettingsReadError('invalid', 'Say which project, or set all_projects.');
  }

  // Every target as a promise-free thunk, so only the page asked for is read.
  const targets: Array<() => Promise<unknown>> = [];
  if (appFields.length > 0) targets.push(async () => ({ target: 'app', ...readFields(appFields, { files }, detail) }));
  if (projectFields.length > 0) {
    for (const project of allProjects ? projects : [named!]) targets.push(() => readProjectTarget(project, projectFields, files, detail));
  }
  if (agentFields.length > 0) {
    if (actor.scope === 'own') {
      const config = (await agentConfig.peekDurableConfigs(actor.projectPath)).find((a) => a.id === actor.agentId);
      if (!config || isDisposedAgent(config)) throw new SettingsReadError('not_found', 'Only durable agents have saved settings.');
      const project = (await findOwnProject(projects, actor.projectPath)) ?? { id: '', path: actor.projectPath };
      targets.push(() => readAgentTarget({ project, config }, agentFields, files, detail));
    } else if (allAgents) {
      for (const config of await agentConfig.peekDurableConfigs(named!.path)) {
        if (!isDisposedAgent(config)) targets.push(() => readAgentTarget({ project: named!, config }, agentFields, files, detail));
      }
    } else {
      for (const id of new Set(agentIds ?? [actor.agentId])) {
        targets.push(async () => {
          const located = await locateAgent(id, projects, named);
          return located ? readAgentTarget(located, agentFields, files, detail) : { target: 'agent', id, error: 'not_found' };
        });
      }
    }
  }

  // One at a time, stopping at the cap: what doesn't fit isn't read, and the cursor comes back to it.
  const rows: unknown[] = [];
  let chars = 0;
  let next = offset;
  for (const read of targets.slice(offset, offset + size)) {
    let row: Record<string, unknown>;
    try {
      row = await read() as Record<string, unknown>;
    } catch (err) {
      // telemetry-exempt: logged; one unreadable target must not hide the others
      appLog('core:mcp', 'warn', 'Could not read a target\'s settings', { meta: { error: err instanceof Error ? err.message : String(err) } });
      row = { error: 'unreadable' };
    }
    let length = JSON.stringify(row).length;
    if (chars + length > MAX_PAGE_CHARS) {
      if (rows.length > 0) break;
      row = truncateRow(row);
      length = JSON.stringify(row).length;
    }
    rows.push(row);
    chars += length;
    next++;
  }
  return { targets: rows, total: targets.length, ...(next < targets.length && { next_cursor: String(next) }) };
}
