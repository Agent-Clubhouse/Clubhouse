import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ dir: '', ready: true, receipt: vi.fn(), projects: [] as Array<{ id: string; path: string }> }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));
vi.mock('./project-store', () => ({ peekProjects: async () => state.projects }));
vi.mock('./actions', () => ({ actionsReady: () => state.ready, recordExternalRun: state.receipt }));
vi.mock('../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: (_area: string, work: () => Promise<void>) => work() } }));
import { withSettingsSurface } from './settings-audit';
import { HandoffSecretPolicy, getHandoffSecretSettings, setHandoffSecretSettings, isTrustedHandoffSecretPolicy, _resetHandoffSecretSettingsForTesting } from './handoff-secret-settings';
const set = (names: string[], id = 'project') => withSettingsSurface('ui', undefined, () => setHandoffSecretSettings(id, names));
const token = `ghp_${'a'.repeat(36)}`;
beforeEach(() => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-secret-policy-'));
  state.projects = [{ id: 'project', path: path.join(state.dir, 'project') }, { id: 'other', path: path.join(state.dir, 'other') }];
  state.ready = true; state.receipt.mockReset().mockResolvedValue(undefined); _resetHandoffSecretSettingsForTesting();
});
afterEach(() => { fs.rmSync(state.dir, { recursive: true, force: true }); });
describe('person-controlled handoff exceptions', () => {
  it('requires a person UI origin, a registered project, and exact bounded paths', async () => {
    await expect(setHandoffSecretSettings('project', ['fixture.txt'])).rejects.toThrow('Only the person');
    for (const surface of ['mcp', 'dispatcher', 'annex_desktop', 'mobile'] as const) await expect(withSettingsSurface(surface, 'agent', () => setHandoffSecretSettings('project', ['fixture.txt']))).rejects.toThrow('Only the person');
    await expect(withSettingsSurface('ui', 'agent', () => setHandoffSecretSettings('project', ['fixture.txt']))).rejects.toThrow('Only the person');
    for (const names of [['../outside'], ['.git/config'], ['fixtures/**'], ['file', 'file'], Array(101).fill('file'), ['C:token'], ['a\\b']]) await expect(set(names)).rejects.toThrow('exact relative');
    await expect(set(['fixture.txt'], 'missing')).rejects.toThrow('registered project');
    expect(state.receipt).not.toHaveBeenCalled();
  });
  it('persists confirmation before granting, scopes to this project and survives restart', async () => {
    state.receipt.mockImplementationOnce(async () => expect((await getHandoffSecretSettings('project')).notSecretPaths).toEqual([]));
    const settings = await set(['fixture.txt']);
    expect(settings.historyActionIds).toHaveLength(1);
    expect(state.receipt).toHaveBeenCalledWith(expect.objectContaining({ externalSource: 'handoff_secret', owner: { kind: 'user' }, outcome: 'done' }));
    _resetHandoffSecretSettingsForTesting();
    expect((await getHandoffSecretSettings('project')).notSecretPaths).toEqual(['fixture.txt']);
    expect((await HandoffSecretPolicy.forProject('project')).scan('fixture.txt', Buffer.from(token))).toEqual([]);
    expect((await HandoffSecretPolicy.forProject('other')).scan('fixture.txt', Buffer.from(token))).not.toEqual([]);
    expect((await HandoffSecretPolicy.forProject('project')).scan('other/fixture.txt', Buffer.from(token))).not.toEqual([]);
  });
  it('keeps failed audit or failed save from granting an exception', async () => {
    state.ready = false; await expect(set(['fixture.txt'])).rejects.toThrow('Action history'); state.ready = true;
    state.receipt.mockRejectedValueOnce(new Error('disk failed')); await expect(set(['fixture.txt'])).rejects.toThrow('disk failed');
    expect((await getHandoffSecretSettings('project')).notSecretPaths).toEqual([]);
    const write = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('rename failed'));
    await expect(set(['fixture.txt'])).rejects.toThrow(); write.mockRestore();
    expect((await getHandoffSecretSettings('project')).notSecretPaths).toEqual([]);
  });
  it('invalidates captured policy immediately on revocation and refuses forged policies', async () => {
    await set(['fixture.txt']); const captured = await HandoffSecretPolicy.forProject('project');
    expect(isTrustedHandoffSecretPolicy(captured)).toBe(true);
    expect(isTrustedHandoffSecretPolicy({ scan: () => [] })).toBe(false);
    await set([]);
    expect(() => captured.scan('fixture.txt', Buffer.from(token))).toThrow('policy changed');
    await expect(captured.recordUse(randomUUID(), 'sender')).rejects.toThrow('policy changed');
  });
  it('audits actual exception use with sanitized paths, never secret values, and checks policy after audit', async () => {
    await set(['fixture.txt']); const policy = await HandoffSecretPolicy.forProject('project');
    expect(policy.scan('fixture.txt', Buffer.from(token))).toEqual([]);
    const id = randomUUID(); await policy.recordUse(id, 'receiver');
    expect(state.receipt).toHaveBeenLastCalledWith(expect.objectContaining({ id: expect.stringMatching(new RegExp(`^handoff-secret:${id}:receiver:[0-9a-f]{16}:[0-9a-f-]{36}$`)), steps: [expect.objectContaining({ detail: 'fixture.txt' })] }));
    expect(JSON.stringify(state.receipt.mock.calls)).not.toContain(token);
    state.receipt.mockImplementationOnce(async () => { await set([]); });
    await expect(policy.recordUse(randomUUID(), 'sender')).rejects.toThrow('policy changed');
  });
  it('fails closed on corrupt saved policy without overwriting evidence', async () => {
    const file = path.join(state.dir, 'handoff-secret-settings.json'); fs.writeFileSync(file, '{broken');
    await expect(getHandoffSecretSettings('project')).rejects.toThrow('unreadable');
    await expect(set(['fixture.txt'])).rejects.toThrow('unreadable');
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken'); expect(state.receipt).not.toHaveBeenCalled();
  });
});
