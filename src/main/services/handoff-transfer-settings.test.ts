import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));
vi.mock('./project-store', () => ({ peekProjects: async () => [{ id: 'project' }, { id: 'other' }] }));
vi.mock('../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: (_area: string, work: () => Promise<void>) => work() } }));
import { HANDOFF_TRANSFER_DEFAULTS } from '../../shared/handoff-manifest';
import { withSettingsSurface } from './settings-audit';
import { getHandoffTransferBounds, setHandoffTransferBounds, _resetHandoffTransferSettingsForTesting } from './handoff-transfer-settings';
const limits = { totalBytes: 2 * 1024 ** 3, perFileBytes: 512 * 1024 ** 2, maxFiles: 1000 };
const set = (value: unknown, id = 'project') => withSettingsSurface('ui', undefined, () => setHandoffTransferBounds(id, value));
beforeEach(() => { state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-transfer-limits-')); _resetHandoffTransferSettingsForTesting(); });
afterEach(() => fs.rmSync(state.dir, { recursive: true, force: true }));
it('persists person-selected bounds independently per registered project and across restart', async () => {
  expect(await getHandoffTransferBounds('project')).toEqual(HANDOFF_TRANSFER_DEFAULTS);
  expect(await set(limits)).toEqual(limits); _resetHandoffTransferSettingsForTesting();
  expect(await getHandoffTransferBounds('project')).toEqual(limits);
  expect(await getHandoffTransferBounds('other')).toEqual(HANDOFF_TRANSFER_DEFAULTS);
  await expect(set(limits, 'missing')).rejects.toThrow('registered project');
});
it('refuses agent origins and invalid ceilings without changing the committed limits', async () => {
  await set(limits);
  for (const surface of ['mcp', 'dispatcher', 'annex_desktop', 'mobile'] as const) {
    await expect(withSettingsSurface(surface, 'agent', () => setHandoffTransferBounds('project', limits))).rejects.toThrow('Only the person');
  }
  await expect(withSettingsSurface('ui', 'agent', () => setHandoffTransferBounds('project', limits))).rejects.toThrow('Only the person');
  for (const invalid of [null, { ...limits, totalBytes: 17 * 1024 ** 3 }, { ...limits, perFileBytes: limits.totalBytes + 1 }, { ...limits, maxFiles: 10001 }, { ...limits, totalBytes: Infinity }]) await expect(set(invalid)).rejects.toThrow();
  expect(await getHandoffTransferBounds('project')).toEqual(limits);
});
it('does not raise limits when persistence fails, and refuses corrupt policy without overwriting it', async () => {
  await set(limits);
  const write = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('disk failed'));
  await expect(set({ ...limits, totalBytes: 4 * 1024 ** 3 })).rejects.toThrow(); write.mockRestore();
  expect(await getHandoffTransferBounds('project')).toEqual(limits);
  const policy = path.join(state.dir, 'handoff-transfer-settings.json'); fs.writeFileSync(policy, '{broken'); _resetHandoffTransferSettingsForTesting();
  await expect(getHandoffTransferBounds('project')).rejects.toThrow('unreadable');
  await expect(set(limits)).rejects.toThrow('unreadable'); expect(fs.readFileSync(policy, 'utf8')).toBe('{broken');
});
