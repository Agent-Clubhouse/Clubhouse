import { expect, it } from 'vitest';
import { configuredConnectionEndpointEligibility, projectConnectionEndpointFieldsForDisplay } from './connection-endpoint-fields-display';
const row = (extra: Record<string, unknown> = {}) => ({ id: 'target', name: '  Custom name  ', orchestration: { connectToDispatcher: true }, provider: 'PRIVATE_PROVIDER', instructions: 'PRIVATE_PROMPT', env: { key: 'PRIVATE_CREDENTIAL' }, ...extra });
it('returns only the exact selected related saved fields, preserving custom text and explicit policy source', () => {
  const result = projectConnectionEndpointFieldsForDisplay('target', row());
  expect.soft(result).toMatchObject({ state: 'ok', value: { id: 'target', name: { value: '  Custom name  ' }, helper: { value: false }, disposed: { value: false }, connectToDispatcher: { value: true }, connectSource: 'agent' } });
  expect.soft(JSON.stringify(result)).not.toMatch(/PRIVATE_|provider|instructions|env|projectPath|runtime|permission/);
  if (result.state === 'ok') expect(configuredConnectionEndpointEligibility(result.value)).toMatchObject({ state: 'ok', value: 'eligible' });
});
it.each([null, [], 'PRIVATE_RAW_TEXT', { id: 'PRIVATE_OTHER', name: 'PRIVATE_OTHER_NAME' }])('refuses missing/mismatched related identity before projecting fields: %j', (raw) => {
  const result = projectConnectionEndpointFieldsForDisplay('target', raw); expect.soft(result.state).toBe('unavailable'); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_');
});
it.each([
  [{ parentAgentId: 'parent' }, 'gone'],
  [{ disposedAt: '2026-11-19T00:00:00Z' }, 'gone'],
  [{ disposedAt: 'nonempty-local-flag' }, 'gone'],
  [{ orchestration: { connectToDispatcher: false } }, 'connect-off'],
  [{ orchestration: undefined }, 'connect-off'],
  [{ orchestration: { orchestrate: true } }, 'eligible'],
] as const)('uses the local saved role/disposed/policy rules without claiming a live connection: %j', (extra, expected) => {
  const result = projectConnectionEndpointFieldsForDisplay('target', row(extra)); expect(result.state).toBe('ok');
  if (result.state === 'ok') expect(configuredConnectionEndpointEligibility(result.value)).toMatchObject({ state: 'ok', value: expected });
});
it.each([
  { parentAgentId: 42 }, { parentAgentId: ' ' }, { disposedAt: 42 },
  { orchestration: [] }, { orchestration: { connectToDispatcher: 'PRIVATE_NOT_BOOLEAN' } },
])('keeps malformed eligibility evidence unknown while retaining independent names: %j', (extra) => {
  const result = projectConnectionEndpointFieldsForDisplay('target', row(extra)); expect(result.state).toBe('ok');
  if (result.state !== 'ok') return;
  expect.soft(result.value.name).toMatchObject({ state: 'ok', value: '  Custom name  ' }); expect.soft(configuredConnectionEndpointEligibility(result.value).state).toBe('unavailable'); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_');
});
it('keeps verified blank name/disposed flag distinct from unknown values', () => {
  const result = projectConnectionEndpointFieldsForDisplay('target', row({ name: '', disposedAt: '' })); expect(result.state).toBe('ok');
  if (result.state === 'ok') { expect(result.value.name).toMatchObject({ state: 'ok', value: '' }); expect(result.value.disposed).toMatchObject({ state: 'ok', value: false }); }
});
