import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import type { DurableAgentConfig } from '../../../shared/types';
import { PREPARE_HANDOFF_SKILL_ID } from '../../../shared/managed-agents-types';
const m = vi.hoisted(() => ({ config: vi.fn(), running: false }));
vi.mock('../agent-config', async (original) => ({ ...await original<typeof import('../agent-config')>(), getDurableConfig: m.config }));
vi.mock('../agent-system', () => ({ isAgentRunning: () => m.running, resolveOrchestrator: vi.fn(), spawnAgent: vi.fn(), killAgent: vi.fn() }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: async (_kind: string, work: () => Promise<void>) => work() } }));
import { createAssetCatalogStore } from '../asset-catalog/store';
import { resetAllSettingsStoresForTests } from '../settings-store';
import { agentHoldsAction } from '../agent-grants-service';
import { _resetSettingsAuditForTesting } from '../settings-audit';
import { createManagedAgentsService, type ManagedAgentsService } from './service';
import { createManagedStateStore } from './state-store';
import { readManagedStatusForDisplay, statusFor, _setManagedAgentsForTesting } from './index';
import { resolveManagedSetupForDisplay, setGrantedSkills } from './delivery';
let root: string, service: ManagedAgentsService, agent: DurableAgentConfig;
async function disk(folder = root): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const name of (await fs.readdir(folder)).sort()) {
    const file = path.join(folder, name), stat = await fs.lstat(file);
    result[name] = stat.isDirectory() ? { ino: stat.ino, files: await disk(file) } : { bytes: (await fs.readFile(file)).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs };
  }
  return result;
}
async function temp(name: string) { const file = path.join(root, `.${name}.tmp-${process.pid + 100000}-1`); await fs.writeFile(file, 'do not sweep'); const old = new Date(Date.now() - 3 * 86400000); await fs.utimes(file, old, old); }
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-managed-display-'))); vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests(); _resetSettingsAuditForTesting(false); m.running = false;
  agent = { id: 'selected', name: 'Admitted Selected', color: '', createdAt: '', worktreePath: path.join(root, 'worktree'), orchestration: { orchestrate: false, connectToDispatcher: false }, managed: { version: 1, blocks: [], skills: [], mcps: [] } };
  service = createManagedAgentsService({ catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }), state: createManagedStateStore(path.join(root, 'managed')), listProjects: async () => [], listAgents: async () => [], getAgent: m.config, setManagedSetup: vi.fn(), isRunning: () => m.running });
  // Ordinary library creation is fixture setup, before the passive capture.
  await service.ensureBuiltins(); _setManagedAgentsForTesting(service); resetAllSettingsStoresForTests();
  setGrantedSkills((selected) => agentHoldsAction(selected.id, selected, 'handoff.offer') ? [PREPARE_HANDOFF_SKILL_ID] : []);
  m.config.mockReset().mockImplementation(async () => { throw new Error('unadmitted replacement config lookup'); });
});
afterEach(async () => { _setManagedAgentsForTesting(null); resetAllSettingsStoresForTests(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
it.each([false, true])('reuses the admitted setup and local status model with selected grant-derived skill=%s, without ordinary callback effects', async (held) => {
  await fs.writeFile(path.join(root, 'agent-grants.json'), JSON.stringify({ agents: { selected: { changes: held ? [{ action: 'handoff.offer', target: { kind: 'remote_dispatcher' }, mode: 'ask' }] : [] } } }));
  m.config.mockResolvedValue(agent); const ordinary = await statusFor('/fixture', 'selected'); m.config.mockClear(); m.config.mockImplementation(async () => { throw new Error('unadmitted replacement config lookup'); }); resetAllSettingsStoresForTests();
  await temp('agent-grants.json'); const before = await disk(); const result = await readManagedStatusForDisplay(agent);
  expect.soft(result.state).toBe('ok'); if (result.state === 'ok') { expect.soft(result.value).toEqual(ordinary); expect.soft(result.value.builtinSkills?.length).toBe(held ? 1 : 0); }
  expect.soft(m.config).not.toHaveBeenCalled(); expect.soft(await disk()).toEqual(before);
});
it('keeps unreadable grant applicability unknown without resolving parts, mutating storage or relooking up agent config', async () => {
  await fs.writeFile(path.join(root, 'agent-grants.json'), '{broken'); await temp('agent-grants.json'); const before = await disk(); const head = vi.spyOn(service, 'headContent');
  expect(await readManagedStatusForDisplay(agent)).toMatchObject({ state: 'unavailable', reason: 'unreadable' }); expect(head).not.toHaveBeenCalled(); expect(m.config).not.toHaveBeenCalled(); expect(await disk()).toEqual(before);
});
it('takes explicit empty granted skills without invoking the registered ordinary delivery callback', async () => {
  const callback = vi.fn(() => { throw new Error('ordinary grant callback is not passive'); }); const remove = setGrantedSkills(callback);
  try { const result = await resolveManagedSetupForDisplay(service, agent, []); expect(result.skills).toEqual([]); expect(callback).not.toHaveBeenCalled(); } finally { remove(); }
});
it('counts the implicit Clubhouse MCP and granted skill reads in the part budget', async () => {
  agent.managed!.blocks = Array.from({ length: 100 }, (_, index) => `missing-${index}`); const head = vi.spyOn(service, 'headContent');
  expect.soft(await readManagedStatusForDisplay(agent)).toMatchObject({ state: 'unavailable', reason: 'limit' }); expect.soft(head).not.toHaveBeenCalled();
});
it('reads selected template metadata without global Access normalization, unrelated templates, setup content or recovery', async () => {
  const state = path.join(root, 'managed', 'state.json'); await fs.mkdir(path.dirname(state), { recursive: true });
  await fs.writeFile(state, JSON.stringify({ version: 1, templates: { chosen: { id: 'chosen', name: 'Chosen template', description: 'PRIVATE_DESCRIPTION', builtin: false, setup: { blocks: [], skills: [], mcps: [] }, settings: { privateCredential: 'PRIVATE_CREDENTIAL' }, updatedBy: 'Host user', updatedAt: '2026-11-19' }, PRIVATE_OTHER: { id: 'PRIVATE_OTHER', name: 'PRIVATE_OTHER_NAME', description: 'PRIVATE_OTHER_DESCRIPTION', builtin: false, setup: { blocks: [], skills: [], mcps: [] }, settings: {} } } }));
  await fs.writeFile(path.join(root, 'free-agent-settings.json'), '{broken'); await temp('free-agent-settings.json'); const before = await disk();
  const result = await service.getTemplateForDisplay('chosen'); expect.soft(result).toMatchObject({ name: 'Chosen template', updatedBy: 'Host user', updatedAt: '2026-11-19', source: 'primary' });
  expect.soft(JSON.stringify(result)).not.toMatch(/PRIVATE_|settings|setup|description/); expect.soft(await disk()).toEqual(before);
});
it.each(['array', 'null', 'large', 'mismatched-id'])('does not flatten %s template metadata into verified absence or adopt an unrelated identity', async (kind) => {
  const state = path.join(root, 'managed', 'state.json'); await fs.mkdir(path.dirname(state), { recursive: true });
  await fs.writeFile(state, JSON.stringify({ version: 1, templates: kind === 'array' ? [] : kind === 'null' ? null : kind === 'large' ? { chosen: { id: 'chosen', name: 'Large selected template', settings: { content: 'x'.repeat(512 * 1024) } } } : { chosen: { id: 'unrelated', name: 'PRIVATE_WRONG_TEMPLATE' } } }));
  const before = await disk(); let error: unknown, value: unknown; try { value = await service.getTemplateForDisplay('chosen'); } catch (caught) { error = caught; }
  expect.soft(error).toBeDefined(); if (error) expect.soft(error).not.toMatchObject({ code: 'not_found' });
  expect.soft(JSON.stringify(value ?? {})).not.toContain('PRIVATE_WRONG_TEMPLATE'); expect.soft(await disk()).toEqual(before);
});

it('keeps a missing custom-template inventory verified absent without creating its folder', async () => {
  const before = await disk(); await expect(service.getTemplateForDisplay('missing-template')).rejects.toMatchObject({ code: 'not_found' }); expect(await disk()).toEqual(before);
  await expect(fs.access(path.join(root, 'managed'))).rejects.toThrow();
});

it('withholds grant-derived status changed during an actual awaited part read', async () => {
  const grants = path.join(root, 'agent-grants.json'); await fs.writeFile(grants, JSON.stringify({ agents: { selected: { changes: [{ action: 'handoff.offer', target: { kind: 'remote_dispatcher' }, mode: 'ask' }] } } }));
  const head = service.headContent.bind(service); let changed = false;
  vi.spyOn(service, 'headContent').mockImplementationOnce(async (...args) => { const result = await head(...args); await fs.writeFile(grants, JSON.stringify({ agents: { selected: { changes: [] } } })); changed = true; return result; });
  const result = await readManagedStatusForDisplay(agent); expect(changed).toBe(true); expect.soft(result).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect.soft(JSON.stringify(result)).not.toMatch(/builtinSkills|Prepare handoff|deliveryFailed/);
});
it('keeps real selected permission receipts private for the eventual final endpoint boundary after status returns', async () => {
  const grants = path.join(root, 'agent-grants.json'); await fs.writeFile(grants, JSON.stringify({ agents: { selected: { changes: [{ action: 'handoff.offer', target: { kind: 'remote_dispatcher' }, mode: 'ask' }] } } }));
  const receipts: Array<{ current(): boolean }> = []; const result = await readManagedStatusForDisplay(agent, { receipts });
  expect(result.state).toBe('ok'); expect.soft(receipts).toHaveLength(1); expect.soft(receipts[0]?.current()).toBe(true); expect(JSON.stringify(result)).not.toMatch(/current|receipts|changes.*handoff.offer/);
  await fs.writeFile(grants, JSON.stringify({ agents: { selected: { changes: [] } } })); const before = await disk(); expect.soft(receipts[0]?.current()).toBe(false); expect.soft(await disk()).toEqual(before);
});

it('carries selected template metadata receipts privately through later real state-file changes', async () => {
  const file = path.join(root, 'managed', 'state.json'); await fs.mkdir(path.dirname(file), { recursive: true });
  const chosen = { id: 'chosen', name: 'Chosen template', builtin: false, setup: { blocks: [], skills: [], mcps: [] }, settings: { privateCredential: 'PRIVATE_CREDENTIAL' } };
  await fs.writeFile(file, JSON.stringify({ version: 1, templates: { chosen, other: { name: 'PRIVATE_UNRELATED' } } }));
  const receipts: Array<{ current(): boolean }> = []; const result = await service.getTemplateForDisplay('chosen', { receipts });
  expect(receipts).toHaveLength(1); expect(receipts[0].current()).toBe(true); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|receipts|current|settings|setup/);
  await fs.writeFile(file, JSON.stringify({ version: 1, templates: { chosen, other: { name: 'PRIVATE_UNRELATED_CHANGED' } } })); expect(receipts[0].current()).toBe(true);
  await fs.writeFile(file, JSON.stringify({ version: 1, templates: { chosen: { ...chosen, name: 'Changed template' } } })); const before = await disk(); expect.soft(receipts[0]?.current()).toBe(false); expect.soft(await disk()).toEqual(before);
});

it('keeps unmanaged selected status available independently of unreadable grant settings', async () => {
  await fs.writeFile(path.join(root, 'agent-grants.json'), '{broken'); await temp('agent-grants.json'); const before = await disk();
  expect(await readManagedStatusForDisplay({ ...agent, managed: undefined })).toMatchObject({ state: 'ok', value: { managed: false, running: false, waiting: false } });
  expect(m.config).not.toHaveBeenCalled(); expect(await disk()).toEqual(before);
});
it('does not let an unrelated malformed template hide the selected valid metadata', async () => {
  const file = path.join(root, 'managed', 'state.json'); await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, templates: { chosen: { id: 'chosen', name: 'Chosen template' }, unrelated: null } }));
  const before = await disk(); expect(await service.getTemplateForDisplay('chosen')).toMatchObject({ name: 'Chosen template' }); expect(await disk()).toEqual(before);
});
