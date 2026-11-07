/**
 * What the switch to managed still reads of the retired personas (#2901).
 * Read-only: nothing here applies a persona or writes one.
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
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readProjectAgentDefaults } from '../agent-settings-service';
import { appLog } from '../log-service';
import { readFrontMatterValue, stripFrontMatter } from '../../../shared/front-matter';
import { ORCHESTRATION_DEFAULTS, normalizeOrchestrationConfig, type OrchestrationPolicy, type OrchestrationPolicyConfig } from '../../../shared/orchestration-policy';
import type { DurableAgentConfig } from '../../../shared/types';
import orchestratorText from './builtin-text/orchestrator.md';
import projectManagerText from './builtin-text/project-manager.md';
import groupProjectLeadText from './builtin-text/group-project-lead.md';
import qualityAssuranceText from './builtin-text/quality-assurance.md';
import developerFullMergeText from './builtin-text/developer-full-merge.md';
import developerNoMergeText from './builtin-text/developer-no-merge.md';
import researcherText from './builtin-text/researcher.md';
import codeReviewerText from './builtin-text/code-reviewer.md';
import helperText from './builtin-text/helper.md';

/** The persona whose front matter supplied project-wide orchestration defaults. */
export const LEGACY_ORCHESTRATOR_PERSONA = 'orchestrator';

/**
 * The old built-in personas whose text Clubhouse still ships, as the role
 * blocks (builtins.ts). `ui-lead`, `quality-auditor` and `doc-updater` were
 * dropped, and the Dispatcher's text is its own (dispatcher-instructions.md).
 */
const BUILTIN_PERSONA_BODIES: Readonly<Record<string, string>> = {
  'orchestrator': orchestratorText,
  'project-manager': projectManagerText,
  'group-project-pm': groupProjectLeadText,
  'qa': qualityAssuranceText,
  'executor-merge': developerFullMergeText,
  'executor-pr-only': developerNoMergeText,
  'researcher': researcherText,
  'judge': codeReviewerText,
  'workhorse': helperText,
};

/** The front matter of the built-in personas that had orchestration defaults: only the Orchestrator's. */
const BUILTIN_PERSONA_ORCHESTRATION: Readonly<Record<string, OrchestrationPolicyConfig>> = {
  orchestrator: { orchestrate: true },
};

/** A persona id is a file name: no separators, no `..`, nothing that leaves the personas folder. */
function isPersonaFileName(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..');
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
  const raw = await readOnDiskPersona(projectPath, personaId) ?? BUILTIN_PERSONA_BODIES[personaId];
  return raw === undefined ? undefined : stripFrontMatter(raw);
}

/** One persona's `orchestration:` front matter. A persona can turn Auto off and never on (#2671). */
async function personaOrchestration(projectPath: string, personaId: string): Promise<OrchestrationPolicyConfig | undefined> {
  const raw = await readOnDiskPersona(projectPath, personaId);
  const config = raw !== undefined
    ? normalizeOrchestrationConfig(readFrontMatterValue(raw, 'orchestration'))
    : normalizeOrchestrationConfig(BUILTIN_PERSONA_ORCHESTRATION[personaId]);
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
  return Object.keys(carried).length > 0 ? carried as OrchestrationPolicyConfig : undefined;
}
