import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ base: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({ peekProjects: async () => [{ path: '/p' }], onProjectsChanged: () => () => {} }));
vi.mock('./annex-identity', () => ({ getIdentity: () => ({ fingerprint: Array(16).fill('aa').join(':') }) }));
vi.mock('./agent-config', () => ({ peekDurableConfigs: async () => [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }], onAgentConfigChanged: () => () => {} }));
state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-grants-'));

import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  deniedConnectionTools, getConnectionDirection, listConnectionDirections, removeConnectionDirections, setConnectionTools,
} from './connection-grants-store';
import { applyConnectionTools, connectAcrossMachines, disconnectAcrossMachines, forgetConnectionAgent, makeTwoWay, removeUserLink, startConnectionGrants } from './connection-grants';
import { applyPersistedBinding, markBindingRemovedByUser, rebuildPersistedBindings, _resetPersistedBindingSourcesForTesting } from './persisted-bindings';

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

  it('refuses an address on this machine', async () => {
    await expect(connectAcrossMachines('a', `b@${Array(16).fill('aa').join(':')}`)).rejects.toThrow('this computer');
    await expect(connectAcrossMachines('a', 'b')).rejects.toThrow('this computer');
  });
});
