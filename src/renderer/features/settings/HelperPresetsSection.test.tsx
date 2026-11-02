import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HELPER_ROUTING_LABELS, type HelperRoutingSettings, type PresetCellView } from '../../../shared/helper-routing';
import { HelperPresetsSection } from './HelperPresetsSection';

const cell = (fields: Partial<PresetCellView> = {}): PresetCellView => ({
  effective: { model: 'opus', effort: 'high' }, source: 'builtin', state: 'valid', custom: null, builtin: { model: 'opus', effort: 'high' }, editable: true, ...fields,
});

function settings(hard: Partial<PresetCellView> = {}, revision = 'r1.0'): HelperRoutingSettings {
  return {
    revision,
    labels: HELPER_ROUTING_LABELS,
    providers: {
      'claude-code': {
        autoEligible: true,
        choices: { source: 'live', asOf: null, models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'] }, { id: 'sonnet', label: 'Sonnet', efforts: ['medium'] }] },
        cells: { easy: cell(), medium: cell(), hard: cell(hard) },
      },
      'copilot-cli': { autoEligible: false, reason: 'auto_not_supported', cells: null },
    },
  };
}

const app = () => window.clubhouse.app as unknown as { getHelperRouting: ReturnType<typeof vi.fn>; updateHelperRouting: ReturnType<typeof vi.fn> };

beforeEach(() => {
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
