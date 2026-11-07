/**
 * Clubhouse-managed helpers (#2899): a helper is built from a template (the
 * one start_helper names, or the app's default helper template), with agent
 * parts added or left out for that helper only. Nothing is saved back.
 */
import type { HelperStartArgs } from '../../../shared/types';
import { CLUBHOUSE_MCP_PART_ID, type ManagedAgentSetup, type ManagedTemplateSettings } from '../../../shared/managed-agents-types';
import type { ManagedAgentsService } from './service';

export const HELPER_KEEPS_CLUBHOUSE_PART = 'Helpers always keep the Clubhouse MCP part so they can reach their orchestrator.';

/** start_helper's refusal while the person hasn't let orchestrators choose helper templates (#2899, D31). */
export const HELPER_TEMPLATE_CHOICE_OFF =
  'helpers here always use the default helper template, so template, addParts and removeParts are refused. Leave them out, or ask the person to turn on "Let orchestrators choose helper templates" in Settings › Managed agents › Helpers.';

/**
 * The setup a helper starts with. Throws, before anything is created, when the
 * template or a part id is unknown, a removed part isn't in the template, the
 * Clubhouse MCP part is removed, or the result fails the checks a saved setup
 * must pass (such as two skills with one folder name). Also throws when the
 * call names another template or changes parts while the person hasn't let
 * orchestrators choose helper templates.
 */
export async function managedHelperSetup(
  service: ManagedAgentsService,
  args: Pick<HelperStartArgs, 'template' | 'addParts' | 'removeParts'>,
): Promise<ManagedAgentSetup & { templateId: string; settings: ManagedTemplateSettings }> {
  const defaultId = await service.defaultHelperTemplateId();
  // Off (the default), only the default helper template is used. Naming it is no choice, so that passes.
  const choosing = (args.template !== undefined && args.template !== defaultId) || !!args.addParts?.length || !!args.removeParts?.length;
  if (choosing && !(await service.helperTemplateChoice())) throw new Error(HELPER_TEMPLATE_CHOICE_OFF);
  const templateId = args.template ?? defaultId;
  let base;
  try {
    base = await service.setupFromTemplate(templateId);
  } catch {
    // telemetry-exempt: refused to the orchestrator as the start's reason.
    throw new Error(`there is no template "${templateId}". Call list_agent_templates, or leave template out for the default helper template.`);
  }
  const live = await service.liveEntries();
  const drop = new Set(args.removeParts ?? []);
  // A helper reports to its orchestrator through the Clubhouse MCP part.
  if (drop.has(CLUBHOUSE_MCP_PART_ID)) throw new Error(HELPER_KEEPS_CLUBHOUSE_PART);
  const inTemplate = new Set([...base.setup.blocks, ...base.setup.skills, ...base.setup.mcps]);
  for (const id of drop) {
    if (!live[id]) throw new Error(`there is no agent part "${id}" to remove. Call list_agent_parts for ids.`);
    if (!inTemplate.has(id)) throw new Error(`"${live[id].name}" (${id}) isn't in template "${templateId}", so there is nothing to remove.`);
  }
  const setup = {
    blocks: base.setup.blocks.filter((id) => !drop.has(id)),
    skills: base.setup.skills.filter((id) => !drop.has(id)),
    mcps: base.setup.mcps.filter((id) => !drop.has(id)),
  };
  for (const id of args.addParts ?? []) {
    const kind = live[id]?.kind;
    const list = kind === 'block' ? setup.blocks : kind === 'skill' ? setup.skills : kind === 'mcp' ? setup.mcps : null;
    if (!list) throw new Error(`there is no agent part "${id}" to add. Call list_agent_parts for ids.`);
    if (!list.includes(id)) list.push(id);
  }
  if (!setup.mcps.includes(CLUBHOUSE_MCP_PART_ID)) setup.mcps.unshift(CLUBHOUSE_MCP_PART_ID);
  // The same checks a saved setup runs, so a helper is never created with a setup that can't be saved.
  const checked = await service.checkSetup({ ...setup, templateId });
  return { ...checked, templateId, settings: base.settings };
}

/**
 * The model a managed helper starts on when start_helper leaves it out: the
 * helper template's (D52). Only when the template's model is for the CLI the
 * helper runs on: no CLI asked for and none in the template, or the same one
 * asked for, or none asked for and the template's CLI is the orchestrator's.
 * `default` means the CLI's default, so it sets nothing.
 */
export function helperTemplateModel(
  settings: ManagedTemplateSettings,
  asked: { cli?: string; model?: string },
  orchestratorCli: string | undefined,
): string | undefined {
  if (asked.model || !settings.model || settings.model === 'default') return undefined;
  const templateCli = settings.orchestrator;
  if (!templateCli) return asked.cli ? undefined : settings.model;
  if (asked.cli) return asked.cli === templateCli ? settings.model : undefined;
  return orchestratorCli === templateCli ? settings.model : undefined;
}
