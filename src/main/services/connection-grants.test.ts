import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ base: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherState: () => ({ config: null }), getDispatcherChatConfig: () => null }));
vi.mock('./project-store', () => ({ peekProjects: async () => [{ path: '/p' }], onProjectsChanged: () => () => {} }));
vi.mock('./annex-identity', () => ({ getIdentity: () => ({ fingerprint: Array(16).fill('aa').join(':') }) }));
vi.mock('./annex-peers', () => ({ listPeers: () => [{ fingerprint: Array(16).fill('bb').join(':'), alias: 'Far', role: 'member', kind: 'desktop' }] }));
vi.mock('./agent-config', () => ({ peekDurableConfigs: async () => [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }], onAgentConfigChanged: () => () => {} }));
state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-grants-'));

import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  connectionMigrationDone, deniedConnectionTools, getConnectionDirection, listConnectionDirections, localConnectionWakeOn, onConnectionGrantsChanged,
  putConnectionDirection, updateAgentNetworkLinks, removeAgentNetworkSources, clearUserRemovedAgentNetworkSources, removeConnectionDirections, setConnectionDirections, setConnectionTools, _forgetConnectionMigrationForTesting, _setConnectionGrantsVersionForTesting,
} from './connection-grants-store';
import { appLog } from './log-service';
import {
  AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION, applyConnectionTools, connectAcrossMachines, disconnectAcrossMachines, forgetConnectionAgent, makeTwoWay,
  migrateAutomaticConnectionTools, readLocalDirectionTools, removeUserLink, setLocalWake, setToolsAcrossMachines, startConnectionGrants,
  _resetConnectionFileWarningForTesting,
} from './connection-grants';
import {
  applyPersistedBinding, isBindingRemovedByUser, markBindingRemovedByUser, onBindingDrawnByUser, rebuildPersistedBindings, registerPersistedBindingSource, startingTools, _resetPersistedBindingSourcesForTesting,
  type PersistedBinding,
} from './persisted-bindings';
import { AUTOMATIC_CONNECTION_SWITCHES } from '../../shared/connection-grants';
import { NEW_AGENT_WIRE_DISABLED_TOOLS } from '../../shared/wire-defaults';

const A = { agentId: 'a' };
const B = { agentId: 'b' };
const toolsOf = (agentId: string, targetId: string) => bindingManager.getBindingsForAgent(agentId).find((b) => b.targetId === targetId)?.disabledTools;
const grantsPath = () => path.join(state.base, 'connection-grants.json');
const savedGrants = () => fs.readFileSync(grantsPath(), 'utf-8');
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

  it('Make two-way reconnects a removed pair without resetting its saved everything-on and wake-off switches', async () => {
    await setConnectionTools(B, A, []); // a leftover entry, everything on
    markBindingRemovedByUser('b', 'a');
    await makeTwoWay('b', 'a');
    expect(toolsOf('b', 'a') ?? []).toEqual([]);
    expect(localConnectionWakeOn('b', 'a')).toBe(false);
    expect(isBindingRemovedByUser('b', 'a')).toBe(false);
  });

  it('Make two-way leaves an already linked direction and its timestamps exactly as saved', async () => {
    const saved = {
      from: B, to: A, disabledTools: ['send_file', 'future_denied'],
      enabledTools: ['wake_agent', 'future_enabled'],
      link: { createdAt: '2025-01-01T00:00:00.000Z' }, updatedAt: '2025-02-01T00:00:00.000Z',
    };
    await putConnectionDirection(saved);
    const before = savedGrants();
    await makeTwoWay('b', 'a');
    expect(getConnectionDirection(B, A)).toEqual(saved);
    expect(savedGrants()).toBe(before);
  });

  it('Make two-way promotes saved disabled and custom switches without granting new defaults', async () => {
    await setConnectionTools(B, A, ['send_message', 'wake_agent', 'future_denied'], ['future_enabled']);
    const before = getConnectionDirection(B, A)!;
    await makeTwoWay('b', 'a');
    expect(getConnectionDirection(B, A)).toMatchObject({
      disabledTools: before.disabledTools, enabledTools: before.enabledTools, link: { createdAt: expect.any(String) },
    });
    expect(localConnectionWakeOn('b', 'a')).toBe(false);
  });

  it('Make two-way persistence failure keeps saved switches, links and the user-removal fence intact', async () => {
    await setConnectionTools(B, A, ['send_message'], ['future_enabled']);
    markBindingRemovedByUser('b', 'a');
    const before = getConnectionDirection(B, A);
    const bytes = savedGrants();
    const rename = fs.promises.rename;
    const fencesAtPersist: boolean[] = [];
    const fault = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === grantsPath()) {
        fencesAtPersist.push(isBindingRemovedByUser('b', 'a'));
        throw new Error('ENOSPC: injected grants persistence failure');
      }
      return rename(from, to);
    });
    try {
      await expect(makeTwoWay('b', 'a')).rejects.toThrow('ENOSPC');
      expect(fencesAtPersist).toEqual([true]);
      expect(getConnectionDirection(B, A)).toEqual(before);
      expect(savedGrants()).toBe(bytes);
      expect(isBindingRemovedByUser('b', 'a')).toBe(true);
      expect(bindingManager.getBindingsForAgent('b')).toEqual([]);
    } finally {
      fault.mockRestore();
    }
  });

  it.each([false, true])('Make two-way respects a newer removal during persistence (initially removed: %s)', async (initiallyRemoved) => {
    await setConnectionTools(B, A, ['send_message', 'future_denied'], ['future_enabled']);
    if (initiallyRemoved) markBindingRemovedByUser('b', 'a');
    const drawn = vi.fn();
    const unwatchDrawn = onBindingDrawnByUser(drawn);
    try {
      const promotion = makeTwoWay('b', 'a');
      queueMicrotask(() => markBindingRemovedByUser('b', 'a'));
      await expect.soft(promotion).rejects.toThrow(new Error('Connection permissions were saved, but a newer removal canceled this connection. The removal remains in effect.'));
      expect.soft(isBindingRemovedByUser('b', 'a')).toBe(true);
      expect.soft(bindingManager.getBindingsForAgent('b')).toEqual([]);
      expect.soft(drawn).not.toHaveBeenCalled();
      expect(getConnectionDirection(B, A)).toMatchObject({ disabledTools: ['send_message', 'future_denied'], enabledTools: ['future_enabled'] });
      expect(JSON.parse(savedGrants())).toMatchObject({
        directions: expect.arrayContaining([
          expect.objectContaining({ from: B, to: A, disabledTools: ['send_message', 'future_denied'], enabledTools: ['future_enabled'] }),
        ]),
      });
      await makeTwoWay('b', 'a');
      expect(isBindingRemovedByUser('b', 'a')).toBe(false);
      expect(bindingManager.getBindingsForAgent('b').some((b) => b.targetId === 'a')).toBe(true);
      expect(drawn).toHaveBeenCalledExactlyOnceWith('b', 'a');
    } finally {
      unwatchDrawn();
    }
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
    expect(getConnectionDirection(B, A)).toMatchObject({ link: expect.any(Object), disabledTools: ['clear_agent', 'compact_agent'], enabledTools: ['wake_agent'] });
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

  it('merges independently created agent sources and does not resurrect a removed one from a stale peer', async () => {
    const first = { agentId: 'one', machineId: FAR, createdAt: '2026-01-01T00:00:00.000Z' };
    const second = { agentId: 'two', machineId: FAR, createdAt: '2026-01-01T00:00:01.000Z' };
    await putConnectionDirection({ from: A, to: far, disabledTools: [], agentLinks: [first], updatedAt: '2026-01-01T00:00:02.000Z' });
    await putConnectionDirection({ from: A, to: far, disabledTools: [], agentLinks: [second], updatedAt: '2026-01-01T00:00:01.000Z' });
    expect(getConnectionDirection(A, far)?.agentLinks).toEqual([first, second]);
    await putConnectionDirection({ from: A, to: far, disabledTools: [], agentLinks: [{ ...first, removedAt: '2026-01-01T00:00:03.000Z' }], updatedAt: '2026-01-01T00:00:03.000Z' });
    await putConnectionDirection({ from: A, to: far, disabledTools: [], agentLinks: [first], updatedAt: '2026-01-01T00:00:02.000Z' });
    expect(getConnectionDirection(A, far)?.agentLinks).toEqual([{ ...first, removedAt: '2026-01-01T00:00:03.000Z' }, second]);
  });

  it('keeps a user-removal tombstone despite later recreated sources until the user reconnects', async () => {
    const first = { agentId: 'maker', machineId: FAR, createdAt: '2026-01-01T00:00:00.000Z' };
    await putConnectionDirection({ from: A, to: far, disabledTools: [], agentLinks: [first], updatedAt: first.createdAt });
    await removeAgentNetworkSources(A, far);
    const removed = getConnectionDirection(A, far)!.agentLinks![0];
    const newer = new Date(Date.parse(removed.removedAt!) + 1000).toISOString();
    await putConnectionDirection({ from: A, to: far, disabledTools: [], agentLinks: [{ ...first, createdAt: newer }], updatedAt: newer });
    expect(getConnectionDirection(A, far)?.agentLinks).toEqual([removed]);
    await clearUserRemovedAgentNetworkSources(A, far);
    const cleared = getConnectionDirection(A, far)!.agentLinks![0];
    const readded = { ...first, createdAt: new Date(Date.parse(cleared.removedAt!) + 1000).toISOString() };
    await putConnectionDirection({ from: A, to: far, disabledTools: [], agentLinks: [readded], updatedAt: readded.createdAt });
    expect(getConnectionDirection(A, far)?.agentLinks).toEqual([readded]);
  });

  it('deleting an endpoint removes sources without creating user-removal tombstones', async () => {
    await updateAgentNetworkLinks([{ from: A, to: far }], { agentId: 'maker', machineId: FAR }, 'add');
    await forgetConnectionAgent('a');
    expect(getConnectionDirection(A, far)?.agentLinks?.[0]).toMatchObject({ removedAt: expect.any(String) });
    expect(getConnectionDirection(A, far)?.agentLinks?.[0].removedByUser).toBeUndefined();
  });

  it('requires the sender computer to confirm switches are agent-owned before changing a remote sender direction', async () => {
    const owner = { agentId: 'maker', machineId: Array(16).fill('aa').join(':') };
    const pair = { from: far, to: A };
    await updateAgentNetworkLinks([pair], owner, 'add');
    await expect(updateAgentNetworkLinks([pair], owner, 'tools', [['send_file']])).rejects.toThrow('owns these switches');
    const before = getConnectionDirection(far, A)!;
    await putConnectionDirection({ ...before, agentToolsProtected: false });
    await updateAgentNetworkLinks([pair], owner, 'tools', [['send_file']]);
    expect(getConnectionDirection(far, A)?.disabledTools).toEqual(['send_file']);
  });

  it('restores an agent source for two local agents when it was made by another computer', async () => {
    const at = '2026-01-01T00:00:00.000Z';
    await putConnectionDirection({ from: A, to: B, disabledTools: ['clear_agent', 'compact_agent'], enabledTools: ['wake_agent'], agentLinks: [{ agentId: 'maker', machineId: FAR, createdAt: at }], updatedAt: at });
    await rebuildPersistedBindings();
    expect(bindingManager.getBindingsForAgent('a')).toEqual(expect.arrayContaining([expect.objectContaining({ targetId: 'b', targetName: 'beta' })]));
    expect(readLocalDirectionTools('a', 'b').allowed).toContain('wake_agent');
  });

  it('connects an agent here with one there: a link each way, new-connection tools, and a binding to its address with its name', async () => {
    await connectAcrossMachines('a', `z@${FAR}`, { twoWay: true, name: 'Zed' });
    expect(getConnectionDirection(A, far)).toMatchObject({ link: expect.anything(), disabledTools: ['clear_agent', 'compact_agent'], enabledTools: ['wake_agent'] });
    expect(getConnectionDirection(far, A)).toMatchObject({ link: expect.anything(), disabledTools: ['clear_agent', 'compact_agent'], enabledTools: ['wake_agent'] });
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
    await connectAcrossMachines('a', `z@${FAR}`, { twoWay: true });
    expect(getConnectionDirection(A, far)).toEqual(before);
    expect(getConnectionDirection(far, A)).toMatchObject({ disabledTools: ['clear_agent', 'compact_agent'], enabledTools: ['wake_agent'], link: expect.anything() });
  });

  it('remote two-way promotion retains both saved switch maps and commits both links before notifying', async () => {
    await setConnectionTools(A, far, ['send_message', 'future_denied'], ['future_enabled']);
    await setConnectionTools(far, A, ['wake_agent'], []);
    const before = [getConnectionDirection(A, far)!, getConnectionDirection(far, A)!];
    markBindingRemovedByUser('a', `z@${FAR}`);
    const observations: boolean[][] = [];
    const unsubscribe = onConnectionGrantsChanged(() => observations.push([
      !!getConnectionDirection(A, far)?.link, !!getConnectionDirection(far, A)?.link,
    ]));
    const rename = fs.promises.rename;
    const writes: unknown[] = [];
    const observe = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === grantsPath()) writes.push(JSON.parse(fs.readFileSync(String(from), 'utf-8')));
      return rename(from, to);
    });
    try {
      await connectAcrossMachines('a', `z@${FAR}`, { twoWay: true });
      expect.soft([getConnectionDirection(A, far), getConnectionDirection(far, A)].map((d) => ({
        disabledTools: d?.disabledTools, enabledTools: d?.enabledTools,
      }))).toEqual(before.map((d) => ({ disabledTools: d.disabledTools, enabledTools: d.enabledTools })));
      expect.soft(writes).toHaveLength(1);
      expect.soft(writes[0]).toMatchObject({
        directions: expect.arrayContaining([
          expect.objectContaining({ from: A, to: far, link: expect.anything() }),
          expect.objectContaining({ from: far, to: A, link: expect.anything() }),
        ]),
      });
      expect.soft(observations).toEqual([[true, true], [true, true]]);
      expect.soft(isBindingRemovedByUser('a', `z@${FAR}`)).toBe(true);
    } finally {
      observe.mockRestore();
      unsubscribe();
    }
  });

  it('remote two-way persistence failure cannot expose a half-link, overwrite switches or clear a removal', async () => {
    await setConnectionTools(A, far, ['send_file', 'future_denied'], ['future_enabled']);
    await setConnectionTools(far, A, ['send_message'], []);
    markBindingRemovedByUser('a', `z@${FAR}`);
    const before = [getConnectionDirection(A, far), getConnectionDirection(far, A)];
    const bytes = savedGrants();
    const observations: boolean[][] = [];
    const unsubscribe = onConnectionGrantsChanged(() => observations.push([
      !!getConnectionDirection(A, far)?.link, !!getConnectionDirection(far, A)?.link,
    ]));
    const rename = fs.promises.rename;
    const fault = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === grantsPath()) {
        const next = JSON.parse(fs.readFileSync(String(from), 'utf-8')) as { directions: Array<{ from: { machineId?: string }; disabledTools: string[]; link?: unknown }> };
        const reverse = next.directions.find((d) => d.from.machineId === FAR);
        if (reverse?.link || reverse?.disabledTools.join(',') !== 'send_message') throw new Error('ENOSPC: injected reverse-link failure');
      }
      return rename(from, to);
    });
    try {
      await expect(connectAcrossMachines('a', `z@${FAR}`, { twoWay: true })).rejects.toThrow('ENOSPC');
      expect.soft([getConnectionDirection(A, far), getConnectionDirection(far, A)]).toEqual(before);
      expect.soft(savedGrants()).toBe(bytes);
      expect.soft(observations).toEqual([]);
      expect.soft(isBindingRemovedByUser('a', `z@${FAR}`)).toBe(true);
      expect.soft(toolsOf('a', `z@${FAR}`)).toBeUndefined();
    } finally {
      fault.mockRestore();
      unsubscribe();
    }
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

describe('connections start as the maintainer set them, 2026-11-09 (#3214)', () => {
  const H = { agentId: 'h' };
  const DISP = { agentId: 'disp' };
  const AUTOMATIC = ['helper-wires', 'dispatcher-wires'];
  const DRAWN = ['canvas-wires'];
  const CLEAR_COMPACT = ['clear_agent', 'compact_agent'];
  const ALL = ['get_status', 'read_output', 'check_connectivity', 'send_message', 'send_file', 'clear_agent', 'compact_agent', 'wake_agent'];
  const SEND_AND_WAKE = ['get_status', 'read_output', 'check_connectivity', 'send_message', 'send_file', 'wake_agent'];
  const wire = (agentId: string, targetId: string, extra: Partial<PersistedBinding> = {}): PersistedBinding => ({ agentId, targetId, targetKind: 'agent', label: targetId, ...extra });
  /** A helper `h` of `a`, and `a` connected to the Dispatcher `disp`, as their sources list them. */
  const helperWires = () => [
    wire('a', 'h', startingTools(AUTOMATIC_CONNECTION_SWITCHES.parentToHelper)),
    wire('h', 'a', startingTools(AUTOMATIC_CONNECTION_SWITCHES.helperToParent)),
  ];
  const dispatcherWires = () => [
    wire('disp', 'a', startingTools(AUTOMATIC_CONNECTION_SWITCHES.dispatcherToAgent)),
    wire('a', 'disp', startingTools(AUTOMATIC_CONNECTION_SWITCHES.agentToDispatcher)),
  ];
  const migrate = () => migrateAutomaticConnectionTools(AUTOMATIC, DRAWN);
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

  it('starts every new direction, including parent to helper, with wake on and clear and compact off', async () => {
    unregister.push(registerPersistedBindingSource({
      id: 'orchestrator-connections', prune: true, collect: async () => [wire('a', 'b', startingTools(AUTOMATIC_CONNECTION_SWITCHES.orchestratorLink))],
    }));
    await rebuildPersistedBindings();
    for (const [from, to] of [['a', 'h'], ['h', 'a'], ['disp', 'a'], ['a', 'disp'], ['a', 'b']]) {
      expect(readLocalDirectionTools(from, to)).toEqual({ allowed: SEND_AND_WAKE, disabled: CLEAR_COMPACT });
      expect(toolsOf(from, to)).toEqual(CLEAR_COMPACT);
      expect(localConnectionWakeOn(from, to)).toBe(true);
    }
    // Live only until the one-time pass has run: it decides for older connections.
    expect(listConnectionDirections('a')).toEqual([]);
  });

  it('the one-time pass keeps each older connection\'s starting lists, wake included, and only where nothing is saved', async () => {
    await rebuildPersistedBindings();
    expect(await migrate()).toBe('done');
    for (const [from, to] of [[A, H], [H, A], [DISP, A], [A, DISP]]) {
      expect(getConnectionDirection(from, to)).toMatchObject({ disabledTools: CLEAR_COMPACT, enabledTools: ['wake_agent'] });
      expect(getConnectionDirection(from, to)?.setBy).toBeUndefined();
    }
    expect(localConnectionWakeOn('a', 'h')).toBe(true);
    expect(connectionMigrationDone(AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION)).toBe(true);
  });

  it('never touches a direction the user changed, or a link they made two-way', async () => {
    await setConnectionTools(H, A, []); // the user turned clear and compact on for the helper, and left wake off
    await setConnectionTools(A, DISP, ['send_file'], ['wake_agent']);
    await rebuildPersistedBindings();
    expect(toolsOf('h', 'a')).toBeUndefined();
    expect(localConnectionWakeOn('h', 'a')).toBe(false);
    await makeTwoWay('disp', 'a');
    const linked = getConnectionDirection(DISP, A);
    expect(await migrate()).toBe('done');
    expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: [] });
    expect(getConnectionDirection(H, A)?.enabledTools).toBeUndefined();
    expect(getConnectionDirection(A, DISP)).toMatchObject({ disabledTools: ['send_file'], enabledTools: ['wake_agent'] });
    expect(getConnectionDirection(DISP, A)).toEqual(linked);
  });

  it('an older canvas wire with no list over a helper or Dispatcher link gets that link\'s start on the first run; one with its own list keeps it', async () => {
    canvas = [wire('h', 'a'), wire('a', 'h'), wire('a', 'disp', { disabledTools: ['send_file'] })];
    await rebuildPersistedBindings();
    // The canvas bound them first. With no list of its own, the helper's starting lists apply.
    expect(toolsOf('h', 'a')).toEqual(CLEAR_COMPACT);
    expect(localConnectionWakeOn('h', 'a')).toBe(true);
    await vi.waitFor(() => expect(getConnectionDirection(A, DISP)).toMatchObject({ disabledTools: ['send_file'] }));
    const stored = getConnectionDirection(A, DISP);
    expect(await migrate()).toBe('done');
    expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: CLEAR_COMPACT, enabledTools: ['wake_agent'] });
    expect(getConnectionDirection(A, H)).toMatchObject({ disabledTools: CLEAR_COMPACT, enabledTools: ['wake_agent'] });
    expect(getConnectionDirection(A, DISP)).toEqual(stored);
    // Restart: the canvas binds the pair first again, and the saved list applies.
    bindingManager._resetForTesting?.();
    await rebuildPersistedBindings();
    expect(toolsOf('h', 'a')).toEqual(CLEAR_COMPACT);
    expect(toolsOf('a', 'disp')).toEqual(['send_file']);
    expect(localConnectionWakeOn('a', 'disp')).toBe(false);
  });

  it('a wire the user drew with no list, that no Clubhouse link lists, starts like a new connection on the first run; one with a list, or removed, is left', async () => {
    canvas = [wire('a', 'b'), wire('b', 'a', { disabledTools: [] }), wire('z', 'b')];
    markBindingRemovedByUser('z', 'b');
    await rebuildPersistedBindings();
    // Before the pass: an older wire, every tool on, wake off.
    expect(readLocalDirectionTools('a', 'b')).toEqual({ allowed: ALL.filter((t) => t !== 'wake_agent'), disabled: ['wake_agent'] });
    expect(await migrate()).toBe('done');
    expect(getConnectionDirection(A, B)).toMatchObject({ disabledTools: CLEAR_COMPACT, enabledTools: ['wake_agent'] });
    expect(getConnectionDirection(A, B)?.setBy).toBeUndefined();
    expect(toolsOf('a', 'b')).toEqual(CLEAR_COMPACT);
    expect(localConnectionWakeOn('a', 'b')).toBe(true);
    // An explicit everything-on on the wire is the user's list: left as it is.
    expect(getConnectionDirection(B, A)).toBeUndefined();
    expect(getConnectionDirection({ agentId: 'z' }, B)).toBeUndefined();
  });

  it('preserves saved directions exactly, including the old new-connection defaults with wake off', async () => {
    // A canvas wire drawn since #2969, and a Dispatcher link #3216 saved.
    await setConnectionTools(H, B, CLEAR_COMPACT);
    await setConnectionDirections([{ from: A, to: B, disabledTools: CLEAR_COMPACT, enabledTools: [] }], () => {});
    const before = [getConnectionDirection(H, B), getConnectionDirection(A, B)];
    await rebuildPersistedBindings();
    expect(await migrate()).toBe('done');
    expect([getConnectionDirection(H, B), getConnectionDirection(A, B)]).toEqual(before);
    expect(localConnectionWakeOn('h', 'b')).toBe(false);
  });

  it('leaves every other saved shape as it is', async () => {
    const Z = { agentId: 'z' };
    const FAR = { agentId: 'f', machineId: Array(16).fill('bb').join(':') };
    await setConnectionTools(A, B, ['clear_agent']); // only one of the two
    await setConnectionTools(B, A, [...CLEAR_COMPACT, 'send_file']); // one more off
    await setConnectionTools(H, B, CLEAR_COMPACT, ['some_newer_switch']); // something turned on
    await setConnectionTools(Z, B, []); // everything on
    await setConnectionDirections([{ from: Z, to: A, disabledTools: [...CLEAR_COMPACT, 'send_file'], enabledTools: [] }], () => {}); // the Dispatcher's, changed
    await makeTwoWay('b', 'z'); // a link, then set back to the old shape with no wake
    await setConnectionTools(B, Z, CLEAR_COMPACT, []);
    await setConnectionTools(A, FAR, CLEAR_COMPACT); // another computer: wake has its own rule there
    const before = [[A, B], [B, A], [H, B], [Z, B], [Z, A], [B, Z], [A, FAR]].map(([from, to]) => getConnectionDirection(from, to));
    await rebuildPersistedBindings();
    expect(await migrate()).toBe('done');
    expect([[A, B], [B, A], [H, B], [Z, B], [Z, A], [B, Z], [A, FAR]].map(([from, to]) => getConnectionDirection(from, to))).toEqual(before);
    expect(getConnectionDirection(B, Z)?.link).toBeDefined();
  });

  it('never overrides a saved everything-on, whichever source binds the pair', async () => {
    await setConnectionTools(H, A, []);
    canvas = [wire('h', 'a')];
    await rebuildPersistedBindings();
    expect(await migrate()).toBe('done');
    await rebuildPersistedBindings();
    expect(toolsOf('h', 'a')).toBeUndefined();
    expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: [] });
  });

  it('uses the same starting switches when both helper and tool sources hold a direction', async () => {
    unregister.push(registerPersistedBindingSource({
      id: 'orchestrator-connections', prune: true, collect: async () => [wire('a', 'h', startingTools(AUTOMATIC_CONNECTION_SWITCHES.orchestratorLink))],
    }));
    await rebuildPersistedBindings();
    expect(toolsOf('a', 'h')).toEqual(CLEAR_COMPACT);
    expect(await migrateAutomaticConnectionTools([...AUTOMATIC, 'orchestrator-connections'], DRAWN)).toBe('done');
    expect(getConnectionDirection(A, H)).toMatchObject({ disabledTools: CLEAR_COMPACT, enabledTools: ['wake_agent'] });
    await rebuildPersistedBindings();
    expect(toolsOf('a', 'h')).toEqual(CLEAR_COMPACT);
    expect(readLocalDirectionTools('a', 'h')).toEqual({ allowed: SEND_AND_WAKE, disabled: CLEAR_COMPACT });
  });

  it('a starting list that couldn\'t be saved is saved on a later rebuild, after a canvas wire is drawn over the pair', async () => {
    await rebuildPersistedBindings();
    expect(await migrate()).toBe('done');
    await removeConnectionDirections('h');
    // A newer build's file: the save is skipped, and said once however many rebuilds run.
    await _setConnectionGrantsVersionForTesting(99);
    bindingManager._resetForTesting?.();
    vi.mocked(appLog).mockClear();
    await rebuildPersistedBindings();
    await rebuildPersistedBindings();
    expect(toolsOf('h', 'a')).toEqual(CLEAR_COMPACT);
    expect(localConnectionWakeOn('h', 'a')).toBe(true);
    expect(getConnectionDirection(H, A)).toBeUndefined();
    expect(vi.mocked(appLog).mock.calls.filter(([, level, message]) => level === 'warn' && String(message).includes('newer Clubhouse'))).toHaveLength(1);
    await _setConnectionGrantsVersionForTesting(1);
    canvas = [wire('h', 'a'), wire('a', 'h')];
    await rebuildPersistedBindings();
    await vi.waitFor(() => expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: CLEAR_COMPACT, enabledTools: ['wake_agent'] }));
    expect(getConnectionDirection(A, H)).toMatchObject({ disabledTools: CLEAR_COMPACT, enabledTools: ['wake_agent'] });
  });

  it('waits while the file is a newer build\'s, saying so once, and runs once it isn\'t', async () => {
    await _setConnectionGrantsVersionForTesting(99);
    try {
      vi.mocked(appLog).mockClear();
      await rebuildPersistedBindings();
      expect(await migrate()).toBe('deferred');
      expect(await migrate()).toBe('deferred');
      expect(connectionMigrationDone(AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION)).toBe(false);
      expect(vi.mocked(appLog).mock.calls.filter(([, level, message]) => level === 'warn' && String(message).includes('newer Clubhouse'))).toHaveLength(1);
    } finally {
      await _setConnectionGrantsVersionForTesting(1);
    }
    expect(await migrate()).toBe('done');
    expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: CLEAR_COMPACT, enabledTools: ['wake_agent'] });
  });

  it('drawing a canvas wire over a helper or Dispatcher link keeps the choices saved for it', async () => {
    await rebuildPersistedBindings();
    await migrate();
    await applyConnectionTools('h', 'a', ['send_file']); // the user's choice on the card
    // The canvas wire comes back with a list of its own: the saved one stands.
    await applyConnectionTools('h', 'a', CLEAR_COMPACT, { restore: true });
    expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: ['send_file'], enabledTools: ['wake_agent'] });
    expect(toolsOf('h', 'a')).toEqual(['send_file']);
    // And a wire drawn over the pair binds nothing new: the rebuild keeps the saved list too.
    canvas = [wire('h', 'a'), wire('a', 'h')];
    await rebuildPersistedBindings();
    expect(toolsOf('h', 'a')).toEqual(['send_file']);
    expect(getConnectionDirection(A, H)).toMatchObject({ disabledTools: CLEAR_COMPACT, enabledTools: ['wake_agent'] });
  });

  it('waits while a source can\'t be read, since it might list the pair, and runs once it can', async () => {
    let broken = true;
    unregister.push(registerPersistedBindingSource({ id: 'unreadable', collect: async () => { if (broken) throw new Error('EACCES'); return []; } }));
    canvas = [wire('a', 'b')];
    await rebuildPersistedBindings();
    expect(await migrate()).toBe('deferred');
    expect(getConnectionDirection(H, A)).toBeUndefined();
    expect(getConnectionDirection(A, B)).toBeUndefined();
    expect(connectionMigrationDone(AUTOMATIC_CONNECTION_DEFAULTS_MIGRATION)).toBe(false);
    // Still live meanwhile.
    expect(toolsOf('h', 'a')).toEqual(CLEAR_COMPACT);
    expect(localConnectionWakeOn('h', 'a')).toBe(true);
    broken = false;
    await rebuildPersistedBindings();
    expect(await migrate()).toBe('done');
    expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: CLEAR_COMPACT, enabledTools: ['wake_agent'] });
    expect(getConnectionDirection(A, B)).toMatchObject({ disabledTools: CLEAR_COMPACT, enabledTools: ['wake_agent'] });
  });

  it('a canvas wire drawn over a Dispatcher link before the pass keeps the lists the link showed, across a restart', async () => {
    let broken = true;
    unregister.push(registerPersistedBindingSource({ id: 'unreadable', collect: async () => { if (broken) throw new Error('EACCES'); return []; } }));
    await rebuildPersistedBindings();
    expect(await migrate()).toBe('deferred');
    // Drawn over a bound pair, the wire carries no list of its own (newWireDisabledTools).
    canvas = [wire('a', 'disp')];
    broken = false;
    await rebuildPersistedBindings();
    expect(await migrate()).toBe('done');
    expect(getConnectionDirection(A, DISP)).toMatchObject({ disabledTools: CLEAR_COMPACT, enabledTools: ['wake_agent'] });
    // Restart: the canvas binds the pair first, and the saved lists apply.
    bindingManager._resetForTesting?.();
    await rebuildPersistedBindings();
    expect(toolsOf('a', 'disp')).toEqual(CLEAR_COMPACT);
    expect(localConnectionWakeOn('a', 'disp')).toBe(true);
  });

  it('runs once: a later pass changes nothing, even where a direction lost its entry', async () => {
    await rebuildPersistedBindings();
    expect(await migrate()).toBe('done');
    await setConnectionTools(A, DISP, []);
    expect(await migrate()).toBe('already');
    expect(getConnectionDirection(A, DISP)).toMatchObject({ disabledTools: [] });
  });

  it('once the pass has run, a new helper or Dispatcher link keeps its starting lists, and never over a saved one', async () => {
    await rebuildPersistedBindings();
    await migrate();
    await removeConnectionDirections('h');
    await setConnectionTools(A, DISP, [], []); // the user's: every tool but wake
    bindingManager._resetForTesting?.();
    await rebuildPersistedBindings();
    await vi.waitFor(() => expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: CLEAR_COMPACT, enabledTools: ['wake_agent'] }));
    await vi.waitFor(() => expect(getConnectionDirection(A, H)).toMatchObject({ disabledTools: CLEAR_COMPACT, enabledTools: ['wake_agent'] }));
    expect(getConnectionDirection(A, DISP)).toMatchObject({ disabledTools: [] });
    expect(getConnectionDirection(A, DISP)?.enabledTools).toBeUndefined();
    expect(toolsOf('a', 'disp')).toBeUndefined();
    expect(localConnectionWakeOn('a', 'disp')).toBe(false);
  });

  it('a first change on the card to a direction with nothing saved keeps the wake its source started it with', async () => {
    await rebuildPersistedBindings();
    await applyConnectionTools('h', 'a', ['clear_agent']);
    expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: ['clear_agent'], enabledTools: ['wake_agent'] });
    await applyConnectionTools('a', 'h', ['send_file']);
    expect(getConnectionDirection(A, H)).toMatchObject({ disabledTools: ['send_file'], enabledTools: ['wake_agent'] });
  });

  it('Wake it off on a direction with nothing saved turns the start\'s wake off and keeps its tools', async () => {
    await rebuildPersistedBindings();
    await setLocalWake('h', 'a', false);
    expect(getConnectionDirection(H, A)).toMatchObject({ disabledTools: CLEAR_COMPACT });
    expect(getConnectionDirection(H, A)?.enabledTools).toBeUndefined();
    expect(localConnectionWakeOn('h', 'a')).toBe(false);
    expect(readLocalDirectionTools('h', 'a').disabled).toEqual([...CLEAR_COMPACT, 'wake_agent']);
  });
});

describe('a wire the user draws (2026-11-09 defaults)', () => {
  it('starts with clear and compact off and wake on, and a later edit keeps wake', async () => {
    bindingManager.bind('a', { targetId: 'b', targetKind: 'agent', label: 'beta' });
    await applyConnectionTools('a', 'b', [...NEW_AGENT_WIRE_DISABLED_TOOLS], { start: true });
    expect(getConnectionDirection(A, B)).toMatchObject({ disabledTools: ['clear_agent', 'compact_agent'], enabledTools: ['wake_agent'] });
    expect(localConnectionWakeOn('a', 'b')).toBe(true);
    await applyConnectionTools('a', 'b', ['send_file']);
    expect(getConnectionDirection(A, B)).toMatchObject({ disabledTools: ['send_file'], enabledTools: ['wake_agent'] });
  });

  it('a canvas wire bound again with its own list, saved before wake existed, doesn\'t turn wake on', async () => {
    bindingManager.bind('a', { targetId: 'b', targetKind: 'agent', label: 'beta' });
    await applyConnectionTools('a', 'b', [...NEW_AGENT_WIRE_DISABLED_TOOLS], { restore: true });
    await vi.waitFor(() => expect(getConnectionDirection(A, B)).toMatchObject({ disabledTools: ['clear_agent', 'compact_agent'] }));
    expect(getConnectionDirection(A, B)?.enabledTools).toBeUndefined();
    expect(localConnectionWakeOn('a', 'b')).toBe(false);
  });
});
