import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindingManager } from './binding-manager';
import { isDispatcherAgent, setDispatcherAgent, setDispatcherIdLookup, _resetDispatcherGateForTesting } from './dispatcher-gate';
import { callerConnectedToLocalDispatcher } from './local-dispatcher-connections';
import type { BindingTargetKind } from './types';

vi.mock('../dispatcher/dispatcher-settings', () => ({ isDispatcherEnabled: () => false }));

beforeEach(() => {
  bindingManager._resetForTesting();
  _resetDispatcherGateForTesting();
  setDispatcherIdLookup((id) => id === 'controller');
});
afterEach(() => {
  bindingManager._resetForTesting();
  _resetDispatcherGateForTesting();
  setDispatcherIdLookup(null);
});

describe('trusted local Dispatcher connection fact', () => {
  it('requires an outgoing agent binding, never inferring the reverse direction', () => {
    bindingManager.bind('controller', { targetId: 'sender', targetKind: 'agent', label: 'Sender' });
    expect(callerConnectedToLocalDispatcher('sender')).toBe(false);
    bindingManager.bind('sender', { targetId: 'controller', targetKind: 'agent', label: 'Not a role label' });
    expect(callerConnectedToLocalDispatcher('sender')).toBe(true);
    bindingManager.unbind('sender', 'controller');
    expect(callerConnectedToLocalDispatcher('sender')).toBe(false);
  });

  it.each([
    'browser', 'terminal', 'group-project', 'plugin',
    // The federation-only kind is not part of this standalone base's registry.
    'remote_dispatcher' as BindingTargetKind,
  ] as const)('refuses a %s binding even when its id collides with the coordinator', (targetKind) => {
    bindingManager.bind('sender', { targetId: 'controller', targetKind, label: 'Dispatcher' });
    expect(callerConnectedToLocalDispatcher('sender')).toBe(false);
  });

  it('does not trust role tracking, display names or remote-qualified controller ids', () => {
    setDispatcherAgent('impostor', true);
    for (const targetId of ['impostor', 'controller@other-machine', 'remote||other-machine||controller', 'controller-copy']) {
      bindingManager.bind('sender', { targetId, targetKind: 'agent', label: 'Dispatcher', targetName: 'Dispatcher' });
    }
    expect(callerConnectedToLocalDispatcher('sender')).toBe(false);
  });

  it('keeps an actual local coordinator connection structural while the controller is off or sleeping', () => {
    expect(isDispatcherAgent('controller')).toBe(false);
    bindingManager.bind('sender', { targetId: 'controller', targetKind: 'agent', label: 'Controller' });
    expect(callerConnectedToLocalDispatcher('sender')).toBe(true);
    setDispatcherIdLookup(null);
    expect(callerConnectedToLocalDispatcher('sender')).toBe(false);
  });
});
