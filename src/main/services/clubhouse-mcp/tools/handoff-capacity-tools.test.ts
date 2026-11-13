import { beforeEach, expect, it, vi } from 'vitest';
import type { McpToolHandler } from '../types';
const state = vi.hoisted(() => ({ probe: vi.fn(), handler: undefined as McpToolHandler | undefined, grant: undefined as unknown }));
vi.mock('../../handoff-capacity-host', () => ({ handoffCapacityService: () => ({ probe: state.probe }) }));
vi.mock('../tool-registry', () => ({ registerGlobalTool: (_name: string, _definition: unknown, handler: McpToolHandler, options: { grant: unknown }) => { state.handler = handler; state.grant = options.grant; } }));
import { registerHandoffCapacityTools } from './handoff-capacity-tools';
beforeEach(() => { registerHandoffCapacityTools(); state.probe.mockResolvedValue([]); });
it('uses device.read and forwards only a normalized optional machine', async () => {
  expect(state.grant).toEqual({ actions: ['device.read'], target: 'app' });
  await state.handler!('caller', {});
  expect(state.probe).toHaveBeenLastCalledWith('caller', undefined);
  const machine = Array(32).fill('AB').join(':');
  await state.handler!('caller', { machine });
  expect(state.probe).toHaveBeenLastCalledWith('caller', machine.toLowerCase());
});
it.each([{ machine: 123 }, { machine: 'hostname' }, { path: 'private' }])('refuses malformed input %j before probing', async (args) => {
  expect((await state.handler!('caller', args)).isError).toBe(true);
  expect(state.probe).not.toHaveBeenCalled();
});
it('never reflects transport errors or OS paths', async () => {
  state.probe.mockRejectedValue(new Error('private-host/private-path'));
  const result = await state.handler!('caller', {});
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private-');
});
