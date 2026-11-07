/**
 * What the switch to managed still reads of the retired personas and
 * Clubhouse Mode (#2901). Read-only: nothing here applies a persona, runs
 * Clubhouse Mode or writes either.
 *
 * Clubhouse Mode's settings stay in `<userData>/clubhouse-mode-settings.json`,
 * which nothing writes any more. readLegacyClubhouseModeSettings reads that
 * file as plain JSON, for the automatic switch (D59) and the startup pass's
 * settings migrations (D61, D63), and treats a missing or unreadable file as
 * Clubhouse Mode off. materializedInstructions and materializedDefaults give
 * what Clubhouse Mode would have written at an agent's next wake, so a
 * Clubhouse Mode agent that never woke keeps it when it switches (D58).
 *
 * An unmanaged agent saved before personas were retired may still have a
 * persona id, its own (`agent.persona`) or its project's default
 * (`agentDefaults.persona`). The persona file it names is looked up project
 * (`<project>/.clubhouse/personas/<id>.md`), then user
 * (`~/.clubhouse/personas/<id>.md`), then Clubhouse's built-in text. Its
 * front matter could carry orchestration defaults, and a project or user
 * `orchestrator.md` gave every agent in the project defaults for all fields
 * but `orchestrate` and `connectToDispatcher`. That layer no longer reaches
 * the orchestration policy, so the switch (and, for agents that stay
 * unmanaged, the startup pass, D62) writes what it decided to the agent's
 * own fields first, and the policy resolves the same.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { listSourceSkills, readProjectAgentDefaults, readSourceMissionContent } from '../agent-settings-service';
import { appLog } from '../log-service';
import { readFrontMatterValue, stripFrontMatter } from '../../../shared/front-matter';
import { ORCHESTRATION_DEFAULTS, normalizeOrchestrationConfig, type OrchestrationPolicy, type OrchestrationPolicyConfig } from '../../../shared/orchestration-policy';
import type { DurableAgentConfig, SourceControlProvider } from '../../../shared/types';
import { replaceWildcards, type WildcardContext } from '../../../shared/wildcard-replacer';
import orchestratorText from './builtin-text/orchestrator.md';
import projectManagerText from './builtin-text/project-manager.md';
import groupProjectLeadText from './builtin-text/group-project-lead.md';
import qualityAssuranceText from './builtin-text/quality-assurance.md';
import developerFullMergeText from './builtin-text/developer-full-merge.md';
import developerNoMergeText from './builtin-text/developer-no-merge.md';
import researcherText from './builtin-text/researcher.md';
import codeReviewerText from './builtin-text/code-reviewer.md';
import helperText from './builtin-text/helper.md';
import uiLeadText from './legacy-persona-text/ui-lead.md';
import qualityAuditorText from './legacy-persona-text/quality-auditor.md';
import docUpdaterText from './legacy-persona-text/doc-updater.md';

/** The persona whose front matter supplied project-wide orchestration defaults. */
export const LEGACY_ORCHESTRATOR_PERSONA = 'orchestrator';

/**
 * The old built-in personas' text, by persona id. Most of it Clubhouse still
 * ships as the role blocks (builtins.ts). `ui-lead`, `quality-auditor` and
 * `doc-updater` are no blocks any more: their text is kept here only so an
 * agent that used one keeps it when it switches (legacy-persona-text/). The
 * Dispatcher's text is its own (dispatcher-instructions.md). A Map, so an id
 * like `constructor` finds nothing.
 */
const BUILTIN_PERSONA_BODIES: ReadonlyMap<string, string> = new Map([
  ['orchestrator', orchestratorText],
  ['project-manager', projectManagerText],
  ['group-project-pm', groupProjectLeadText],
  ['qa', qualityAssuranceText],
  ['executor-merge', developerFullMergeText],
  ['executor-pr-only', developerNoMergeText],
  ['researcher', researcherText],
  ['judge', codeReviewerText],
  ['workhorse', helperText],
  ['ui-lead', uiLeadText],
  ['quality-auditor', qualityAuditorText],
  ['doc-updater', docUpdaterText],
]);

/** The front matter of the built-in personas that had orchestration defaults: only the Orchestrator's. */
const BUILTIN_PERSONA_ORCHESTRATION: ReadonlyMap<string, OrchestrationPolicyConfig> = new Map([
  ['orchestrator', { orchestrate: true }],
]);

/**
 * A persona id names a file in the personas folder, as the persona runtime
 * read it: not empty, no path separator, not `..`, no NUL. Anything else is
 * skipped and logged with a code only.
 */
function isPersonaFileName(id: string): boolean {
  const ok = id.length > 0 && id !== '..' && !/[/\\\0]/.test(id);
  if (!ok) appLog('core:managed', 'warn', 'Skipped a legacy persona id that is not a file name', { meta: { code: 'invalid_persona_id' } });
  return ok;
}

async function readPersonaFile(dir: string, id: string): Promise<string | undefined> {
  try {
    const text = await fsp.readFile(path.join(dir, `${id}.md`), 'utf-8');
    return text || undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      // telemetry-exempt: logged; an unreadable file counts as none, as it did for the persona runtime
      appLog('core:managed', 'warn', 'Could not read a legacy persona file', { meta: { personaId: id, error: err instanceof Error ? err.message : String(err) } });
    }
    return undefined;
  }
}

/** The project or user persona file for `id`, front matter included, or undefined when neither has one. */
async function readOnDiskPersona(projectPath: string, id: string): Promise<string | undefined> {
  if (!isPersonaFileName(id)) return undefined;
  return (await readPersonaFile(path.join(projectPath, '.clubhouse', 'personas'), id))
    ?? readPersonaFile(path.join(os.homedir(), '.clubhouse', 'personas'), id);
}

/** The persona an unmanaged agent had: its own, else its project's default. */
export async function legacyPersonaId(projectPath: string, agent: DurableAgentConfig): Promise<string | undefined> {
  if (agent.persona) return agent.persona;
  try {
    return (await readProjectAgentDefaults(projectPath)).persona || undefined;
  } catch {
    // telemetry-exempt: unreadable project defaults mean the agent's own persona only
    return undefined;
  }
}

/**
 * The persona's Markdown, front matter removed: project, then user, then the
 * built-in text. Undefined when none has it. What Clubhouse Mode appended to a
 * persona agent's instructions, so a switch keeps it (materializedInstructions).
 */
export async function legacyPersonaBody(projectPath: string, personaId: string | undefined): Promise<string | undefined> {
  if (!personaId) return undefined;
  const raw = await readOnDiskPersona(projectPath, personaId) ?? BUILTIN_PERSONA_BODIES.get(personaId);
  return raw === undefined ? undefined : stripFrontMatter(raw);
}

/** One persona's `orchestration:` front matter. A persona can turn Auto off and never on (#2671). */
async function personaOrchestration(projectPath: string, personaId: string): Promise<OrchestrationPolicyConfig | undefined> {
  const raw = await readOnDiskPersona(projectPath, personaId);
  const config = raw !== undefined
    ? normalizeOrchestrationConfig(readFrontMatterValue(raw, 'orchestration'))
    : normalizeOrchestrationConfig(BUILTIN_PERSONA_ORCHESTRATION.get(personaId));
  if (config?.autoHelpers === true) delete config.autoHelpers;
  return config;
}

/**
 * The orchestration defaults the persona layer gave an agent: its persona's
 * front matter over the Orchestrator persona's, which never decided
 * `orchestrate` or `connectToDispatcher` for an agent with another persona.
 * Undefined for a managed agent, which never had the layer, or when the layer
 * decides nothing.
 */
export async function legacyPersonaOrchestration(projectPath: string, agent: DurableAgentConfig): Promise<OrchestrationPolicyConfig | undefined> {
  if (agent.managed) return undefined;
  const personaId = await legacyPersonaId(projectPath, agent);
  const own = personaId ? await personaOrchestration(projectPath, personaId) : undefined;
  if (personaId === LEGACY_ORCHESTRATOR_PERSONA) return own;
  const project = await personaOrchestration(projectPath, LEGACY_ORCHESTRATOR_PERSONA);
  if (project) {
    delete project.orchestrate;
    delete project.connectToDispatcher;
  }
  return normalizeOrchestrationConfig({ ...project, ...own });
}

/**
 * The fields the persona layer decided for an agent: set in `layer` and not
 * on the agent itself. Written as its own, they resolve as the layer did.
 * One exception, the old rule (#2671): a persona's Auto `off` beat the
 * agent's own `autoHelpers: true`, so it is carried over that too.
 * Undefined when there are none.
 */
export function orchestrationToCarry(
  own: OrchestrationPolicyConfig | undefined,
  layer: OrchestrationPolicyConfig | undefined,
): OrchestrationPolicyConfig | undefined {
  if (!layer) return undefined;
  const stored = normalizeOrchestrationConfig(own) ?? {};
  const carried: Record<string, unknown> = {};
  for (const key of Object.keys(ORCHESTRATION_DEFAULTS) as Array<keyof OrchestrationPolicy>) {
    if (stored[key] === undefined && layer[key] !== undefined) carried[key] = layer[key];
  }
  if (layer.autoHelpers === false && stored.autoHelpers === true) carried.autoHelpers = false;
  return Object.keys(carried).length > 0 ? carried as OrchestrationPolicyConfig : undefined;
}

// ── Clubhouse Mode ───────────────────────────────────────────────────────

/** The file Clubhouse Mode's settings were saved in, in the app's user data folder. */
export const LEGACY_CLUBHOUSE_MODE_FILE = 'clubhouse-mode-settings.json';

/** What clubhouse-mode-settings.json held. Nothing writes it any more. */
export interface LegacyClubhouseModeSettings {
  enabled: boolean;
  projectOverrides?: Record<string, boolean>;
  /** The app-level source control provider before it moved to source-control-settings.json (D61). */
  sourceControlProvider?: SourceControlProvider;
}

const SOURCE_CONTROL_PROVIDERS: readonly SourceControlProvider[] = ['github', 'azure-devops'];

/**
 * Clubhouse Mode's saved settings, read as plain JSON each time. A missing
 * file, or one that can't be read or parsed, is Clubhouse Mode off with no
 * overrides. Values of the wrong type are left out.
 */
export function readLegacyClubhouseModeSettings(): LegacyClubhouseModeSettings {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(app.getPath('userData'), LEGACY_CLUBHOUSE_MODE_FILE), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      // telemetry-exempt: logged; an unreadable file counts as Clubhouse Mode off
      appLog('core:managed', 'warn', 'Could not read the old Clubhouse Mode settings', { meta: { code: (err as NodeJS.ErrnoException)?.code ?? 'unknown' } });
    }
    return { enabled: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // telemetry-exempt: logged; a file that isn't JSON counts as Clubhouse Mode off
    appLog('core:managed', 'warn', 'The old Clubhouse Mode settings are not valid JSON');
    return { enabled: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { enabled: false };
  const saved = parsed as Record<string, unknown>;
  const out: LegacyClubhouseModeSettings = { enabled: saved.enabled === true };
  if (saved.projectOverrides && typeof saved.projectOverrides === 'object' && !Array.isArray(saved.projectOverrides)) {
    const overrides = Object.entries(saved.projectOverrides as Record<string, unknown>).filter((e): e is [string, boolean] => typeof e[1] === 'boolean');
    if (overrides.length > 0) out.projectOverrides = Object.fromEntries(overrides);
  }
  if (SOURCE_CONTROL_PROVIDERS.includes(saved.sourceControlProvider as SourceControlProvider)) {
    out.sourceControlProvider = saved.sourceControlProvider as SourceControlProvider;
  }
  return out;
}

/** Whether Clubhouse Mode was on for a project (its override, then the app switch), or at app level with no project. */
export function legacyClubhouseModeEnabled(projectPath?: string): boolean {
  const settings = readLegacyClubhouseModeSettings();
  const own = projectPath ? settings.projectOverrides?.[projectPath] : undefined;
  return own ?? settings.enabled;
}

/** The agent's mission, else its project's default. Only Clubhouse Mode filled @@Mission with it. */
export function legacyMissionId(agent: DurableAgentConfig, defaults: { mission?: string }): string | undefined {
  return agent.mission ?? defaults.mission;
}

/**
 * Keep the text of each @@If(value) ... @@EndIf block whose value is the
 * agent's source control provider, and drop the others. Clubhouse Mode did
 * this; managed agents never do (D10).
 */
export function processConditionalBlocks(text: string, sourceControlProvider: string | undefined): string {
  return text.replace(
    /@@If\(([^)]+)\)\s*\n?([\s\S]*?)@@EndIf\s*\n?/g,
    (_match, value: string, content: string) => (sourceControlProvider === value ? content : ''),
  );
}

/** Clubhouse Mode's wildcard pass: the shared wildcards, then @@Mission and @@Persona, then @@If blocks. */
interface ClubhouseModeContext extends WildcardContext {
  mission?: string;
  persona?: string;
}

function resolveClubhouseModeText(text: string, ctx: ClubhouseModeContext): string {
  const filled = replaceWildcards(text, ctx)
    .replace(/@@Mission/g, ctx.mission || '')
    .replace(/@@Persona/g, ctx.persona || '');
  return processConditionalBlocks(filled, ctx.sourceControlProvider);
}

/**
 * The instructions file Clubhouse Mode wrote, or null when it wrote none and
 * left the file as it was. `persona` is a legacy persona's text, added after
 * the template unless the template placed it with @@Persona.
 */
function instructionsToWrite(template: string | undefined, persona: string | undefined, ctx: ClubhouseModeContext): string | null {
  const resolvedPersona = persona ? resolveClubhouseModeText(persona, ctx) : undefined;
  if (template) {
    const resolved = resolveClubhouseModeText(template, ctx);
    return resolvedPersona && !template.includes('@@Persona') ? `${resolved}\n\n${resolvedPersona}` : resolved;
  }
  return resolvedPersona ?? null;
}

/** The project defaults and wildcard context Clubhouse Mode resolved for an agent, with a legacy persona's text for @@Persona. */
async function clubhouseModeResolution(projectPath: string, agent: DurableAgentConfig, persona?: string) {
  // Loaded on use: agent-wildcards reads source-control-settings, which reads this module.
  const { buildWildcardContext, resolveAgentCommands, resolveSourceControlProvider } = await import('../agent-wildcards');
  const defaults = await readProjectAgentDefaults(projectPath);
  const missionId = legacyMissionId(agent, defaults);
  const scp = await resolveSourceControlProvider(projectPath, agent);
  const mission = missionId ? await readSourceMissionContent(projectPath, missionId) : undefined;
  const ctx: ClubhouseModeContext = { ...buildWildcardContext(agent, projectPath, scp, resolveAgentCommands(agent, defaults)), mission, persona };
  return { defaults, ctx };
}

async function legacyPersonaText(projectPath: string, agent: DurableAgentConfig): Promise<string | undefined> {
  return agent.managed ? undefined : legacyPersonaBody(projectPath, await legacyPersonaId(projectPath, agent));
}

/**
 * The instructions file Clubhouse Mode would write for this agent at its next
 * wake, wildcards and @@If blocks resolved, or null when it writes none.
 * Switching a Clubhouse Mode agent to managed keeps this, so one that never
 * woke doesn't bring over the raw project template. An agent that still has a
 * legacy persona keeps that persona's text too, as Clubhouse Mode wrote it.
 */
export async function materializedInstructions(projectPath: string, agent: DurableAgentConfig): Promise<string | null> {
  const persona = await legacyPersonaText(projectPath, agent);
  const { defaults, ctx } = await clubhouseModeResolution(projectPath, agent, persona);
  return instructionsToWrite(defaults.instructions, persona, ctx);
}

/** What Clubhouse Mode delivered besides the instructions file. */
export interface MaterializedDefaults {
  /** The project's source skill folders, which it copied into the worktree, in name order. */
  skills: Array<{ name: string; path: string }>;
  /** The MCP config it wrote, wildcards resolved, or null when it wrote none. Neither parsed nor checked. */
  mcpJson: string | null;
  /** The wildcard replacement it applied to each text file it copied. */
  resolveText: (text: string) => string;
}

/**
 * The skills and MCP servers Clubhouse Mode would deliver to this agent at its
 * next wake. Switching a Clubhouse Mode agent to managed brings these over
 * too, so one that never woke, or whose last materialization failed, still
 * gets the project's defaults.
 */
export async function materializedDefaults(projectPath: string, agent: DurableAgentConfig): Promise<MaterializedDefaults> {
  const persona = await legacyPersonaText(projectPath, agent);
  const { defaults, ctx } = await clubhouseModeResolution(projectPath, agent, persona);
  const skills = (await listSourceSkills(projectPath))
    .map((s) => ({ name: s.name, path: s.path }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const mcpJson = defaults.mcpJson && !agent.clubhouseModeOverride ? resolveClubhouseModeText(defaults.mcpJson, ctx) : null;
  return { skills, mcpJson, resolveText: (text) => resolveClubhouseModeText(text, ctx) };
}
