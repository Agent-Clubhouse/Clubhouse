import { expect, it, vi } from 'vitest';
import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import { skillBundle } from './skillBundle';
vi.mock('electron', () => ({ ipcRenderer: { invoke: vi.fn(async () => ({ ok: true, value: [] })) } }));
it('forwards only the typed catalog context, asset/revision and preview/save DTOs', async () => {
  const context = { projectId: 'project-1' };
  await skillBundle.catalogSkillBundles.list(context);
  await skillBundle.catalogSkillBundles.read(context, 'asset-1');
  const request = { context, assetId: 'asset-1', expectedRevision: 2, payload: { skillName: 'bundle', files: [{ path: 'SKILL.md', content: 'synthetic' }] } };
  await skillBundle.catalogSkillBundles.preview(request);
  await skillBundle.catalogSkillBundles.save({ context, assetId: 'asset-1', expectedRevision: 2, token: 'preview-token' });
  expect(vi.mocked(ipcRenderer.invoke).mock.calls).toEqual([
    [IPC.SKILL_BUNDLE.LIST, context], [IPC.SKILL_BUNDLE.READ, context, 'asset-1'],
    [IPC.SKILL_BUNDLE.PREVIEW, request], [IPC.SKILL_BUNDLE.SAVE, { context, assetId: 'asset-1', expectedRevision: 2, token: 'preview-token' }],
  ]);
});
