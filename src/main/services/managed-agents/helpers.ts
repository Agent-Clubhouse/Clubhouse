/**
 * Clubhouse-managed helpers (#2899): a helper is built from a template (the
 * one start_helper names, else its orchestrator's helper template, else the
 * app's default helper template), with agent parts added or left out for that
 * helper only. Nothing is saved back.
 */
import type { HelperStartArgs } from '../../../shared/types';
import { CLUBHOUSE_MCP_PART_ID, type ManagedAgentSetup, type ManagedTemplateSettings } from '../../../shared/managed-agents-types';
import type { ManagedAgentsService } from './service';
import { ensureBuiltinsOnceFor } from './builtins-once';
import { appLog } from '../log-service';
import { BUILTIN_BLOCK_IDS, withWorkingIdentity } from './builtins';

export const HELPER_KEEPS_CLUBHOUSE_PART = 'Helpers always keep the Clubhouse MCP part so they can reach their orchestrator.';

/** start_helper's refusal while the person hasn't let orchestrators choose helper templates (#2899, D31). */
export const HELPER_TEMPLATE_CHOICE_OFF =
  'helpers here always use the helper template the person set (yours, else the app\'s default), so template, addParts and removeParts are refused. Leave them out, or ask the person to turn on "Let orchestrators choose helper templates" in Settings › Managed agents › Helpers.';

/**
 * The template a helper starts from when start_helper names none: the
 * orchestrator's own helper template (#2895), else the app's default. One
 * that no longer exists falls back to the app's default.
 */
export async function helperTemplateFor(service: ManagedAgentsService, agentTemplateId: string | undefined): Promise<{ templateId: string; appDefault: string }> {
  const appDefault = await service.defaultHelperTemplateId();
  if (agentTemplateId && agentTemplateId !== appDefault) {
    try {
      await service.getTemplate(agentTemplateId);
      return { templateId: agentTemplateId, appDefault };
    } catch {
      // telemetry-exempt: logged; the helper starts from the app's default helper template.
      appLog('core:managed', 'warn', 'An orchestrator\'s helper template no longer exists; using the default helper template', { meta: { templateId: agentTemplateId } });
    }
  }
  return { templateId: appDefault, appDefault };
}

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
  /** The orchestrator's own helper template (`helperTemplateId`), when it has one. */
  agentTemplateId?: string,
): Promise<ManagedAgentSetup & { templateId: string; settings: ManagedTemplateSettings }> {
  // Every helper's setup uses built-in parts (the Clubhouse MCP part at least), so
  // a start before startup installed them, or after that install failed, waits for them.
  try {
    await ensureBuiltinsOnceFor(service);
  } catch (err) {
    // telemetry-exempt: logged; the checks below refuse the start if a part it needs is missing.
    appLog('core:managed', 'warn', 'Could not install the built-in agent parts before a helper start', { meta: { error: err instanceof Error ? err.message : String(err) } });
  }
  const { templateId: defaultId, appDefault } = await helperTemplateFor(service, agentTemplateId);
  // Off (the default), only the helper template the person set is used. Naming it, or the
  // app's default, is no choice, so that passes.
  const named = args.template !== undefined && args.template !== defaultId && args.template !== appDefault;
  const choosing = named || !!args.addParts?.length || !!args.removeParts?.length;
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
  // checkSetup lets the Clubhouse part through before it is installed (a saved setup always has it),
  // but a helper's setup is built from the built-in parts, so a start whose built-ins didn't install is refused here.
  if (!live[CLUBHOUSE_MCP_PART_ID]) throw new Error('the built-in agent parts aren\'t installed yet. Try again.');
  // A helper works on the branch it was given, so it gets the working Identity (#2902). Swap first, so
  // removeParts and addParts are checked against what the helper gets, and either Identity id names it.
  const working = withWorkingIdentity(base.setup);
  const asWorking = (id: string) => (id === BUILTIN_BLOCK_IDS.identity ? BUILTIN_BLOCK_IDS.identityHelper : id);
  const drop = new Set((args.removeParts ?? []).map(asWorking));
  // A helper reports to its orchestrator through the Clubhouse MCP part.
  if (drop.has(CLUBHOUSE_MCP_PART_ID)) throw new Error(HELPER_KEEPS_CLUBHOUSE_PART);
  const inTemplate = new Set([...working.blocks, ...working.skills, ...working.mcps]);
  for (const id of drop) {
    if (!live[id]) throw new Error(`there is no agent part "${id}" to remove. Call list_agent_parts for ids.`);
    if (!inTemplate.has(id)) throw new Error(`"${live[id].name}" (${id}) isn't in template "${templateId}", so there is nothing to remove.`);
  }
  const setup = {
    blocks: working.blocks.filter((id) => !drop.has(id)),
    skills: working.skills.filter((id) => !drop.has(id)),
    mcps: working.mcps.filter((id) => !drop.has(id)),
  };
  for (const raw of args.addParts ?? []) {
    const id = asWorking(raw);
    const kind = live[id]?.kind;
    const list = kind === 'block' ? setup.blocks : kind === 'skill' ? setup.skills : kind === 'mcp' ? setup.mcps : null;
    if (!list) throw new Error(`there is no agent part "${raw}" to add. Call list_agent_parts for ids.`);
    if (!list.includes(id)) list.push(id);
  }
  if (!setup.mcps.includes(CLUBHOUSE_MCP_PART_ID)) setup.mcps.unshift(CLUBHOUSE_MCP_PART_ID);
  // The same checks a saved setup runs, so a helper is never created with a setup that can't be saved.
  const checked = await service.checkSetup({ ...setup, templateId });
  return { ...checked, templateId, settings: base.settings };
}

/**
 * The model a managed helper starts on when start_helper leaves it out: the
 * helper template's (D52), when it is for the CLI the helper runs on.
 * `runsOn` is that CLI: the one asked for, else the orchestrator's; unknown
 * (undefined) for Auto, which decides later. Nothing when start_helper names
 * a model or a difficulty (a preset picks the model then), or the template
 * says `default` (the CLI's default, so nothing is passed).
 *
 * A template with a CLI gives its model only to a helper on that CLI. A
 * template without one gives it only when `modelFits` says the CLI the helper
 * runs on takes it (start_helper's model check, passed without a warning).
 */
export async function helperTemplateModel(
  settings: ManagedTemplateSettings,
  asked: { model?: string; difficulty?: string },
  runsOn: string | undefined,
  modelFits: (cli: string, model: string) => Promise<boolean>,
): Promise<string | undefined> {
  if (asked.model || asked.difficulty || !settings.model || settings.model === 'default') return undefined;
  if (!runsOn) return undefined;
  if (settings.orchestrator) return settings.orchestrator === runsOn ? settings.model : undefined;
  return (await modelFits(runsOn, settings.model)) ? settings.model : undefined;
}
