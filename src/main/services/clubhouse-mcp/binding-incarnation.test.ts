import { describe, it, expect, vi, beforeEach } from 'vitest';

const gate = vi.hoisted(() => ({ access: 'open' as 'open' | 'closed' }));
vi.mock('./mcp-call-gate', async (original) => ({ ...await original<typeof import('./mcp-call-gate')>(), mcpCallAccess: () => gate.access }));

// Grants in memory (#3360); a change still tells the tool list to refresh, as the real store does.
const grantFx = vi.hoisted(() => ({ changes: new Map<string, unknown>() }));
vi.mock('../agent-grants-store', async () => {
  const { notifyToolGateChange } = await import('./orchestration-gate');
  return {
    getAgentGrantChanges: (id: string) => grantFx.changes.get(id),
    listAgentsWithGrantChanges: () => [...grantFx.changes.keys()],
    updateAgentGrantChanges: async (id: string, fn: (c: unknown) => unknown) => {
      const next = fn(grantFx.changes.get(id));
      if (next) grantFx.changes.set(id, next); else grantFx.changes.delete(id);
      notifyToolGateChange(id);
      return next;
    },
  };
});
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/test-clubhouse' },
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const remoteController = vi.hoisted(() => ({ id: '' }));
vi.mock('../dispatcher-federation', () => ({ remoteFederationController: () => remoteController.id ? { agentId: remoteController.id } : undefined }));
const presence = vi.hoisted(() => ({ remotes: [] as Array<Record<string, unknown>> }));
vi.mock('../dispatcher-presence', () => ({ getDispatcherPresence: () => ({ remotes: presence.remotes }) }));
const forwarded = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../annex-agent-calls', () => ({
  remoteMachineOf: (id: string) => (id.includes('@') ? id.slice(id.indexOf('@') + 1) : null),
  forwardAgentCall: async (...args: unknown[]) => { forwarded.calls.push(args); return { content: [{ type: 'text', text: 'sent there' }] }; },
}));

const processFx = vi.hoisted(() => ({ incarnation: 1, failEntropy: false }));
vi.mock('crypto', async (original) => ({
  ...await original<typeof import('crypto')>(),
  randomBytes: (size: number) => {
    if (processFx.failEntropy) throw new Error('simulated entropy failure');
    return Buffer.alloc(size, processFx.incarnation);
  },
}));

const dispatcherState = vi.hoisted(() => ({ enabled: true }));
vi.mock('../dispatcher/dispatcher-settings', () => ({
  isDispatcherEnabled: () => dispatcherState.enabled,
}));

// A fresh module graph models a fresh main process, with deterministic crypto
// namespaces so neither branch order nor random chance decides this control.
async function processRegistry(incarnation: number, targets: string[]) {
  processFx.incarnation = incarnation;
  vi.resetModules();
  const { bindingManager } = await import('./binding-manager');
  const registry = await import('./tool-registry');
  registry.registerToolTemplate('agent', 'send_message', { description: 'Send', inputSchema: { type: 'object' } }, vi.fn());
  for (const targetId of targets) bindingManager.bind('caller', {
    targetId, targetKind: 'agent', label: 'robin', targetName: 'robin', projectName: 'app',
  });
  return { ...registry, bindingManager };
}

describe('binding callable process incarnation (#3738)', () => {
  beforeEach(() => { forwarded.calls.length = 0; grantFx.changes.clear(); gate.access = 'open'; processFx.failEntropy = false; });

  it.each(['same', 'reversed'])('refuses old names after a %s-order process rebuild without forwarding', async (order) => {
    const targets = [
      `first@${Array(16).fill('bb').join(':')}`,
      `second@${Array(16).fill('cc').join(':')}`,
    ];
    const args = { message: 'same delivery', task_id: 'stable-task' };
    const first = await processRegistry(1, targets);
    const oldNames = first.getScopedToolList('caller').map(t => t.name);
    expect(oldNames).toHaveLength(2);
    for (const name of oldNames) expect((await first.callTool('caller', name, args)).isError).toBeFalsy();
    expect(forwarded.calls.map(call => call[1])).toEqual(targets);
    forwarded.calls.length = 0;

    const reordered = order === 'reversed' ? [...targets].reverse() : targets;
    const second = await processRegistry(2, reordered);
    const newNames = second.getScopedToolList('caller').map(t => t.name);
    expect(newNames).toHaveLength(2);
    const refusals = [];
    for (const oldName of oldNames) refusals.push(second.refusalReasonOf(await second.callTool('caller', oldName, args)));
    expect({ refusals, forwarded: forwarded.calls.map(call => call[1]) }).toEqual({
      refusals: ['no_binding', 'no_binding'], forwarded: [],
    });
    for (const oldName of oldNames) expect(newNames).not.toContain(oldName);
    for (const name of newNames) expect((await second.callTool('caller', name, args)).isError).toBeFalsy();
    expect(forwarded.calls.map(call => call[1])).toEqual(reordered);
  });

  it('preserves the full identity at UINT32_MAX and refuses exhaustion before exposing another binding', async () => {
    vi.resetModules();
    const keys = await import('./binding-tool-key');
    const namespace = new keys.BindingToolKeyNamespace(`${'0'.repeat(24)}1`, 0xffff_fffe);
    vi.doMock('./binding-tool-key', () => ({
      ...keys,
      initializeBindingToolKey: namespace.initialize.bind(namespace),
      buildToolKey: (binding: import('./types').McpBinding) => namespace.get(binding) ?? keys.buildToolKey(binding),
    }));
    vi.resetModules();
    try {
      const { bindingManager } = await import('./binding-manager');
      const { buildToolName, buildToolKey, parseToolName } = await import('./tool-registry');
      const changed = vi.fn();
      bindingManager.onChange(changed);
      bindingManager.bind('caller', { targetId: 'last', targetKind: 'agent', label: 'robin'.repeat(1000), projectName: 'application'.repeat(1000) });
      const last = bindingManager.getBindingsForAgent('caller')[0];
      const key = `${'0'.repeat(24)}1_1z141z3`;
      expect(buildToolKey(last)).toBe(key); // No readable prefix remains; identity is intact.
      const name = buildToolName(last, 'check_connectivity');
      expect(name.length).toBe(64);
      expect(parseToolName(name)?.toolKey).toBe(key);
      expect(() => bindingManager.bind('caller', { targetId: 'exhausted', targetKind: 'agent', label: 'robin' })).toThrow('MCP binding tool identity exhausted');
      expect(() => bindingManager.bind('other-caller', { targetId: 'also-exhausted', targetKind: 'group-project', label: 'robin' })).toThrow('MCP binding tool identity exhausted');
      expect(bindingManager.getAllBindings()).toEqual([last]);
      expect(bindingManager.getBindingsForAgent('other-caller')).toEqual([]);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(buildToolKey(last)).toBe(key);
    } finally {
      vi.doUnmock('./binding-tool-key');
      vi.resetModules();
    }
  });

  it('fails closed on cryptographic namespace failure before a binding manager is available', async () => {
    vi.resetModules();
    processFx.failEntropy = true;
    try {
      await expect(import('./binding-manager')).rejects.toThrow('simulated entropy failure');
      expect(forwarded.calls).toHaveLength(0);
    } finally {
      processFx.failEntropy = false;
      vi.resetModules();
    }
  });

});
