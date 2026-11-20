import { expect, it, vi } from 'vitest';
// A leaf field model must not even load these service modules to project data.
vi.mock('./settings-store', () => { throw new Error('Field model imported a store.'); });
vi.mock('./display-settings', () => { throw new Error('Field model imported a settings reader.'); });
vi.mock('./orchestration-display', () => { throw new Error('Field model imported an I/O container.'); });
vi.mock('./orchestration-settings', () => { throw new Error('Field model imported global settings.'); });
vi.mock('./agent-config', () => { throw new Error('Field model imported a mutable owner.'); });
import { projectConnectionEndpointFieldsForDisplay, projectLoadedConnectionEndpointFieldsForDisplay } from './connection-endpoint-fields-display';
import { projectOrchestrationAgentFieldsForDisplay } from './orchestration-agent-fields';
it('projects the same bounded fields with cache-observation provenance without importing services or raw private definitions', () => {
  vi.spyOn(Date, 'now').mockReturnValue(42);
  const raw = { id: 'target', name: '  Custom name  ', parentAgentId: '', disposedAt: '', orchestration: { connectToDispatcher: false }, instructions: 'PRIVATE_TEXT', env: { token: 'PRIVATE_KEY' } };
  const saved = projectConnectionEndpointFieldsForDisplay('target', raw), loaded = projectLoadedConnectionEndpointFieldsForDisplay('target', raw);
  const values = (value: unknown) => JSON.stringify(value, (key, field) => key === 'inputs' ? undefined : field);
  expect.soft(values(loaded)).toBe(values(saved)); expect.soft(loaded).toMatchObject({ state: 'ok', inputs: [{ field: 'Related agent host-session fields', source: 'host-cache', observedAt: 42 }], value: { name: { value: '  Custom name  ', inputs: [{ source: 'host-cache', observedAt: 42 }] }, helper: { value: false }, disposed: { value: false }, connectToDispatcher: { value: false, inputs: [{ source: 'host-cache', observedAt: 42 }] } } });
  expect.soft(JSON.stringify(loaded)).not.toMatch(/PRIVATE_|runtime|permission|projectPath/);
});
it('retains unknown malformed fields while using the shared local policy model', () => {
  const policy = projectOrchestrationAgentFieldsForDisplay({ orchestration: { orchestrate: true, connectToDispatcher: false } });
  expect.soft(policy.fields.connectToDispatcher).toMatchObject({ state: 'ok', value: false });
  const result = projectLoadedConnectionEndpointFieldsForDisplay('target', { id: 'target', name: 'Known', parentAgentId: 7, disposedAt: 7, orchestration: { connectToDispatcher: 'PRIVATE_BAD' } });
  expect(result).toMatchObject({ state: 'ok', value: { name: { value: 'Known' }, helper: { state: 'unavailable' }, disposed: { state: 'unavailable' }, connectToDispatcher: { state: 'unavailable' } } }); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_');
});
it('reports an explicit display limit for oversized names while retaining independent known flags', () => {
  const raw = { id: 'target', name: 'x'.repeat(1025), orchestration: { connectToDispatcher: false } };
  for (const result of [projectConnectionEndpointFieldsForDisplay('target', raw), projectLoadedConnectionEndpointFieldsForDisplay('target', raw)]) {
    expect(result).toMatchObject({ state: 'ok', value: { name: { state: 'unavailable', reason: 'limit' }, helper: { value: false }, connectToDispatcher: { value: false } } });
    expect(JSON.stringify(result)).not.toContain(raw.name);
  }
});
