import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ global: vi.fn(() => { throw new Error('global display source not requested'); }), primary: vi.fn(() => { throw new Error('project display source not requested'); }) }));
vi.mock('./orchestration-settings', () => ({ readAutoHelpersForDisplay: m.global, readGlobalHelperCapForDisplay: m.global }));
vi.mock('./settings-store', () => ({ peekMetadataFileForDisplaySync: m.primary }));
import { projectOrchestrationAgentFieldsForDisplay } from './orchestration-display';
beforeEach(() => { m.global.mockClear(); m.primary.mockClear(); });
it.each([
  [{}, false, 'default'],
  [{ orchestration: { orchestrate: true } }, true, 'default'],
  [{ orchestration: { orchestrate: true, connectToDispatcher: false } }, false, 'agent'],
  [{ orchestration: { orchestrate: false, connectToDispatcher: true } }, true, 'agent'],
  [{ parentAgentId: 'parent', orchestration: { orchestrate: true, connectToDispatcher: true } }, false, 'default'],
] as const)('projects the same saved connect policy without global/project/provider lookups: %j', (agent, expected, source) => {
  const result = projectOrchestrationAgentFieldsForDisplay(agent);
  expect.soft(result.fields.connectToDispatcher).toMatchObject({ state: 'ok', value: expected }); expect.soft(result.sources.connectToDispatcher).toBe(source);
  expect.soft(m.global).not.toHaveBeenCalled(); expect.soft(m.primary).not.toHaveBeenCalled(); expect.soft(result).not.toHaveProperty('policy');
});
it.each([
  { orchestration: [] }, { orchestration: 'PRIVATE_INVALID_ROOT' },
  { orchestration: { connectToDispatcher: 'PRIVATE_NOT_BOOLEAN' } },
  { orchestration: { orchestrate: 'PRIVATE_NOT_BOOLEAN' } },
  { parentAgentId: 42, orchestration: { connectToDispatcher: true } },
])('keeps malformed connect evidence unknown rather than exposing fallback flags: %j', (agent) => {
  const result = projectOrchestrationAgentFieldsForDisplay(agent);
  expect.soft(result.fields.connectToDispatcher.state).toBe('unavailable'); expect.soft(result.sources).not.toHaveProperty('connectToDispatcher'); expect.soft(result).not.toHaveProperty('policy');
  expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_'); expect.soft(m.global).not.toHaveBeenCalled(); expect.soft(m.primary).not.toHaveBeenCalled();
});
it('keeps an explicit known connect field when unrelated saved policy fields are malformed', () => {
  const result = projectOrchestrationAgentFieldsForDisplay({ orchestration: { connectToDispatcher: true, maxHelpers: 'PRIVATE_BAD_LIMIT' } });
  expect.soft(result.fields.connectToDispatcher).toMatchObject({ state: 'ok', value: true }); expect.soft(result.fields.maxHelpers.state).toBe('unavailable'); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_');
});
it('keeps the helper prohibition known even when its saved orchestration block is unavailable', () => {
  const result = projectOrchestrationAgentFieldsForDisplay({ parentAgentId: 'parent', orchestration: 'PRIVATE_BAD_POLICY' });
  expect.soft(result.fields.connectToDispatcher).toMatchObject({ state: 'ok', value: false }); expect.soft(m.global).not.toHaveBeenCalled(); expect.soft(m.primary).not.toHaveBeenCalled();
});
