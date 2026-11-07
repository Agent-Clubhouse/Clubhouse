import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { SkillBundleEditorBridge } from '../shared/skill-bundle-editor-types';

const catalogSkillBundles: SkillBundleEditorBridge = {
  create: (request) => ipcRenderer.invoke(IPC.CATALOG_SKILL_BUNDLE.CREATE, request),
  copy: (request) => ipcRenderer.invoke(IPC.CATALOG_SKILL_BUNDLE.COPY, request),
  list: (context) => ipcRenderer.invoke(IPC.CATALOG_SKILL_BUNDLE.LIST, context),
  read: (context, assetId) => ipcRenderer.invoke(IPC.CATALOG_SKILL_BUNDLE.READ, context, assetId),
  preview: (request) => ipcRenderer.invoke(IPC.CATALOG_SKILL_BUNDLE.PREVIEW, request),
  save: (request) => ipcRenderer.invoke(IPC.CATALOG_SKILL_BUNDLE.SAVE, request),
};
export const skillBundle = { catalogSkillBundles };
