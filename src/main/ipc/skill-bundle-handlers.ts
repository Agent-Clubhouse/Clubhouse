import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { SkillBundleContext, SkillBundleEditRequest, SkillBundleEditorBridge } from '../../shared/skill-bundle-editor-types';
import { createCatalogSkillBundleEditor } from '../services/catalog-skill-bundles';
import { objectArg, stringArg, withValidatedArgs, type ArgValidator } from './validation';

function fields(value: object, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Unexpected bundle request field');
}
const contextArg = objectArg<SkillBundleContext>({ validate: (context) => {
  fields(context, ['projectId', 'agentId']);
  stringArg({ maxLength: 128 })(context.projectId, 'projectId');
  stringArg({ optional: true, maxLength: 128 })(context.agentId, 'agentId');
} });
function revision(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('Invalid catalog revision');
}
const previewArg: ArgValidator<SkillBundleEditRequest> = objectArg({ validate: (request: SkillBundleEditRequest) => {
  fields(request, ['context', 'assetId', 'expectedRevision', 'payload']);
  contextArg(request.context, 'context');
  stringArg({ maxLength: 128 })(request.assetId, 'assetId');
  revision(request.expectedRevision);
  objectArg()(request.payload, 'payload'); // The catalog owns complete SkillAssetPayload validation.
} });
type SaveRequest = Parameters<SkillBundleEditorBridge['save']>[0];
const saveArg: ArgValidator<SaveRequest> = objectArg({ validate: (request: SaveRequest) => {
  fields(request, ['context', 'assetId', 'expectedRevision', 'token']);
  contextArg(request.context, 'context');
  stringArg({ maxLength: 128 })(request.assetId, 'assetId');
  stringArg({ maxLength: 128 })(request.token, 'token');
  revision(request.expectedRevision);
} });

type CreateRequest = Parameters<SkillBundleEditorBridge['create']>[0];
const createArg: ArgValidator<CreateRequest> = objectArg({ validate: (request: CreateRequest) => {
  fields(request, ['context', 'name', 'scope', 'payload']);
  contextArg(request.context, 'context');
  stringArg({ maxLength: 120 })(request.name, 'name');
  if (!['library', 'project', 'agent'].includes(request.scope)) throw new Error('Invalid bundle scope');
  objectArg()(request.payload, 'payload');
} });
type CopyRequest = Parameters<SkillBundleEditorBridge['copy']>[0];
const copyArg: ArgValidator<CopyRequest> = objectArg({ validate: (request: CopyRequest) => {
  fields(request, ['context', 'assetId', 'expectedRevision']);
  contextArg(request.context, 'context');
  stringArg({ maxLength: 128 })(request.assetId, 'assetId');
  revision(request.expectedRevision);
} });

export function registerSkillBundleHandlers(service: SkillBundleEditorBridge = createCatalogSkillBundleEditor()): void {
  ipcMain.handle(IPC.CATALOG_SKILL_BUNDLE.CREATE, withValidatedArgs([createArg], (_event, request) => service.create(request)));
  ipcMain.handle(IPC.CATALOG_SKILL_BUNDLE.COPY, withValidatedArgs([copyArg], (_event, request) => service.copy(request)));
  ipcMain.handle(IPC.CATALOG_SKILL_BUNDLE.LIST, withValidatedArgs([contextArg], (_event, context) => service.list(context)));
  ipcMain.handle(IPC.CATALOG_SKILL_BUNDLE.READ, withValidatedArgs([contextArg, stringArg({ maxLength: 128 })], (_event, context, assetId) => service.read(context, assetId)));
  ipcMain.handle(IPC.CATALOG_SKILL_BUNDLE.PREVIEW, withValidatedArgs([previewArg], (_event, request) => service.preview(request)));
  ipcMain.handle(IPC.CATALOG_SKILL_BUNDLE.SAVE, withValidatedArgs([saveArg], (_event, request) => service.save(request)));
}
