/**
 * Clubhouse-managed helpers (#2899): a helper is built from a template (the
 * one start_helper names, or the app's default helper template), with agent
 * parts added or left out for that helper only. Nothing is saved back.
 */
import type { HelperStartArgs } from '../../../shared/types';
import type { ManagedAgentsService } from './service';

export async function managedHelperSetup(
  service: ManagedAgentsService,
  args: Pick<HelperStartArgs, 'template' | 'addParts' | 'removeParts'>,
): Promise<{ blocks: string[]; skills: string[]; mcps: string[]; templateId: string }> {
  const templateId = args.template ?? await service.defaultHelperTemplateId();
  let base;
  try {
    base = await service.setupFromTemplate(templateId);
  } catch {
    // telemetry-exempt: refused to the orchestrator as the start's reason.
    throw new Error(`there is no template "${templateId}". Call list_agent_templates, or leave template out for the default helper template.`);
  }
  const drop = new Set(args.removeParts ?? []);
  const setup = {
    blocks: base.setup.blocks.filter((id) => !drop.has(id)),
    skills: base.setup.skills.filter((id) => !drop.has(id)),
    mcps: base.setup.mcps.filter((id) => !drop.has(id)),
    templateId,
  };
  if (args.addParts?.length) {
    const live = await service.liveEntries();
    for (const id of args.addParts) {
      const kind = live[id]?.kind;
      const list = kind === 'block' ? setup.blocks : kind === 'skill' ? setup.skills : kind === 'mcp' ? setup.mcps : null;
      if (!list) throw new Error(`there is no agent part "${id}". Call list_agent_parts for ids.`);
      if (!list.includes(id)) list.push(id);
    }
  }
  return setup;
}
