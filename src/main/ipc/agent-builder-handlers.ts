import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { BuilderCommand, BuilderResult } from '../../shared/agent-builder-types';
import { peekDurableConfigs } from '../services/agent-config';
import { createAgentBuilder, builderSnapshotAdoption } from '../services/asset-catalog/builder';
import { seedBuilderTemplates } from '../services/asset-catalog/builder-seeds';
import { composeInstructions } from '../services/asset-catalog/composer';
import { AssetCatalogError, assetCatalogDir, createAssetCatalogStore, type AssetCatalogStore } from '../services/asset-catalog/store';
import { arrayArg, booleanArg, numberArg, objectArg, stringArg, withValidatedArgs, type ArgValidator } from './validation';

/** Validate the complete command without ever including supplied text in errors. */
export const builderCommandArg: ArgValidator<BuilderCommand> = (value, label) => {
  const raw = objectArg<Record<string, unknown>>()(value, label);
  const type = stringArg()(raw.type, 'command type');
  const fields: Record<string, string[]> = {
    template: ['templateId', 'confirm', 'binding'], order: ['keys'], baseOrder: [], append: ['name', 'content'],
    fork: ['key'], return: ['key'], edit: ['key', 'content'], remove: ['key'],
  };
  if (!Object.prototype.hasOwnProperty.call(fields, type) || Object.keys(raw).some((key) => key !== 'type' && !fields[type].includes(key))) throw new Error('Invalid builder command');
  for (const key of fields[type]) {
    if (key === 'binding') {
      if (raw[key] !== undefined) {
        const binding = objectArg<Record<string, unknown>>()(raw[key], 'binding');
        if (Object.keys(binding).length !== 3) throw new Error('Invalid builder binding');
        for (const field of ['fromFingerprint', 'toFingerprint', 'instanceFingerprint']) stringArg({ maxLength: 64 })(binding[field], 'fingerprint');
      }
    } else if (key === 'keys') arrayArg(stringArg({ maxLength: 256 }), { maxLength: 256 })(raw[key], 'order');
    else if (key === 'confirm') booleanArg()(raw[key], 'confirm');
    else stringArg({ minLength: key === 'content' ? 0 : 1, maxLength: key === 'content' ? 256 * 1024 : 256 })(raw[key], key);
  }
  return raw as unknown as BuilderCommand;
};

export function registerAgentBuilderHandlers(store: AssetCatalogStore = createAssetCatalogStore({ dir: assetCatalogDir() })): void {
  const builder = createAgentBuilder(store);
  // Starts on the main/system surface, before any renderer request. A failed
  // seed is visible in the Builder; its payload never goes into telemetry.
  const ready = seedBuilderTemplates(store).then(() => true, () => false);
  async function perform(projectPath: string, agentId: string, action?: BuilderCommand, revision?: number): Promise<BuilderResult> {
    try {
      if (!await ready) return { ok: false, code: 'failed' };
      // Peek must not repair agents.json, settle creations or register watchers.
      const agent = (await peekDurableConfigs(projectPath)).find((candidate) => candidate.id === agentId);
      if (!agent || agent.persona === 'dispatcher') return { ok: false, code: 'failed' };
      const adoption = await builderSnapshotAdoption(store, await builder.compositionOf(agentId));
      const view = action ? await builder.command(agentId, revision!, action, adoption) : await builder.read(agentId, adoption);
      return { ok: true, view };
    } catch (error) {
      // telemetry-exempt: instruction content must never reach logs or telemetry. Visible error in the Builder.
      return { ok: false, code: error instanceof AssetCatalogError && ['stale_revision', 'stale_preview', 'stale_choice'].includes(error.code) ? 'stale' : 'failed' };
    }
  }
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
