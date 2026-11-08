import { describe, expect, it } from 'vitest';
import { managedSettingsSummary } from './managed-settings-summary';

const value = (rows: ReturnType<typeof managedSettingsSummary>, key: string) => rows.find((r) => r.key === key)?.value;

describe('managedSettingsSummary', () => {
  it('says what the CLI decides when nothing is set, and leaves helpers out while it works alone', () => {
    const rows = managedSettingsSummary({});
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['CLI', 'The project\'s CLI'],
      ['Model', 'CLI default'],
      ['Effort', 'CLI default'],
      ['Access', 'Ask first'],
      ['Orchestration', 'Off'],
      ['Dispatcher', 'Not connected'],
    ]);
  });

  it('describes helpers: the limit, how they are picked, approvals and the template', () => {
    const rows = managedSettingsSummary({
      cliName: 'Codex', model: 'gpt-5', effort: 'xhigh', access: 'auto',
      orchestration: { orchestrate: true, maxHelpers: 2, autoHelpers: false, control: 'ask-before-start', connectToDispatcher: false },
      helperTemplateName: 'Quality Assurance',
    });
    expect(value(rows, 'access')).toBe('Auto');
    expect(value(rows, 'helpers')).toBe('Up to 2 at once, fixed selection, asks before starting');
    expect(value(rows, 'helperTemplate')).toBe('Quality Assurance');
    expect(value(rows, 'dispatcher')).toBe('Not connected');
    expect(managedSettingsSummary({ orchestration: { orchestrate: true } }).find((r) => r.key === 'helpers')!.value)
      .toBe('Up to 5 at once, selection from the app setting, no approvals');
  });

  it('leaves the Dispatcher out for a helper, which talks only to its orchestrator', () => {
    const rows = managedSettingsSummary({ orchestration: { connectToDispatcher: true }, helper: true });
    expect(value(rows, 'dispatcher')).toBeUndefined();
  });
});
