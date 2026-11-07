import { beforeEach, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { SkillBundleEditorBridge } from '../../shared/skill-bundle-editor-types';
import { currentSettingsOrigin } from '../services/settings-audit';
import { registerSkillBundleHandlers } from './skill-bundle-handlers';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../services/catalog-skill-bundles', () => ({ createCatalogSkillBundleEditor: vi.fn() }));
let handlers: Map<string, (...args: unknown[]) => unknown>;
let bridge: SkillBundleEditorBridge;
const context = { projectId: 'project-1', agentId: 'agent-1' };
beforeEach(() => {
  handlers = new Map();
  vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => { handlers.set(channel, handler as (...args: unknown[]) => unknown); });
  const observe = async () => ({ ok: true as const, value: currentSettingsOrigin() });
  bridge = { create: vi.fn(observe), copy: vi.fn(observe), list: vi.fn(observe), read: vi.fn(observe), preview: vi.fn(observe), save: vi.fn(observe) } as unknown as SkillBundleEditorBridge;
  registerSkillBundleHandlers(bridge);
});
it('registers typed catalog operations in local UI audit scope', async () => {
  expect([...handlers.keys()]).toEqual(Object.values(IPC.CATALOG_SKILL_BUNDLE));
  const invoke = handlers.get(IPC.CATALOG_SKILL_BUNDLE.LIST)!;
  expect(await invoke({}, context)).toEqual({ ok: true, value: { surface: 'ui' } });
  expect(bridge.list).toHaveBeenCalledWith(context);
});
it('passes complete preview payload and saves by token without renderer bytes or filesystem paths', async () => {
  const request = { context, assetId: 'asset-1', expectedRevision: 3, payload: { skillName: 'test', files: [{ path: 'SKILL.md', content: 'synthetic' }] } };
  await handlers.get(IPC.CATALOG_SKILL_BUNDLE.PREVIEW)!({}, request);
  expect(bridge.preview).toHaveBeenCalledWith(request);
  const save = { context, assetId: 'asset-1', expectedRevision: 3, token: 'token' };
  await handlers.get(IPC.CATALOG_SKILL_BUNDLE.SAVE)!({}, save);
  expect(bridge.save).toHaveBeenCalledWith(save);
  expect(() => handlers.get(IPC.CATALOG_SKILL_BUNDLE.SAVE)!({}, { ...save, payload: request.payload })).toThrow();
  expect(() => handlers.get(IPC.CATALOG_SKILL_BUNDLE.SAVE)!({}, { ...save, stagingPath: '/outside' })).toThrow();
});
it.each([
  undefined, { projectId: '' }, { projectId: 'project-1', projectPath: '/outside' },
  { projectId: 'project-1', agentId: 4 }, { projectId: 'project-1', capability: {} },
])('rejects malformed or path/capability-bearing context before service access', (context) => {
  expect(() => handlers.get(IPC.CATALOG_SKILL_BUNDLE.LIST)!({}, context)).toThrow();
  expect(bridge.list).not.toHaveBeenCalled();
});
it.each([0, -1, 1.5, '3', NaN])('requires a saved catalog revision, received %s', (expectedRevision) => {
  expect(() => handlers.get(IPC.CATALOG_SKILL_BUNDLE.SAVE)!({}, { context, assetId: 'asset-1', expectedRevision, token: 'token' })).toThrow();
  expect(bridge.save).not.toHaveBeenCalled();
});

it('validates complete create and exact-revision copy DTOs without accepting owner or paths', async () => {
  const create = { context, name: 'Created', scope: 'agent', payload: { skillName: 'created', files: [{ path: 'SKILL.md', content: 'test' }] } };
  await handlers.get(IPC.CATALOG_SKILL_BUNDLE.CREATE)!({}, create);
  expect(bridge.create).toHaveBeenCalledWith(create);
  expect(() => handlers.get(IPC.CATALOG_SKILL_BUNDLE.CREATE)!({}, { ...create, owner: { kind: 'library' } })).toThrow();
  expect(() => handlers.get(IPC.CATALOG_SKILL_BUNDLE.CREATE)!({}, { ...create, scope: 'outside' })).toThrow();
  const copy = { context, assetId: 'asset-1', expectedRevision: 1 };
  await handlers.get(IPC.CATALOG_SKILL_BUNDLE.COPY)!({}, copy);
  expect(bridge.copy).toHaveBeenCalledWith(copy);
  expect(() => handlers.get(IPC.CATALOG_SKILL_BUNDLE.COPY)!({}, { ...copy, payload: create.payload })).toThrow();
  expect(() => handlers.get(IPC.CATALOG_SKILL_BUNDLE.COPY)!({}, { ...copy, expectedRevision: 0 })).toThrow();
});
