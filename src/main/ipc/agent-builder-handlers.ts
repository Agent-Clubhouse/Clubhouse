import { previewNewAgentComposition, discardNewAgentComposition } from '../services/new-agent-composition-drafts';
import { renameSync } from 'node:fs';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { BuilderCommand, BuilderResult } from '../../shared/agent-builder-types';
import { peekDurableConfigs } from '../services/agent-config';
import { createAgentBuilder, builderSnapshotAdoption, BuilderUnsupportedCompositionError } from '../services/asset-catalog/builder';
import { seedBuilderTemplates } from '../services/asset-catalog/builder-seeds';
import { composeInstructions } from '../services/asset-catalog/composer';
import { AssetCatalogError, assetCatalogDir, createAssetCatalogStore, type AssetCatalogStore } from '../services/asset-catalog/store';
import { registeredSkillBundleContext } from '../services/catalog-skill-bundles';
import { peekProjects } from '../services/project-store';
import { withAgentTransition } from '../services/agent-transition';
import { currentSettingsOrigin } from '../services/settings-audit';
import { arrayArg, booleanArg, numberArg, objectArg, stringArg, withValidatedArgs, type ArgValidator } from './validation';

/** Validate the complete command without ever including supplied text in errors. */
export const builderCommandArg: ArgValidator<BuilderCommand> = (value, label) => {
  const raw = objectArg<Record<string, unknown>>()(value, label);
  const type = stringArg()(raw.type, 'command type');
  const fields: Record<string, string[]> = {
    template: ['templateId', 'confirm', 'binding', 'acknowledgeOperationalIncreases'], order: ['keys'], baseOrder: [], append: ['name', 'content'],
    skill: ['assetId', 'expectedRevision', 'confirm', 'fingerprint'], removeSkill: ['assetId', 'confirm', 'fingerprint'],
    fork: ['key'], return: ['key'], edit: ['key', 'content'], remove: ['key'],
  };
  if (!Object.prototype.hasOwnProperty.call(fields, type) || Object.keys(raw).some((key) => key !== 'type' && !fields[type].includes(key))) throw new Error('Invalid builder command');
  for (const key of fields[type]) {
    if (key === 'expectedRevision') numberArg({ integer: true, min: 1 })(raw[key], key);
    else if (key === 'fingerprint') stringArg({ optional: true, maxLength: 64 })(raw[key], key);
    else if (key === 'binding') {
      if (raw[key] !== undefined) {
        const binding = objectArg<Record<string, unknown>>()(raw[key], 'binding');
        if (Object.keys(binding).length !== 3) throw new Error('Invalid builder binding');
        for (const field of ['fromFingerprint', 'toFingerprint', 'instanceFingerprint']) stringArg({ maxLength: 64 })(binding[field], 'fingerprint');
      }
    } else if (key === 'acknowledgeOperationalIncreases') booleanArg({ optional: true })(raw[key], key);
    else if (key === 'keys') arrayArg(stringArg({ maxLength: 256 }), { maxLength: 256 })(raw[key], 'order');
    else if (key === 'confirm') booleanArg()(raw[key], 'confirm');
    else stringArg({ minLength: key === 'content' ? 0 : 1, maxLength: key === 'content' ? 256 * 1024 : 256 })(raw[key], key);
  }
  return raw as unknown as BuilderCommand;
};

export function registerAgentBuilderHandlers(injectedStore?: AssetCatalogStore): void {
  const seedStore = injectedStore ?? createAssetCatalogStore({ dir: assetCatalogDir() });
  // Starts on the main/system surface, before any renderer request. A failed
  // seed is visible in the Builder; its payload never goes into telemetry.
  const ready = seedBuilderTemplates(seedStore).then(() => true, () => false);
  async function perform(projectPath: string, agentId: string, action?: BuilderCommand, revision?: number): Promise<BuilderResult> {
    try {
      if (!await ready) return { ok: false, code: 'failed' };
      const origin = currentSettingsOrigin();
      if (origin.surface !== 'ui' || origin.actorId) return { ok: false, code: 'failed' };
      return await withAgentTransition(agentId, async () => {
        const project = (await peekProjects()).find((candidate) => candidate.path === projectPath);
        if (!project) return { ok: false as const, code: 'failed' as const };
        const guard = await registeredSkillBundleContext({ projectId: project.id, agentId }, projectPath);
        // Peek never repairs agents.json or settles creations.
        const agent = (await peekDurableConfigs(projectPath)).find((candidate) => candidate.id === agentId);
        if (!agent || agent.persona === 'dispatcher') return { ok: false as const, code: 'failed' as const };
        const store = injectedStore ?? createAssetCatalogStore({ dir: assetCatalogDir(), rename: async (from, to) => { guard(); renameSync(from, to); } });
        const builder = createAgentBuilder(store, project.id);
        const adoption = await builderSnapshotAdoption(store, await builder.compositionOf(agentId));
        const view = action ? await builder.command(agentId, revision!, action, adoption) : await builder.read(agentId, adoption);
        guard();
        return { ok: true as const, view };
      });
    } catch (error) {
      // telemetry-exempt: instruction content must never reach logs or telemetry. Visible error in the Builder.
      return { ok: false, code: error instanceof BuilderUnsupportedCompositionError ? 'unsupported' : error instanceof AssetCatalogError && ['stale_revision', 'stale_preview', 'stale_choice'].includes(error.code) ? 'stale' : 'failed' };
    }
  }
  ipcMain.handle(IPC.AGENT.NEW_COMPOSITION_PREVIEW, withValidatedArgs(
    [stringArg(), stringArg(), arrayArg(stringArg({ maxLength: 256 }), { maxLength: 256 })],
    async (event, projectId, templateId, skillIds) => {
      if (!await ready) throw new Error('Builder templates are unavailable.');
      return previewNewAgentComposition(event.sender.id, projectId, templateId, skillIds);
    },
  ));
  ipcMain.handle(IPC.AGENT.NEW_COMPOSITION_DISCARD, withValidatedArgs(
    [stringArg({ maxLength: 256 })], (event, token) => discardNewAgentComposition(event.sender.id, token),
  ));
  ipcMain.handle(IPC.AGENT.BUILDER_READ, withValidatedArgs([stringArg(), stringArg()], (_event, project, agent) => perform(project, agent)));
  ipcMain.handle(IPC.AGENT.BUILDER_COMMAND, withValidatedArgs(
    [stringArg(), stringArg(), numberArg({ integer: true, min: 0 }), builderCommandArg],
    (_event, project, agent, revision, action) => perform(project, agent, action, revision),
  ));
  ipcMain.handle(IPC.AGENT.BUILDER_PREVIEW, withValidatedArgs(
    [arrayArg(stringArg({ minLength: 0, maxLength: 256 * 1024 }), { maxLength: 256 })],
    (_event, contents) => composeInstructions(contents.map((content) => ({ content }))),
  ));
}
