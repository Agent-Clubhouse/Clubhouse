import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ base: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({ peekProjects: async () => [{ path: '/p' }] }));
vi.mock('./agent-config', () => ({ peekDurableConfigs: async () => [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }] }));
state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-grants-'));

import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  deniedConnectionTools, getConnectionDirection, listConnectionDirections, removeConnectionDirections, setConnectionTools,
} from './connection-grants-store';
import { applyConnectionTools, makeTwoWay, removeUserLink, startConnectionGrants } from './connection-grants';
import { applyPersistedBinding, rebuildPersistedBindings, _resetPersistedBindingSourcesForTesting } from './persisted-bindings';

const A = { agentId: 'a' };
const B = { agentId: 'b' };
const toolsOf = (agentId: string, targetId: string) => bindingManager.getBindingsForAgent(agentId).find((b) => b.targetId === targetId)?.disabledTools;
let stop: () => void = () => {};

beforeEach(async () => {
  bindingManager._resetForTesting?.();
  _resetPersistedBindingSourcesForTesting();
  await removeConnectionDirections('a');
  await removeConnectionDirections('b');
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
