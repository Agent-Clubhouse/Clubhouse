import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerAgentBuilderHandlers } from './agent-builder-handlers';
import { createAssetCatalogStore } from '../services/asset-catalog/store';
import { composeInstructions } from '../services/asset-catalog/composer';
import type { BuilderResult } from '../../shared/agent-builder-types';
import { currentSettingsOrigin } from '../services/settings-audit';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('../services/agent-config', () => ({ peekDurableConfigs: vi.fn(async () => [{ id: 'agent-1' }, { id: 'dispatcher-agent', persona: 'dispatcher' }]) }));
let root: string;
let handlers: Map<string, (...args: unknown[]) => Promise<BuilderResult>>;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-ipc-'));
  handlers = new Map();
  vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => { handlers.set(channel, handler as never); });
  registerAgentBuilderHandlers(createAssetCatalogStore({ dir: path.join(root, 'catalog') }));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const read = (id = 'agent-1') => handlers.get(IPC.AGENT.BUILDER_READ)!({}, '/project', id);
const command = (revision: number, action: unknown) => handlers.get(IPC.AGENT.BUILDER_COMMAND)!({}, '/project', 'agent-1', revision, action);
it('registers validated read, command and composer preview handlers; unknown agents are refused', async () => {
  expect(handlers.size).toBe(3);
  expect(await read()).toMatchObject({ ok: true, view: { revision: 0, blocks: [] } });
  expect(await read('missing')).toEqual({ ok: false, code: 'failed' });
  expect(await read('dispatcher-agent')).toEqual({ ok: false, code: 'failed' });
  const content = ['@@AgentName', 'rules\n'];
  expect(await handlers.get(IPC.AGENT.BUILDER_PREVIEW)!({}, content)).toEqual(composeInstructions(content.map((c) => ({ content: c }))));
});
it('validates nested commands and rejects bad revisions before writing', async () => {
  for (const action of [{ type: 'append', name: 'a', content: 1 }, { type: 'edit', key: 'a', content: 'x', path: '/escape' }, { type: 'other' }, { type: 'order', keys: ['ok', 3] }, { type: 'template', templateId: 'x', confirm: 'yes' }]) {
    expect(() => command(0, action)).toThrow();
  }
  expect(() => command(-1, { type: 'baseOrder' })).toThrow();
  expect(() => read(null as never)).toThrow();
  expect(await read()).toMatchObject({ ok: true, view: { revision: 0 } });
});
it('saves via the UI surface and returns a plain stale result', async () => {
  const store = createAssetCatalogStore({ dir: path.join(root, 'second') });
  const save = vi.spyOn(store, 'saveComposition');
  registerAgentBuilderHandlers(store);
  const preview = await command(0, { type: 'template', templateId: 'builtin-builder-custom', confirm: false });
  if (preview.ok === false) throw new Error('preview failed');
  expect(await command(0, { type: 'template', templateId: 'builtin-builder-custom', confirm: true, binding: preview.view.templateBinding })).toMatchObject({ ok: true, view: { revision: 1 } });
  save.mockImplementationOnce(async () => {
    expect(currentSettingsOrigin()).toEqual({ surface: 'ui' });
    throw new Error('instruction content must not escape');
  });
  expect(await command(1, { type: 'append', name: 'Local', content: 'private instructions' })).toEqual({ ok: false, code: 'failed' });
  expect(await read()).toMatchObject({ ok: true, view: { revision: 1 } });
  expect(await command(0, { type: 'baseOrder' })).toEqual({ ok: false, code: 'stale' });
});
