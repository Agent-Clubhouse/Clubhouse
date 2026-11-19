import { describe, expect, it } from 'vitest';
import { providerStartReceipt } from './provider-start-receipt';

const input = { agentId: 'a', hostEpoch: 'host-epoch', commandId: 'start-once', configured: { provider: 'codex-cli', providerOverride: 'codex-cli', model: { value: 'chosen', source: 'agent' as const }, effort: { value: 'high', source: 'agent' as const } }, completed: true, created: true, selectedProvider: 'codex-cli', running: true, sameCreatedRuntime: true };
describe('specific start evidence', () => {
  it('does not turn configured model/effort or PTY creation into provider execution metadata', () => {
    expect(providerStartReceipt(input)).toMatchObject({ result: { configPersistedByStart: false }, start: { creation: 'observed', evidence: 'pty_created' }, running: { model: null, effort: null, appSessionId: null, nativeProviderSessionId: null } });
    expect(providerStartReceipt({ ...input, appSessionId: 'app-session', nativeProviderSessionId: 'native-session' }).running).toMatchObject({ appSessionId: 'app-session', nativeProviderSessionId: 'native-session' });
  });
  it('retains immutable creation when an immediate exit or later failure changes running state', () => {
    const exit = providerStartReceipt({ ...input, running: false, sameCreatedRuntime: false });
    expect(exit).toMatchObject({ start: { creation: 'observed', providerSelection: 'codex-cli' }, running: { state: 'not_running', providerSelection: null } });
    expect(providerStartReceipt({ ...input, completed: false }).result.status).toBe('failed_after_creation');
  });
  it('keeps unknown distinct from not-running and does not associate another existing runtime', () => {
    expect(providerStartReceipt({ ...input, running: null }).running.state).toBe('unknown');
    expect(providerStartReceipt({ ...input, sameCreatedRuntime: false }).running).toMatchObject({ state: 'unknown', providerSelection: null });
    expect(providerStartReceipt({ ...input, created: false, completed: false, running: false }).result.status).toBe('refused_before_creation');
  });
});
