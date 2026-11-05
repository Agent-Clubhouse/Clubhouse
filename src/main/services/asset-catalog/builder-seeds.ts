import { getPersonaTemplate } from '../../../renderer/features/personas';
import { stripPersonaFrontMatter } from '../../../shared/persona-pattern';
import { currentSettingsOrigin } from '../settings-audit';
import { AssetCatalogError, installBuiltinAsset, type AssetCatalogStore } from './store';

export const BUILDER_TEMPLATES = [
  { id: 'orchestrator', name: 'Orchestrator' },
  { id: 'project-manager', name: 'Project Manager' },
  { id: 'researcher', name: 'Researcher' },
  { id: 'custom', name: 'Custom' },
] as const;
export const IDENTITY_TEXT = 'You are @@AgentName.\nYour workspace is @@Path.\nYour standby branch is @@StandbyBranch.';
const pending = new WeakMap<AssetCatalogStore, Promise<void>>();

/** Main startup only. Never reads a project or changes the original personas. */
export function seedBuilderTemplates(store: AssetCatalogStore): Promise<void> {
  const origin = currentSettingsOrigin();
  if (origin.surface !== 'system' || origin.actorId) return Promise.reject(new AssetCatalogError('agent_not_permitted'));
  const existing = pending.get(store);
  if (existing) return existing;
  const task = (async () => {
    async function install(assetId: string, kind: 'block' | 'template', name: string, payload: unknown) {
      if ((await store.read()).assets[assetId]) return;
      await installBuiltinAsset(store, { assetId, kind, name, builtinId: assetId, expectedRevision: 0, payload });
    }
    await install('builtin-builder-identity', 'block', 'Identity', { content: IDENTITY_TEXT });
    for (const template of BUILDER_TEMPLATES) {
      const entries = [{ entryId: 'identity', blockId: 'builtin-builder-identity', blockRevision: 1 }];
      if (template.id !== 'custom') {
        const persona = getPersonaTemplate(template.id);
        // All three ship today. Fail explicitly if a future build removes one.
        if (!persona) throw new AssetCatalogError('asset_missing');
        const blockId = `builtin-builder-${template.id}-role`;
        await install(blockId, 'block', `${template.name} role`, { content: stripPersonaFrontMatter(persona.content) });
        entries.push({ entryId: 'role', blockId, blockRevision: 1 });
      }
      await install(`builtin-builder-${template.id}`, 'template', template.name, { entries, subagents: [], skills: [], mcps: [] });
    }
  })();
  pending.set(store, task);
  return task;
}
