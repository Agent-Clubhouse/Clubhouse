import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: (_area: string, work: () => Promise<void>) => work() } }));
import { withSettingsSurface } from './settings-audit';
import { handoffProjectsLinked, setHandoffProjectLinks, _resetHandoffProjectLinksForTesting } from './handoff-project-links';
const machine = Array(16).fill('ab').join(':');
const save = (groups: string[][]) => withSettingsSurface('ui', undefined, () => setHandoffProjectLinks(groups));
beforeEach(() => { state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-project-links-')); _resetHandoffProjectLinksForTesting(); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(state.root, { recursive: true, force: true }); });
it('uses only person-owned project groups and pins remote identities to their computer', async () => {
  await expect(withSettingsSurface('mcp', 'agent', () => setHandoffProjectLinks([['local', `remote||${machine}||remote-project`]]))).rejects.toThrow('Only the person');
  await save([['local', `remote||${machine}||remote-project`]]); _resetHandoffProjectLinksForTesting();
  expect(handoffProjectsLinked('local', machine, 'remote-project')).toBe(true);
  expect(handoffProjectsLinked('local', Array(16).fill('cd').join(':'), 'remote-project')).toBe(false);
});
it('does not let a remote peer claim a linked local project id', async () => {
  await save([['local', 'another-local-project']]);
  expect(handoffProjectsLinked('local', machine, 'another-local-project')).toBe(false);
  expect(handoffProjectsLinked('local', machine, 'another-local-project', true)).toBe(true);
});
it('disables routing after a failed person edit until a successful retry', async () => {
  await save([['local', `remote||${machine}||original`]]);
  vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('disk failed'));
  await expect(save([['local', `remote||${machine}||replacement`]])).rejects.toThrow();
  expect(handoffProjectsLinked('local', machine, 'original')).toBe(false); expect(handoffProjectsLinked('local', machine, 'replacement')).toBe(false);
  vi.restoreAllMocks(); await save([['local', `remote||${machine}||replacement`]]);
  expect(handoffProjectsLinked('local', machine, 'replacement')).toBe(true);
});
it('fails closed on corrupt routing hints and does not overwrite them', async () => {
  const file = path.join(state.root, 'handoff-project-links.json'); fs.writeFileSync(file, '{broken');
  expect(handoffProjectsLinked('local', machine, 'remote-project')).toBe(false);
  await expect(save([['local', `remote||${machine}||remote-project`]])).rejects.toThrow('unreadable');
  expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
});
