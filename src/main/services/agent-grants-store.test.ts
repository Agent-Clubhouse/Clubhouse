import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ base: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
const permission = (mode: 'off' | 'ask' | 'allow') => ({
  changes: [{ action: 'settings.app.write' as const, target: { kind: 'app' as const }, mode }],
});

beforeEach(() => {
  state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'committed-grant-policy-'));
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(state.base, { recursive: true, force: true });
});

describe('durable grant policy publication and pending restrictions', () => {
  it('does not expose a new Allow before commit, and actual grant checks refuse while the write is pending', async () => {
    const store = await import('./agent-grants-store');
    const { checkToolGrant } = await import('./clubhouse-mcp/grant-check');
    const rename = fs.promises.rename;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => { await gate; return rename(from, to); });
    const saving = store.updateAgentGrantChanges('caller', () => permission('allow'));
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(store.getAgentGrantChanges('caller')).toBeUndefined();
    expect(checkToolGrant('caller', { actions: ['settings.app.write'], target: 'app' }, {})).toMatchObject({ ok: false, reason: 'no_grant' });
    release();
    await saving;
    expect(checkToolGrant('caller', { actions: ['settings.app.write'], target: 'app' }, {})).toEqual({ ok: true });
    if (process.platform !== 'win32') expect(fs.statSync(path.join(state.base, 'agent-grants.json')).mode & 0o777).toBe(0o600);
  });

  it('pending Off gates the actual matcher immediately, without pretending the old committed Allow is the new policy', async () => {
    const store = await import('./agent-grants-store');
    const { checkToolGrant } = await import('./clubhouse-mcp/grant-check');
    await store.updateAgentGrantChanges('caller', () => permission('allow'));
    expect(checkToolGrant('caller', { actions: ['settings.app.write'], target: 'app' }, {})).toEqual({ ok: true });
    const rename = fs.promises.rename;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => { await gate; return rename(from, to); });
    const saving = store.updateAgentGrantChanges('caller', () => permission('off'));
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(store.getAgentGrantChanges('caller')?.changes[0].mode).toBe('allow');
    const bypass = vi.spyOn(store, 'agentGrantChangePending').mockReturnValue(false);
    expect(checkToolGrant('caller', { actions: ['settings.app.write'], target: 'app' }, {})).toEqual({ ok: true });
    bypass.mockRestore();
    expect(checkToolGrant('caller', { actions: ['settings.app.write'], target: 'app' }, {})).toMatchObject({ ok: false });
    release();
    await saving;
    expect(store.getAgentGrantChanges('caller')?.changes[0].mode).toBe('off');
    expect(checkToolGrant('caller', { actions: ['settings.app.write'], target: 'app' }, {})).toMatchObject({ ok: false });
  });

  it('one failed operation releases only its own gate while another overlapping change is still pending', async () => {
    const store = await import('./agent-grants-store');
    const { checkToolGrant } = await import('./clubhouse-mcp/grant-check');
    await store.updateAgentGrantChanges('caller', () => permission('allow'));
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const first = store.withAgentGrantChange('caller', async () => { await firstGate; throw new Error('first failed'); });
    const failed = expect(first).rejects.toThrow('first failed');
    const second = store.withAgentGrantChange('caller', () => secondGate);
    releaseFirst();
    await failed;
    expect(store.agentGrantChangePending('caller')).toBe(true);
    expect(checkToolGrant('caller', { actions: ['settings.app.write'], target: 'app' }, {})).toMatchObject({ ok: false });
    releaseSecond();
    await second;
    expect(store.agentGrantChangePending('caller')).toBe(false);
    expect(checkToolGrant('caller', { actions: ['settings.app.write'], target: 'app' }, {})).toEqual({ ok: true });
  });

  it('failed writes publish neither an uncommitted policy nor a false Off readback, including restart', async () => {
    const store = await import('./agent-grants-store');
    await store.updateAgentGrantChanges('caller', () => permission('ask'));
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('policy write failed'));
    await expect(store.updateAgentGrantChanges('caller', () => permission('off'))).rejects.toThrow('policy write failed');
    expect(store.agentGrantChangePending('caller')).toBe(false);
    expect(store.getAgentGrantChanges('caller')?.changes[0].mode).toBe('ask');
    vi.resetModules();
    const restarted = await import('./agent-grants-store');
    expect(restarted.getAgentGrantChanges('caller')?.changes[0].mode).toBe('ask');
    await restarted.updateAgentGrantChanges('other', () => permission('allow'));
    expect(restarted.getAgentGrantChanges('caller')?.changes[0].mode).toBe('ask');
    expect(restarted.getAgentGrantChanges('other')?.changes[0].mode).toBe('allow');
  });
});
