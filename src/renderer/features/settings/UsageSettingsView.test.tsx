import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UsageSummary } from '../../../shared/usage-summary';
import { UsageSettingsView } from './UsageSettingsView';

const base: UsageSummary = {
  days: 1, since: '2026-11-24', noLines: false, linesRecorded: true, otherProviders: [],
  providers: [
    { id: 'codex-cli', name: 'Codex', quotaKind: 'reader', quota: { state: 'known', source: 'cli_query', asOf: null, limitingWindow: 'weekly', weekly: { usedPercent: 40, resetsAt: null } },
      usage: { turns: 3, turnsWithoutUsage: 0, turnsWithoutId: 0, uncachedInput: 10, missing: {}, sources: {}, input: 100, cachedInput: 90, cacheWrite: null, output: 5, reasoning: null } },
    { id: 'copilot-cli', name: 'GitHub Copilot', quotaKind: 'unknown' },
  ],
  roles: [{ role: 'helper', turns: 3, turnsWithoutUsage: 0, turnsWithoutId: 0, uncachedInput: 10, missing: {}, sources: {}, input: 100, cachedInput: 90, cacheWrite: null, output: 5, reasoning: null }],
};

function mount(get: (days: number) => Promise<UsageSummary>) {
  (window as unknown as { clubhouse: unknown }).clubhouse = { app: { getUsageSummary: vi.fn(get) } };
  render(<UsageSettingsView />);
  return (window as unknown as { clubhouse: { app: { getUsageSummary: ReturnType<typeof vi.fn> } } }).clubhouse.app.getUsageSummary;
}

afterEach(() => { delete (window as unknown as { clubhouse?: unknown }).clubhouse; });

describe('UsageSettingsView', () => {
  it('lists each provider’s limit and tokens, with unknown shown as unknown', async () => {
    mount(async () => base);
    expect((await screen.findByTestId('usage-quota-codex-cli')).textContent).toContain('40% of the weekly limit used');
    expect(screen.getByTestId('usage-quota-copilot-cli').textContent).toContain('unknown');
    expect(screen.getByTestId('usage-quota-copilot-cli').textContent).not.toMatch(/%/);
    expect(screen.getByTestId('usage-tokens-codex-cli').textContent).toContain('3 turns, 100 input (90 cached), 5 output, unknown reasoning');
    expect(screen.getByTestId('usage-tokens-copilot-cli').textContent).toContain('No usage logged');
    expect(screen.getByTestId('usage-role-helper').textContent).toContain('Helpers');
  });

  it('asks again for the last 7 days', async () => {
    const get = mount(async (days) => ({ ...base, days: days as 1 | 7 }));
    await screen.findByTestId('usage-quota-codex-cli');
    fireEvent.change(screen.getByTestId('usage-period'), { target: { value: '7' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(7));
  });

  it('says no usage was recorded, and why, instead of showing zeros', async () => {
    mount(async () => ({ ...base, noLines: true, linesRecorded: false, roles: [], providers: base.providers.map(({ usage: _u, ...p }) => p) }));
    expect((await screen.findByTestId('usage-no-lines')).textContent).toContain('Usage is recorded while Logging is on');
    expect(screen.queryByTestId('usage-tokens-codex-cli')).toBeNull();
    expect(screen.queryByTestId('usage-role-helper')).toBeNull();
  });
});
