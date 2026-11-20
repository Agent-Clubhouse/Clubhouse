import { expect, it, vi } from 'vitest';
// All runtime inputs are already safe models; presentation cannot import owners/readers.
vi.mock('./agent-config', () => { throw new Error('presentation imported a cache owner'); });
vi.mock('./dispatcher-endpoint-associations-display', () => { throw new Error('presentation imported a source reader'); });
vi.mock('./display-settings', () => { throw new Error('presentation imported a settings service'); });
vi.mock('./settings-store', () => { throw new Error('presentation imported a store'); });
import { endpointCardFields } from './connection-endpoint-card-fields';
import { projectConnectionEndpointFieldsForDisplay, projectLoadedConnectionEndpointFieldsForDisplay } from './connection-endpoint-fields-display';
import type { SavedDispatcherEndpointMetadataRow } from './dispatcher-endpoint-associations-display';
const row = (raw = {}, cacheRaw = {}): SavedDispatcherEndpointMetadataRow => {
  const saved = projectConnectionEndpointFieldsForDisplay('target', { id: 'target', name: '  Saved custom name  ', orchestration: { connectToDispatcher: false }, ...raw });
  if (saved.state !== 'ok') throw new Error('fixture saved fields invalid');
  return { agentId: 'selected', targetId: 'target', relationship: 'recorded', endpoint: { state: 'ok', value: { record: 'registered-primary', fields: saved.value }, inputs: [] }, hostCache: { state: 'ok', value: { scope: 'host-session-cache', availability: 'loaded', observedAt: 42, fields: projectLoadedConnectionEndpointFieldsForDisplay('target', { id: 'target', name: 'Host memory custom name', orchestration: { orchestrate: true }, ...cacheRaw }) }, inputs: [] } };
};
it('keeps custom saved and memory names/settings distinct without promoting them to runtime or eligibility', () => {
  const result = endpointCardFields(row());
  expect(result.savedName).toBe('  Saved custom name  '); expect.soft(result.displayName).toBe('Host memory custom name'); expect.soft(result.nameOrigin).toBe('host-memory'); expect.soft(result.saved).toContain('Connect to Dispatcher Off · explicit setting'); expect.soft(result.memory).toContain('Host memory custom name'); expect.soft(result.memory).toContain('Connect to Dispatcher On · follows Orchestrate');
  expect.soft(JSON.stringify(result)).not.toMatch(/connected now|eligible|runtime|projectPath|namespace|current/);
});
it.each(['different-selected-project', 'not-recorded'] as const)('withholds even retained known fields for %s association', (relationship) => {
  const value = row({ name: 'PRIVATE_OTHER_SAVED' }, { name: 'PRIVATE_OTHER_MEMORY' }); value.relationship = relationship;
  expect(JSON.stringify(endpointCardFields(value))).not.toMatch(/PRIVATE_|Connect to Dispatcher/);
});
it.each(['absent-from-primary', 'project-not-registered'] as const)('does not borrow memory fields after %s primary admission', (record) => {
  const value = row({}, { name: 'PRIVATE_MEMORY' }); value.endpoint = { state: 'ok', value: { record }, inputs: [] };
  const result = endpointCardFields(value); expect.soft(result.savedName).toBeUndefined(); expect.soft(result.memory).toBeUndefined(); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_');
});
it.each(['not-loaded', 'not-in-loaded-index', 'namespace-unconfirmed', 'invalid', 'changed'] as const)('withholds retained memory fields in %s state while preserving useful primary data', (availability) => {
  const value = row({}, { name: 'PRIVATE_RETAINED_MEMORY' }); if (value.hostCache?.state !== 'ok') throw new Error('fixture'); value.hostCache.value.availability = availability;
  const result = endpointCardFields(value); expect(result.savedName).toBe('  Saved custom name  '); expect.soft(result.displayName).toBe('  Saved custom name  '); expect.soft(result.nameOrigin).toBe('saved'); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_'); expect.soft(result.memory).toBeTruthy();
});
it('keeps malformed independent fields unknown and known explicit false visible', () => {
  const result = endpointCardFields(row({ parentAgentId: 7, disposedAt: 7 }, { orchestration: { connectToDispatcher: false } }));
  expect.soft(result.saved).toContain('helper role unavailable'); expect.soft(result.saved).toContain('disposal status unavailable'); expect.soft(result.saved).toContain('Connect to Dispatcher unavailable'); expect.soft(result.memory).toContain('Connect to Dispatcher Off');
});
it('uses shared helper-policy semantics rather than inferring tool or connection authority', () => {
  const result = endpointCardFields(row({ parentAgentId: 'parent', orchestration: { connectToDispatcher: true } }));
  expect.soft(result.saved).toContain('configured helper'); expect.soft(result.saved).toContain('Connect to Dispatcher Off · helper policy');
});
it('keeps verified blank name distinct from unavailable and uses existing display redaction/truncation', () => {
  expect(endpointCardFields(row({ name: '' })).saved).toContain('Blank name'); expect(endpointCardFields(row({ name: '' })).savedName).toBeUndefined();
  expect(endpointCardFields(row({ name: 'x'.repeat(1025) })).saved).toContain('Name unavailable');
  const result = endpointCardFields(row({ name: 'apiKey=PRIVATE_CREDENTIAL' }, { name: 'x'.repeat(300) })); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_CREDENTIAL'); expect.soft(result.memory).toContain('[text truncated]');
});
