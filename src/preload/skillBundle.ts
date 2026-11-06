import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { SkillBundleEditorBridge } from '../shared/skill-bundle-editor-types';

const catalogSkillBundles: SkillBundleEditorBridge = {
  list: (context) => ipcRenderer.invoke(IPC.SKILL_BUNDLE.LIST, context),
  read: (context, assetId) => ipcRenderer.invoke(IPC.SKILL_BUNDLE.READ, context, assetId),
  preview: (request) => ipcRenderer.invoke(IPC.SKILL_BUNDLE.PREVIEW, request),
  save: (request) => ipcRenderer.invoke(IPC.SKILL_BUNDLE.SAVE, request),
};
export const skillBundle = { catalogSkillBundles };
