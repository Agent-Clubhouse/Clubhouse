import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HELPER_ROUTING_LABELS, type HelperRoutingSettings, type PresetCellView, type QuotaView } from '../../../shared/helper-routing';
import { HelperPresetsSection } from './HelperPresetsSection';

const cell = (fields: Partial<PresetCellView> = {}): PresetCellView => ({
  effective: { model: 'opus', effort: 'high' }, source: 'builtin', state: 'valid', custom: null, builtin: { model: 'opus', effort: 'high' }, editable: true, ...fields,
});

const SERVER_TIME = '2027-01-15T08:10:00.000Z';
let providerQuota: QuotaView;

function settings(hard: Partial<PresetCellView> = {}, revision = 'r1.0'): HelperRoutingSettings {
  return {
    revision,
    serverTime: SERVER_TIME,
    labels: HELPER_ROUTING_LABELS,
    providers: {
      'claude-code': {
        autoEligible: true,
        quota: providerQuota,
        choices: { source: 'live', asOf: null, models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'] }, { id: 'sonnet', label: 'Sonnet', efforts: ['medium'] }] },
        cells: { easy: cell(), medium: cell(), hard: cell(hard) },
      },
      'copilot-cli': { autoEligible: false, reason: 'auto_not_supported', quota: { state: 'unknown', unknownReason: 'not_supported', source: 'none', asOf: null }, cells: null },
    },
  };
}

const app = () => window.clubhouse.app as unknown as { getHelperRouting: ReturnType<typeof vi.fn>; updateHelperRouting: ReturnType<typeof vi.fn> };

beforeEach(() => {
  providerQuota = { state: 'known', source: 'cli_query', asOf: '2027-01-15T08:00:00.000Z', limitingWindow: 'weekly', resetsAt: null, weekly: { usedPercent: 41, resetsAt: null }, fiveHour: null, refreshAfterSeconds: 300 };
  window.clubhouse.app.getHelperRouting = vi.fn(async () => settings());
  window.clubhouse.app.updateHelperRouting = vi.fn(async () => ({ ok: true as const, settings: settings({ source: 'custom', custom: { model: 'sonnet', effort: null } }, 'r2.0') }));
});

describe('HelperPresetsSection (#2671)', () => {
  it('lists Claude\'s presets and doesn\'t offer Copilot', async () => {
    render(<HelperPresetsSection />);
    expect(await screen.findByTestId('helper-presets-claude-code')).toBeTruthy();
    expect(screen.queryByTestId('helper-presets-copilot-cli')).toBeNull();
    expect((screen.getByTestId('helper-preset-claude-code-hard-model') as HTMLSelectElement).value).toBe('opus');
    expect(screen.getByText(/starting choices/)).toBeTruthy();
  });

  it('shows the level a start really uses, even when the list gives the model none', async () => {
    const shown = settings();
    const claude = shown.providers['claude-code'];
    if (!claude.autoEligible) throw new Error('eligible');
    claude.choices.models = [{ id: 'opus', label: 'Opus', efforts: [] }];
    app().getHelperRouting.mockResolvedValue(shown);
    render(<HelperPresetsSection />);
    const select = await screen.findByTestId('helper-preset-claude-code-hard-effort') as HTMLSelectElement;
    expect(select.value).toBe('high');
    expect(select.disabled).toBe(false);
  });

  it('shows a stale saved level, not Default', async () => {
    app().getHelperRouting.mockResolvedValue(settings({
      state: 'stale', staleReason: 'effort_unavailable', custom: { model: 'opus', effort: 'ultra' }, fallback: 'builtin_preset',
    }));
    render(<HelperPresetsSection />);
    expect((await screen.findByTestId('helper-preset-claude-code-hard-effort') as HTMLSelectElement).value).toBe('ultra');
  });

  it.each<[string, QuotaView, RegExp]>([
    ['known', { state: 'known', source: 'cli_query', asOf: '2027-01-15T08:00:00.000Z', limitingWindow: 'weekly', resetsAt: null, weekly: { usedPercent: 41, resetsAt: null } }, /^Limit available\. Weekly limit: 41% used\. Checked 10 min ago\./],
    ['low', { state: 'low', source: 'cli_query', asOf: SERVER_TIME, limitingWindow: 'fiveHour', resetsAt: null, fiveHour: { usedPercent: 85, resetsAt: null } }, /^Limit getting low\. 5-hour limit: 85% used\. Checked just now\./],
    ['near_limit', { state: 'near_limit', source: 'cli_query', asOf: SERVER_TIME, limitingWindow: 'weekly', resetsAt: null, weekly: { usedPercent: 96, resetsAt: null } }, /^Close to the limit\./],
    ['exhausted', { state: 'exhausted', source: 'session_event', asOf: SERVER_TIME, limitingWindow: 'weekly', resetsAt: null, weekly: { usedPercent: null, resetsAt: null } }, /^Limit reached\. Weekly limit\./],
    ['unknown, no plan', { state: 'unknown', unknownReason: 'not_applicable', source: 'cli_query', asOf: SERVER_TIME }, /^Plan limit unknown\. This login has no plan limit\./],
    ['unknown, stale', { state: 'unknown', unknownReason: 'stale', source: 'cli_query', asOf: '2027-01-15T07:00:00.000Z' }, /^Plan limit unknown\. Last checked too long ago\. Checked 70 min ago\./],
    ['unknown, failed', { state: 'unknown', unknownReason: 'read_failed', source: 'none', asOf: null }, /^Plan limit unknown\. Couldn’t check\./],
  ])('words the limit: %s', async (_name, quota, expected) => {
    providerQuota = quota;
    render(<HelperPresetsSection />);
    expect((await screen.findByTestId('helper-presets-claude-code-quota')).textContent).toMatch(expected);
  });

  it('never words unknown as available, and exhausted only when the state says so', async () => {
    providerQuota = { state: 'unknown', unknownReason: 'not_read', source: 'none', asOf: null };
    render(<HelperPresetsSection />);
    const text = (await screen.findByTestId('helper-presets-claude-code-quota')).textContent!;
    expect(text).not.toMatch(/available|reached/i);
  });

  it('reads again while open, when the reading would be new, not sooner than the floor', async () => {
    vi.useFakeTimers();
    try {
      providerQuota = { state: 'unknown', unknownReason: 'not_read', source: 'none', asOf: null, refreshAfterSeconds: 3 };
      render(<HelperPresetsSection />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(app().getHelperRouting).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
      expect(app().getHelperRouting).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(app().getHelperRouting).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves a new model with the revision it was made from, dropping a level it doesn\'t take', async () => {
    render(<HelperPresetsSection />);
    fireEvent.change(await screen.findByTestId('helper-preset-claude-code-hard-model'), { target: { value: 'sonnet' } });
    await waitFor(() => expect(app().updateHelperRouting).toHaveBeenCalledWith({
      revision: 'r1.0', cells: [{ provider: 'claude-code', difficulty: 'hard', model: 'sonnet', effort: null }],
    }));
    await waitFor(() => expect((screen.getByTestId('helper-preset-claude-code-hard-model') as HTMLSelectElement).value).toBe('sonnet'));
  });

  it('keeps a level the new model takes, and sets a level on its own', async () => {
    render(<HelperPresetsSection />);
    fireEvent.change(await screen.findByTestId('helper-preset-claude-code-hard-effort'), { target: { value: 'low' } });
    await waitFor(() => expect(app().updateHelperRouting).toHaveBeenCalledWith({
      revision: 'r1.0', cells: [{ provider: 'claude-code', difficulty: 'hard', model: 'opus', effort: 'low' }],
    }));
  });

  it('resets one cell or a provider, and only when there is something to reset', async () => {
    app().getHelperRouting.mockResolvedValue(settings({ source: 'custom', custom: { model: 'sonnet', effort: null } }));
    render(<HelperPresetsSection />);
    fireEvent.click(await screen.findByTestId('helper-preset-claude-code-hard-reset'));
    await waitFor(() => expect(app().updateHelperRouting).toHaveBeenCalledWith({ revision: 'r1.0', reset: { provider: 'claude-code', difficulty: 'hard' } }));
    expect((screen.getByTestId('helper-preset-claude-code-easy-reset') as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((screen.getByTestId('helper-presets-claude-code-reset') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('helper-presets-claude-code-reset'));
    await waitFor(() => expect(app().updateHelperRouting).toHaveBeenLastCalledWith({ revision: 'r2.0', reset: { provider: 'claude-code' } }));
  });

  it('says what is used when a saved choice is no longer offered, and when nothing is left', async () => {
    app().getHelperRouting.mockResolvedValue(settings({
      state: 'stale', staleReason: 'model_unavailable', custom: { model: 'gone', effort: 'high' }, fallback: 'builtin_preset',
    }));
    const { unmount } = render(<HelperPresetsSection />);
    expect((await screen.findByTestId('helper-preset-claude-code-hard-note')).textContent).toBe('No longer offered. Using opus until you change it.');
    // The saved value stays on show, even though it isn't in the list.
    expect((screen.getByTestId('helper-preset-claude-code-hard-model') as HTMLSelectElement).value).toBe('gone');
    unmount();
    app().getHelperRouting.mockResolvedValue(settings({ state: 'stale', effective: null, custom: { model: 'gone', effort: 'high' } }));
    render(<HelperPresetsSection />);
    expect((await screen.findByTestId('helper-preset-claude-code-hard-note')).textContent).toContain('refused until you change it');
  });

  it('shows a stale write\'s sentence and the fresh values, and doesn\'t retry', async () => {
    app().updateHelperRouting.mockResolvedValue({
      ok: false, code: 'helper_routing_stale', message: 'These presets changed since this page loaded.',
      settings: settings({ source: 'custom', custom: { model: 'sonnet', effort: null } }, 'r5.0'),
    });
    render(<HelperPresetsSection />);
    fireEvent.change(await screen.findByTestId('helper-preset-claude-code-hard-effort'), { target: { value: 'low' } });
    expect((await screen.findByTestId('helper-presets-error')).textContent).toContain('changed since this page loaded');
    await waitFor(() => expect((screen.getByTestId('helper-preset-claude-code-hard-model') as HTMLSelectElement).value).toBe('sonnet'));
    expect(app().updateHelperRouting).toHaveBeenCalledTimes(1);
  });
});
