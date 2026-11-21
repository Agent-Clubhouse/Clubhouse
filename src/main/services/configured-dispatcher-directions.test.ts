import { expect, it, vi } from 'vitest';
vi.mock('./agent-config', () => { throw new Error('source projection imported an owner'); });
vi.mock('./dispatcher/dispatcher-service', () => { throw new Error('source projection imported lifecycle'); });
vi.mock('./dispatcher-wire-source', () => { throw new Error('source projection imported collect/inspect'); });
import { configuredDispatcherDirections } from './configured-dispatcher-directions';
import { NEW_CONNECTION_DISABLED_TOOLS, NEW_CONNECTION_ENABLED_TOOLS } from '../../shared/connection-grants';
const on = { state: 'ok' as const, value: true, inputs: [{ field: 'Selected saved policy', source: 'agent' as const, observedAt: 42 }] };
it('projects only the two admitted selected/controller directions with independent copied source defaults', () => {
  const result = configuredDispatcherDirections({ id: 'selected', name: 'Selected custom name', env: 'PRIVATE_ENV' } as never, on, { id: 'controller', name: 'Controller custom name', instructions: 'PRIVATE_TEXT' } as never);
  expect(result).toMatchObject({ state: 'ok', value: [{ agentId: 'selected', targetId: 'controller', targetName: 'Controller custom name' }, { agentId: 'controller', targetId: 'selected', agentName: 'Controller custom name' }] });
  if (result.state !== 'ok') throw new Error('fixture');
  expect.soft(result.value).toHaveLength(2); expect.soft(result.value[0].disabledTools).toEqual(NEW_CONNECTION_DISABLED_TOOLS); expect.soft(result.value[0].enabledTools).toEqual(NEW_CONNECTION_ENABLED_TOOLS); expect.soft(JSON.stringify(result)).not.toMatch(/PRIVATE_|env|instructions|Connected|effective|projectPath/);
  result.value[0].disabledTools.push('not-shared'); result.inputs[0].field = 'not-shared'; expect.soft(NEW_CONNECTION_DISABLED_TOOLS).not.toContain('not-shared'); expect.soft(on.inputs[0].field).toBe('Selected saved policy'); expect.soft(result.value[1].disabledTools).not.toContain('not-shared');
});
it('keeps known saved off independent of an unavailable controller while unknown policy is not empty', () => {
  expect(configuredDispatcherDirections({ id: 'selected' }, { ...on, value: false })).toMatchObject({ state: 'ok', value: [] });
  expect(configuredDispatcherDirections({ id: 'selected' }, { state: 'unavailable', inputs: [] }, { id: 'controller' })).toMatchObject({ state: 'unavailable' });
});
it.each([undefined, { id: '' }, { id: 'selected' }, { id: 'x'.repeat(201) }, { id: 'remote@machine' }])('cannot infer automatic directions from missing/invalid/unrelated controller identity: %j', (controller) => {
  const result = configuredDispatcherDirections({ id: 'selected' }, on, controller); expect.soft(result.state).toBe('unavailable'); expect.soft(result).not.toHaveProperty('value');
});
it('bounds and redacts display names without borrowing defaults for missing names', () => {
  const result = configuredDispatcherDirections({ id: 'selected', name: 'x'.repeat(1025) }, on, { id: 'controller', name: 'apiKey=PRIVATE_KEY' }); expect(result.state).toBe('ok');
  if (result.state !== 'ok') throw new Error('fixture'); expect.soft(result.value[0].agentName).toBeUndefined(); expect.soft(result.value[1].targetName).toBeUndefined(); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_KEY');
});
