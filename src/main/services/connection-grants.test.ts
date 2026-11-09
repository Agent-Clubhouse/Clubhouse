import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ base: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({ peekProjects: async () => [{ path: '/p' }], onProjectsChanged: () => () => {} }));
vi.mock('./annex-identity', () => ({ getIdentity: () => ({ fingerprint: Array(16).fill('aa').join(':') }) }));
vi.mock('./annex-peers', () => ({ listPeers: () => [{ fingerprint: Array(16).fill('bb').join(':'), alias: 'Far', role: 'member', kind: 'desktop' }] }));
vi.mock('./agent-config', () => ({ peekDurableConfigs: async () => [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }], onAgentConfigChanged: () => () => {} }));
state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-grants-'));

import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  connectionMigrationDone, deniedConnectionTools, getConnectionDirection, listConnectionDirections, removeConnectionDirections, setConnectionTools,
  _forgetConnectionMigrationForTesting, _setConnectionGrantsVersionForTesting,
} from './connection-grants-store';
import { appLog } from './log-service';
import {
  AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION, applyConnectionTools, connectAcrossMachines, disconnectAcrossMachines, forgetConnectionAgent, makeTwoWay,
  migrateAutomaticConnectionTools, readLocalDirectionTools, removeUserLink, setToolsAcrossMachines, startConnectionGrants,
  _resetConnectionFileWarningForTesting,
} from './connection-grants';
import {
  applyPersistedBinding, markBindingRemovedByUser, rebuildPersistedBindings, registerPersistedBindingSource, _resetPersistedBindingSourcesForTesting,
  type PersistedBinding,
} from './persisted-bindings';

const A = { agentId: 'a' };
const B = { agentId: 'b' };
const toolsOf = (agentId: string, targetId: string) => bindingManager.getBindingsForAgent(agentId).find((b) => b.targetId === targetId)?.disabledTools;
let stop: () => void = () => {};

beforeEach(async () => {
  bindingManager._resetForTesting?.();
  _resetPersistedBindingSourcesForTesting();
  await removeConnectionDirections('a');
  await removeConnectionDirections('b');
  await removeConnectionDirections('z');
  await removeConnectionDirections('h');
  await removeConnectionDirections('disp');
  await _forgetConnectionMigrationForTesting(AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION);
  _resetConnectionFileWarningForTesting();
  stop = startConnectionGrants();
});
afterEach(() => stop());

describe('connection permissions (D129)', () => {
  it('an edit saves one direction in the store, and the live wire follows', async () => {
    bindingManager.bind('a', { targetId: 'b', targetKind: 'agent', label: 'beta' });
    await applyConnectionTools('a', 'b', ['clear_agent']);
    expect(deniedConnectionTools(A, B)).toEqual(['clear_agent']);
    expect(toolsOf('a', 'b')).toEqual(['clear_agent']);
    // The other direction is its own.
    expect(getConnectionDirection(B, A)).toBeUndefined();
  });

  it('a new binding takes its list from the store', async () => {
    await setConnectionTools(A, B, ['send_file']);
    bindingManager.bind('a', { targetId: 'b', targetKind: 'agent', label: 'beta' });
    expect(toolsOf('a', 'b')).toEqual(['send_file']);
  });

  it('a restored wire keeps the store\'s list, and one the store doesn\'t have moves in', async () => {
    // Migration: the wire's own list, from before the store.
    applyPersistedBinding({ agentId: 'a', targetId: 'b', targetKind: 'agent', label: 'beta', disabledTools: ['compact_agent'] });
    await vi.waitFor(() => expect(deniedConnectionTools(A, B)).toEqual(['compact_agent']));
    expect(toolsOf('a', 'b')).toEqual(['compact_agent']);
    // Changed on the card since: the canvas's older copy doesn't win.
    await applyConnectionTools('a', 'b', []);
    bindingManager.unbind('a', 'b');
    applyPersistedBinding({ agentId: 'a', targetId: 'b', targetKind: 'agent', label: 'beta', disabledTools: ['compact_agent'] });
    expect(toolsOf('a', 'b')).toBeUndefined();
    expect(deniedConnectionTools(A, B)).toEqual([]);
  });

  it('a canvas wire bound again (restore) only fills a store that has none', async () => {
    bindingManager.bind('a', { targetId: 'b', targetKind: 'agent', label: 'beta' });
    await applyConnectionTools('a', 'b', ['clear_agent']);
    await applyConnectionTools('a', 'b', ['send_message'], { restore: true });
    expect(deniedConnectionTools(A, B)).toEqual(['clear_agent']);
  });

  it('a canvas wire bound again with no live binding writes nothing', async () => {
    await applyConnectionTools('a', 'b', ['send_message'], { restore: true });
    expect(getConnectionDirection(A, B)).toBeUndefined();
  });

  it('a deleted agent\'s link isn\'t bound again, and its entries go', async () => {
    await makeTwoWay('a', 'gone');
    expect(bindingManager.getBindingsForAgent('a').some((b) => b.targetId === 'gone')).toBe(false);
    await forgetConnectionAgent('gone');
    expect(listConnectionDirections('gone')).toEqual([]);
  });

  it('Make two-way connects a pair the user removed this session, starting like a new connection', async () => {
    await setConnectionTools(B, A, []); // a leftover entry, everything on
    markBindingRemovedByUser('b', 'a');
    await makeTwoWay('b', 'a');
    expect(toolsOf('b', 'a')).toEqual(['clear_agent', 'compact_agent']);
  });

  it('other targets keep their list on the binding alone', async () => {
    bindingManager.bind('a', { targetId: 'w1', targetKind: 'browser', label: 'Browser' });
    await applyConnectionTools('a', 'w1', ['browser_click']);
    expect(toolsOf('a', 'w1')).toEqual(['browser_click']);
    expect(listConnectionDirections('a').some((d) => d.to.agentId === 'w1')).toBe(false);
  });

  it('Make two-way is the user\'s own link: bound by the store, starting like a new connection, and removable', async () => {
    bindingManager.bind('a', { targetId: 'b', targetKind: 'agent', label: 'beta' });
    await makeTwoWay('b', 'a');
    expect(getConnectionDirection(B, A)).toMatchObject({ link: expect.any(Object), disabledTools: ['clear_agent', 'compact_agent'] });
    expect(toolsOf('b', 'a')).toEqual(['clear_agent', 'compact_agent']);
    expect(bindingManager.getBindingsForAgent('b')[0]).toMatchObject({ targetName: 'alpha' });
    await removeUserLink('b', 'a');
    await rebuildPersistedBindings();
    expect(bindingManager.getBindingsForAgent('b')).toEqual([]);
  });
});

describe('connections with agents on other machines (#3064)', () => {
  const FAR = Array(16).fill('bb').join(':');
  const far = { agentId: 'z', machineId: FAR };

  it('connects an agent here with one there: a link each way, new-connection tools, and a binding to its address with its name', async () => {
    await connectAcrossMachines('a', `z@${FAR}`, { twoWay: true, name: 'Zed' });
    expect(getConnectionDirection(A, far)).toMatchObject({ link: expect.anything(), disabledTools: ['clear_agent', 'compact_agent'] });
    expect(getConnectionDirection(far, A)).toMatchObject({ link: expect.anything() });
    const binding = bindingManager.getBindingsForAgent('a').find((b) => b.targetId === `z@${FAR}`);
    expect(binding).toMatchObject({ targetKind: 'agent', targetName: 'Zed', agentName: 'alpha', disabledTools: ['clear_agent', 'compact_agent'] });
    // The other machine's agent holds the way back: nothing is bound here for it.
    expect(bindingManager.getBindingsForAgent(`z@${FAR}`)).toHaveLength(0);
  });

  it('a card edit on a wire to another machine saves under its machine, and the wire follows', async () => {
    await connectAcrossMachines('a', `z@${FAR}`);
    await applyConnectionTools('a', `z@${FAR}`, ['send_file']);
    expect(deniedConnectionTools(A, far)).toEqual(['send_file']);
    expect(deniedConnectionTools(A, { agentId: 'z' })).toBeUndefined();
    await vi.waitFor(() => expect(toolsOf('a', `z@${FAR}`)).toEqual(['send_file']));
  });

  it('removes both links, and the binding goes', async () => {
    await connectAcrossMachines('a', `z@${FAR}`, { twoWay: true });
    await disconnectAcrossMachines('a', `z@${FAR}`);
    expect(getConnectionDirection(A, far)?.link).toBeFalsy();
    expect(getConnectionDirection(far, A)?.link).toBeFalsy();
    await vi.waitFor(() => expect(bindingManager.getBindingsForAgent('a').some((b) => b.targetId === `z@${FAR}`)).toBe(false));
  });

  it('switches tools on either direction with an agent there, and refuses a direction that isn\'t linked', async () => {
    await connectAcrossMachines('a', `z@${FAR}`, { twoWay: true });
    await setToolsAcrossMachines('a', `z@${FAR}`, false, ['wake_agent']);
    expect(deniedConnectionTools(far, A)).toEqual(['wake_agent']);
    await setToolsAcrossMachines('a', `z@${FAR}`, true, []);
    expect(deniedConnectionTools(A, far)).toEqual([]);
    await disconnectAcrossMachines('a', `z@${FAR}`);
    await expect(setToolsAcrossMachines('a', `z@${FAR}`, true, [])).rejects.toThrow('not connected');
  });

  it('refuses an address on this machine', async () => {
    await expect(connectAcrossMachines('a', `b@${Array(16).fill('aa').join(':')}`)).rejects.toThrow('this computer');
    await expect(connectAcrossMachines('a', 'b')).rejects.toThrow('this computer');
  });

  it('connects only with a computer in the network (D238)', async () => {
    await expect(connectAcrossMachines('a', `z@${Array(16).fill('cc').join(':')}`)).rejects.toThrow('Annex Network');
  });

  it('a second connect keeps a linked direction as it is, so the other machine\'s newer edits stand', async () => {
    await connectAcrossMachines('a', `z@${FAR}`);
    await applyConnectionTools('a', `z@${FAR}`, []);
    const before = getConnectionDirection(A, far)!;
    await connectAcrossMachines('a', `z@${FAR}`);
    expect(getConnectionDirection(A, far)).toEqual(before);
  });

  it('deleting an agent turns its links with other machines off rather than dropping them, so they hear', async () => {
    await connectAcrossMachines('a', `z@${FAR}`, { twoWay: true });
    await setConnectionTools(A, B, []);
    await forgetConnectionAgent('a');
    expect(getConnectionDirection(A, far)).toMatchObject({ disabledTools: expect.any(Array) });
    expect(getConnectionDirection(A, far)?.link).toBeFalsy();
    expect(getConnectionDirection(far, A)?.link).toBeFalsy();
    expect(getConnectionDirection(A, B)).toBeUndefined();
  });
});

describe('connections Clubhouse makes start without clear or compact (#3214)', () => {
  const H = { agentId: 'h' };
  const DISP = { agentId: 'disp' };
  const AUTOMATIC = ['helper-wires', 'dispatcher-wires'];
  const starting = { disabledTools: ['clear_agent', 'compact_agent'], startingTools: true as const };
  const wire = (agentId: string, targetId: string, extra: Partial<PersistedBinding> = {}): PersistedBinding => ({ agentId, targetId, targetKind: 'agent', label: targetId, ...extra });
  /** A helper `h` of `a`, and `a` connected to the Dispatcher `disp`, as their sources list them. */
  const helperWires = () => [wire('a', 'h', { disabledTools: [], startingTools: true }), wire('h', 'a', starting)];
  const dispatcherWires = () => [wire('disp', 'a', starting), wire('a', 'disp', starting)];
  let canvas: PersistedBinding[] = [];
  let unregister: Array<() => void> = [];

  beforeEach(() => {
    canvas = [];
    unregister = [
      // Registered first, as the app does, so a wire the user drew binds the pair before a helper or Dispatcher link.
      registerPersistedBindingSource({ id: 'canvas-wires', readOnlyCollect: true, collect: async () => canvas }),
      registerPersistedBindingSource({ id: 'helper-wires', prune: true, collect: async () => helperWires() }),
      registerPersistedBindingSource({ id: 'dispatcher-wires', prune: true, collect: async () => dispatcherWires() }),
    ];
  });
  afterEach(() => { for (const u of unregister) u(); });

  it('a fresh Dispatcher link and a helper\'s link to its parent start without clear or compact; the parent keeps them over its helper', async () => {
    await rebuildPersistedBindings();
    expect(toolsOf('disp', 'a')).toEqual(['clear_agent', 'compact_agent']);
    expect(toolsOf('a', 'disp')).toEqual(['clear_agent', 'compact_agent']);
    expect(toolsOf('h', 'a')).toEqual(['clear_agent', 'compact_agent']);
    expect(toolsOf('a', 'h')).toBeUndefined();
    // What Manage reads back: clear and compact off, wake off.
    expect(readLocalDirectionTools('a', 'disp').disabled).toEqual(['clear_agent', 'compact_agent', 'wake_agent']);
    expect(readLocalDirectionTools('disp', 'a').disabled).toEqual(['clear_agent', 'compact_agent', 'wake_agent']);
    expect(readLocalDirectionTools('a', 'h').disabled).toEqual(['wake_agent']);
    // Live only until the one-time pass has run: it decides for older connections.
    expect(listConnectionDirections('a')).toEqual([]);
  });

  it('the one-time pass keeps each older connection\'s starting list, and only where nothing is saved', async () => {
    await rebuildPersistedBindings();
    expect(await migrateAutomaticConnectionTools(AUTOMATIC)).toBe('done');
    for (const [from, to] of [[H, A], [DISP, A], [A, DISP]]) {
      expect(getConnectionDirection(from, to)).toMatchObject({ disabledTools: ['clear_agent', 'compact_agent'] });
      expect(getConnectionDirection(from, to)?.setBy).toBeUndefined();
      expect(getConnectionDirection(from, to)?.enabledTools).toBeUndefined();
    }
    // Everything on is the parent's start: no entry needed.
    expect(getConnectionDirection(A, H)).toBeUndefined();
    expect(connectionMigrationDone(AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION)).toBe(true);
  });

  it('never touches a direction the user changed, or a link they made two-way', async () => {
    await setConnectionTools(H, A, []); // the user turned clear and compact on for the helper
    await setConnectionTools(A, DISP, ['send_file'], ['wake_agent']);
    await rebuildPersistedBindings();
    expect(toolsOf('h', 'a')).toBeUndefined();
    await makeTwoWay('disp', 'a');
    const linked = getConnectionDirection(DISP, A);
    expect(await migrateAutomaticConnectionTools(AUTOMATIC)).toBe('done');
    expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: [] });
    expect(getConnectionDirection(A, DISP)).toMatchObject({ disabledTools: ['send_file'], enabledTools: ['wake_agent'] });
    expect(getConnectionDirection(DISP, A)).toEqual(linked);
  });

  it('an older canvas wire with no list over a helper or Dispatcher link gets the starting list on the first run; one with its own list keeps it', async () => {
    canvas = [wire('h', 'a'), wire('a', 'disp', { disabledTools: ['send_file'] })];
    await rebuildPersistedBindings();
    // The canvas bound both first. With no list of its own, the helper's starting list applies.
    expect(toolsOf('h', 'a')).toEqual(['clear_agent', 'compact_agent']);
    await vi.waitFor(() => expect(getConnectionDirection(A, DISP)).toMatchObject({ disabledTools: ['send_file'] }));
    const stored = getConnectionDirection(A, DISP);
    expect(await migrateAutomaticConnectionTools(AUTOMATIC)).toBe('done');
    expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: ['clear_agent', 'compact_agent'] });
    expect(getConnectionDirection(A, DISP)).toEqual(stored);
    // Restart: the canvas binds the pair first again, and the saved list applies.
    bindingManager._resetForTesting?.();
    await rebuildPersistedBindings();
    expect(toolsOf('h', 'a')).toEqual(['clear_agent', 'compact_agent']);
    expect(toolsOf('a', 'disp')).toEqual(['send_file']);
  });

  it('never overrides a saved everything-on, whichever source binds the pair', async () => {
    await setConnectionTools(H, A, []);
    canvas = [wire('h', 'a')];
    await rebuildPersistedBindings();
    expect(await migrateAutomaticConnectionTools(AUTOMATIC)).toBe('done');
    await rebuildPersistedBindings();
    expect(toolsOf('h', 'a')).toBeUndefined();
    expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: [] });
  });

  it('the first source to give a direction its starting list decides: an orchestrator connection doesn\'t start a parent with less over its own helper', async () => {
    unregister.push(registerPersistedBindingSource({ id: 'orchestrator-connections', prune: true, collect: async () => [wire('a', 'h', starting)] }));
    await rebuildPersistedBindings();
    expect(toolsOf('a', 'h')).toBeUndefined();
    expect(await migrateAutomaticConnectionTools([...AUTOMATIC, 'orchestrator-connections'])).toBe('done');
    expect(getConnectionDirection(A, H)).toBeUndefined();
    await rebuildPersistedBindings();
    expect(toolsOf('a', 'h')).toBeUndefined();
  });

  it('a starting list that couldn\'t be saved is saved on a later rebuild, after a canvas wire is drawn over the pair', async () => {
    await rebuildPersistedBindings();
    expect(await migrateAutomaticConnectionTools(AUTOMATIC)).toBe('done');
    await removeConnectionDirections('h');
    // A newer build's file: the save is skipped, and said once however many rebuilds run.
    await _setConnectionGrantsVersionForTesting(99);
    bindingManager._resetForTesting?.();
    vi.mocked(appLog).mockClear();
    await rebuildPersistedBindings();
    await rebuildPersistedBindings();
    expect(toolsOf('h', 'a')).toEqual(['clear_agent', 'compact_agent']);
    expect(getConnectionDirection(H, A)).toBeUndefined();
    expect(vi.mocked(appLog).mock.calls.filter(([, level, message]) => level === 'warn' && String(message).includes('newer Clubhouse'))).toHaveLength(1);
    await _setConnectionGrantsVersionForTesting(1);
    canvas = [wire('h', 'a'), wire('a', 'h')];
    await rebuildPersistedBindings();
    await vi.waitFor(() => expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: ['clear_agent', 'compact_agent'] }));
    expect(getConnectionDirection(A, H)).toBeUndefined();
  });

  it('waits while the file is a newer build\'s, saying so once, and runs once it isn\'t', async () => {
    await _setConnectionGrantsVersionForTesting(99);
    try {
      vi.mocked(appLog).mockClear();
      await rebuildPersistedBindings();
      expect(await migrateAutomaticConnectionTools(AUTOMATIC)).toBe('deferred');
      expect(await migrateAutomaticConnectionTools(AUTOMATIC)).toBe('deferred');
      expect(connectionMigrationDone(AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION)).toBe(false);
      expect(vi.mocked(appLog).mock.calls.filter(([, level, message]) => level === 'warn' && String(message).includes('newer Clubhouse'))).toHaveLength(1);
    } finally {
      await _setConnectionGrantsVersionForTesting(1);
    }
    expect(await migrateAutomaticConnectionTools(AUTOMATIC)).toBe('done');
    expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: ['clear_agent', 'compact_agent'] });
  });

  it('drawing a canvas wire over a helper or Dispatcher link keeps the choices saved for it', async () => {
    await rebuildPersistedBindings();
    await migrateAutomaticConnectionTools(AUTOMATIC);
    await applyConnectionTools('h', 'a', ['send_file']); // the user's choice on the card
    // The canvas wire comes back with a list of its own: the saved one stands.
    await applyConnectionTools('h', 'a', ['clear_agent', 'compact_agent'], { restore: true });
    expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: ['send_file'] });
    expect(toolsOf('h', 'a')).toEqual(['send_file']);
    // And a wire drawn over the pair binds nothing new: the rebuild keeps the saved list too.
    canvas = [wire('h', 'a'), wire('a', 'h')];
    await rebuildPersistedBindings();
    expect(toolsOf('h', 'a')).toEqual(['send_file']);
    expect(getConnectionDirection(A, H)).toBeUndefined();
  });

  it('waits while a source can\'t be read, since it might list the pair, and runs once it can', async () => {
    let broken = true;
    unregister.push(registerPersistedBindingSource({ id: 'unreadable', collect: async () => { if (broken) throw new Error('EACCES'); return []; } }));
    await rebuildPersistedBindings();
    expect(await migrateAutomaticConnectionTools(AUTOMATIC)).toBe('deferred');
    expect(getConnectionDirection(H, A)).toBeUndefined();
    expect(connectionMigrationDone(AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION)).toBe(false);
    // Still live meanwhile.
    expect(toolsOf('h', 'a')).toEqual(['clear_agent', 'compact_agent']);
    broken = false;
    await rebuildPersistedBindings();
    expect(await migrateAutomaticConnectionTools(AUTOMATIC)).toBe('done');
    expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: ['clear_agent', 'compact_agent'] });
  });

  it('a canvas wire drawn over a Dispatcher link before the pass keeps the list the link showed, across a restart', async () => {
    let broken = true;
    unregister.push(registerPersistedBindingSource({ id: 'unreadable', collect: async () => { if (broken) throw new Error('EACCES'); return []; } }));
    await rebuildPersistedBindings();
    expect(await migrateAutomaticConnectionTools(AUTOMATIC)).toBe('deferred');
    // Drawn over a bound pair, the wire carries no list of its own (newWireDisabledTools).
    canvas = [wire('a', 'disp')];
    broken = false;
    await rebuildPersistedBindings();
    expect(await migrateAutomaticConnectionTools(AUTOMATIC)).toBe('done');
    expect(getConnectionDirection(A, DISP)).toMatchObject({ disabledTools: ['clear_agent', 'compact_agent'] });
    // Restart: the canvas binds the pair first, and the saved list applies.
    bindingManager._resetForTesting?.();
    await rebuildPersistedBindings();
    expect(toolsOf('a', 'disp')).toEqual(['clear_agent', 'compact_agent']);
  });

  it('runs once: a later pass changes nothing, even where a direction lost its entry', async () => {
    await rebuildPersistedBindings();
    expect(await migrateAutomaticConnectionTools(AUTOMATIC)).toBe('done');
    await setConnectionTools(DISP, A, []);
    expect(await migrateAutomaticConnectionTools(AUTOMATIC)).toBe('already');
    expect(getConnectionDirection(DISP, A)).toMatchObject({ disabledTools: [] });
  });

  it('once the pass has run, a new helper or Dispatcher link keeps its starting list, and never over a saved one', async () => {
    await rebuildPersistedBindings();
    await migrateAutomaticConnectionTools(AUTOMATIC);
    await removeConnectionDirections('h');
    await setConnectionTools(A, DISP, []);
    bindingManager._resetForTesting?.();
    await rebuildPersistedBindings();
    await vi.waitFor(() => expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: ['clear_agent', 'compact_agent'] }));
    expect(getConnectionDirection(A, H)).toBeUndefined();
    expect(getConnectionDirection(A, DISP)).toMatchObject({ disabledTools: [] });
    expect(toolsOf('a', 'disp')).toBeUndefined();
  });
});
