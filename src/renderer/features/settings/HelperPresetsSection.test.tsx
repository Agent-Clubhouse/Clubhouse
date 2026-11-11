import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HELPER_ROUTING_LABELS, type HelperRoutingSettings, type PresetCellView, type QuotaView } from '../../../shared/helper-routing';
import { HelperPresetsSection, orderedProviders } from './HelperPresetsSection';

const cell = (fields: Partial<PresetCellView> = {}): PresetCellView => ({
  effective: { model: 'opus', effort: 'high' }, source: 'builtin', state: 'valid', custom: null, builtin: { model: 'opus', effort: 'high' }, editable: true, ...fields,
});

const copilotCell = (fields: Partial<PresetCellView> = {}): PresetCellView => cell({
  effective: { model: 'claude-sonnet-5.5', effort: 'medium' }, builtin: { model: 'claude-sonnet-5.5', effort: 'medium' }, ...fields,
});

const SERVER_TIME = '2027-01-15T08:10:00.000Z';
let providerQuota: QuotaView;

function settings(
  hard: Partial<PresetCellView> = {},
  revision = 'r1.0',
  bounds: { minimum?: Partial<PresetCellView>; maximum?: Partial<PresetCellView> } = {},
): HelperRoutingSettings {
  return {
    revision,
    serverTime: SERVER_TIME,
    auto: { effective: false, source: 'default', reason: 'not_enabled', scopes: { app: { value: false, editable: true } } },
    labels: HELPER_ROUTING_LABELS,
    providers: {
      'claude-code': {
        autoEligible: true,
        autoCandidate: true,
        quota: providerQuota,
        choices: { source: 'live', asOf: null, models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'] }, { id: 'sonnet', label: 'Sonnet', efforts: ['medium'] }] },
        cells: {
          minimum: cell({ follows: 'easy', ...bounds.minimum }),
          easy: cell(),
          medium: cell(),
          hard: cell(hard),
          maximum: cell({ follows: 'hard', ...bounds.maximum }),
        },
      },
      // Copilot has unreadable quota and a model list that may report no levels.
      'copilot-cli': {
        autoEligible: true,
        autoCandidate: true,
        quota: { state: 'unknown', unknownReason: 'not_supported', source: 'none', asOf: null },
        choices: { source: 'live', asOf: null, models: [{ id: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high'] }, { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5', efforts: [] }] },
        cells: {
          minimum: copilotCell({ follows: 'easy' }),
          easy: copilotCell(),
          medium: copilotCell(),
          hard: copilotCell(),
          maximum: copilotCell({ follows: 'hard' }),
        },
      },
      // A provider with no mapping at all is still left off the page.
      'other-cli': { autoEligible: false, reason: 'auto_not_supported', quota: { state: 'unknown', unknownReason: 'not_supported', source: 'none', asOf: null }, cells: null },
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
  it('turns Auto on app-wide with the revision it was made from', async () => {
    render(<HelperPresetsSection />);
    fireEvent.click(await screen.findByTestId('helper-presets-auto'));
    await waitFor(() => expect(app().updateHelperRouting).toHaveBeenCalledWith({ revision: 'r1.0', auto: true }));
    expect(screen.getByText(/balances plan use, not cost/)).toBeTruthy();
  });

  it('keeps the providers in a fixed order however main lists them, before and after a save (#3186)', async () => {
    const reorder = (shown: HelperRoutingSettings): HelperRoutingSettings => {
      const { 'claude-code': claude, ...rest } = shown.providers;
      // Main once added keys in the order its reads finished, so a save could put Claude last.
      return { ...shown, providers: { ...rest, 'codex-cli': { ...claude, autoCandidate: true }, 'claude-code': claude } };
    };
    window.clubhouse.app.getHelperRouting = vi.fn(async () => reorder(settings()));
    window.clubhouse.app.updateHelperRouting = vi.fn(async () => ({ ok: true as const, settings: reorder(settings({ source: 'custom', custom: { model: 'sonnet', effort: null } }, 'r2.0')) }));
    const order = () => [...document.querySelectorAll<HTMLElement>('[data-testid^="helper-presets-"][data-testid$="-cli"], [data-testid="helper-presets-claude-code"]')].map((el) => el.dataset.testid);
    render(<HelperPresetsSection />);
    await screen.findByTestId('helper-presets-claude-code');
    expect(order()).toEqual(['helper-presets-claude-code', 'helper-presets-codex-cli', 'helper-presets-copilot-cli']);
    fireEvent.change(screen.getByTestId('helper-preset-claude-code-hard-model'), { target: { value: 'sonnet' } });
    await waitFor(() => expect(app().updateHelperRouting).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByTestId('helper-preset-claude-code-hard-model') as HTMLSelectElement).value).toBe('sonnet'));
    expect(order()).toEqual(['helper-presets-claude-code', 'helper-presets-codex-cli', 'helper-presets-copilot-cli']);
  });

  it('orders preset CLIs first, then any other by id', () => {
    expect(orderedProviders({ zed: 1, 'copilot-cli': 2, alpha: 3, 'claude-code': 4, 'codex-cli': 5 }).map(([id]) => id))
      .toEqual(['claude-code', 'codex-cli', 'copilot-cli', 'alpha', 'zed']);
  });

  it('lists Claude\'s presets and leaves out a provider with no mapping', async () => {
    render(<HelperPresetsSection />);
    expect(await screen.findByTestId('helper-presets-claude-code')).toBeTruthy();
    expect(screen.queryByTestId('helper-presets-other-cli')).toBeNull();
    expect(screen.queryByTestId('helper-presets-claude-code-not-candidate')).toBeNull();
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

  describe('Check again (#2786)', () => {
    const button = () => screen.getByRole('button', { name: /^(Check again|Checking…)$/ }) as HTMLButtonElement;
    function deferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    }

    it('says what it is for in one sentence, and the ordinary read doesn\'t refresh', async () => {
      render(<HelperPresetsSection />);
      await screen.findByTestId('helper-presets-claude-code');
      expect(screen.getByText('Asks each CLI again for its models and limits, for after you sign in.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
      expect(app().getHelperRouting).toHaveBeenCalledWith();
    });

    it('asks with refresh, is busy until it answers, then shows the new state and saves nothing', async () => {
      // `stale` with no effective cell is the worst state the page can show. Whether
      // this is what the #2786 report showed isn't known: this pins the action only.
      app().getHelperRouting.mockResolvedValue(settings({ state: 'stale', staleReason: 'model_unavailable', effective: null, custom: { model: 'sonnet', effort: null } }));
      render(<HelperPresetsSection />);
      expect((await screen.findByTestId('helper-preset-claude-code-hard-note')).textContent).toContain('refused until you change it');

      const answer = deferred<HelperRoutingSettings>();
      app().getHelperRouting.mockReturnValue(answer.promise);
      fireEvent.click(button());
      await waitFor(() => expect(app().getHelperRouting).toHaveBeenLastCalledWith({ refresh: true }));
      expect(button().disabled).toBe(true);
      expect(button().getAttribute('aria-busy')).toBe('true');
      expect(button().textContent).toBe('Checking…');
      expect((screen.getByTestId('helper-preset-claude-code-hard-model') as HTMLSelectElement).disabled).toBe(true);

      await act(async () => { answer.resolve(settings({ state: 'valid', source: 'custom', effective: { model: 'sonnet', effort: null }, custom: { model: 'sonnet', effort: null } }, 'r1.1')); });
      expect(screen.queryByTestId('helper-preset-claude-code-hard-note')).toBeNull();
      expect(button().disabled).toBe(false);
      expect(button().textContent).toBe('Check again');
      expect(app().updateHelperRouting).not.toHaveBeenCalled();
    });

    it('a later save uses the revision the check brought back', async () => {
      render(<HelperPresetsSection />);
      await screen.findByTestId('helper-presets-claude-code');
      app().getHelperRouting.mockResolvedValue(settings({}, 'r1.1'));
      fireEvent.click(button());
      await waitFor(() => expect(button().disabled).toBe(false));
      fireEvent.change(screen.getByTestId('helper-preset-claude-code-hard-effort'), { target: { value: 'low' } });
      await waitFor(() => expect(app().updateHelperRouting).toHaveBeenCalledWith(expect.objectContaining({ revision: 'r1.1' })));
    });

    it('shows a failure the way the page does, and keeps what it had', async () => {
      render(<HelperPresetsSection />);
      await screen.findByTestId('helper-presets-claude-code');
      app().getHelperRouting.mockRejectedValue(new Error('main went away'));
      fireEvent.click(button());
      expect((await screen.findByTestId('helper-presets-error')).textContent).toBe('Couldn’t check again. main went away');
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByTestId('helper-presets-claude-code')).toBeTruthy();
      expect(button().disabled).toBe(false);
    });

    it('a timed read that overlapped it can\'t put the old state back', async () => {
      vi.useFakeTimers();
      try {
        providerQuota = { state: 'unknown', unknownReason: 'not_read', source: 'none', asOf: null, refreshAfterSeconds: 5 };
        render(<HelperPresetsSection />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        const timed = deferred<HelperRoutingSettings>();
        app().getHelperRouting.mockReturnValueOnce(timed.promise);
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(app().getHelperRouting).toHaveBeenCalledTimes(2);

        const checked = deferred<HelperRoutingSettings>();
        app().getHelperRouting.mockReturnValueOnce(checked.promise);
        await act(async () => { fireEvent.click(button()); });
        await act(async () => { checked.resolve(settings({ state: 'valid', source: 'custom', effective: { model: 'sonnet', effort: null }, custom: { model: 'sonnet', effort: null } })); });
        expect((screen.getByTestId('helper-preset-claude-code-hard-model') as HTMLSelectElement).value).toBe('sonnet');

        await act(async () => { timed.resolve(settings({ state: 'stale', staleReason: 'model_unavailable', effective: null, custom: { model: 'gone', effort: null } })); });
        expect((screen.getByTestId('helper-preset-claude-code-hard-model') as HTMLSelectElement).value).toBe('sonnet');
        expect(screen.queryByTestId('helper-preset-claude-code-hard-note')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('Reset still removes the override and doesn\'t ask the CLIs again', async () => {
      app().getHelperRouting.mockResolvedValue(settings({ source: 'custom', custom: { model: 'sonnet', effort: null } }));
      render(<HelperPresetsSection />);
      fireEvent.click(await screen.findByTestId('helper-preset-claude-code-hard-reset'));
      await waitFor(() => expect(app().updateHelperRouting).toHaveBeenCalledWith({ revision: 'r1.0', reset: { provider: 'claude-code', difficulty: 'hard' } }));
      expect(app().getHelperRouting).not.toHaveBeenCalledWith({ refresh: true });
    });
  });

  describe('Minimum and maximum (#3044)', () => {
    const select = (id: string) => screen.getByTestId(id) as HTMLSelectElement;

    it('lists them around the difficulties, following Easy and Hard until one is picked', async () => {
      render(<HelperPresetsSection />);
      await screen.findByTestId('helper-presets-claude-code');
      const rows = screen.getAllByTestId(/^helper-preset-claude-code-[a-z]+$/).map((row) => row.dataset.testid);
      expect(rows).toEqual(['minimum', 'easy', 'medium', 'hard', 'maximum'].map((level) => `helper-preset-claude-code-${level}`));
      expect(select('helper-preset-claude-code-minimum-model').value).toBe('');
      expect(select('helper-preset-claude-code-minimum-model').selectedOptions[0].textContent).toBe('Same as Easy (Opus)');
      expect(select('helper-preset-claude-code-maximum-model').selectedOptions[0].textContent).toBe('Same as Hard (Opus)');
      expect(select('helper-preset-claude-code-minimum-effort').value).toBe('high');
      expect((screen.getByTestId('helper-preset-claude-code-minimum-reset') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(/Until you pick one, they use Easy and Hard/)).toBeTruthy();
      // The difficulties have no follow choice.
      expect([...select('helper-preset-claude-code-easy-model').options].map((o) => o.value)).toEqual(['opus', 'sonnet']);
    });

    it('picking a model saves the minimum as its own choice', async () => {
      render(<HelperPresetsSection />);
      fireEvent.change(await screen.findByTestId('helper-preset-claude-code-minimum-model'), { target: { value: 'sonnet' } });
      await waitFor(() => expect(app().updateHelperRouting).toHaveBeenCalledWith({
        revision: 'r1.0', cells: [{ provider: 'claude-code', difficulty: 'minimum', model: 'sonnet', effort: null }],
      }));
    });

    it('a level while following saves the followed model with it', async () => {
      render(<HelperPresetsSection />);
      fireEvent.change(await screen.findByTestId('helper-preset-claude-code-maximum-effort'), { target: { value: 'low' } });
      await waitFor(() => expect(app().updateHelperRouting).toHaveBeenCalledWith({
        revision: 'r1.0', cells: [{ provider: 'claude-code', difficulty: 'maximum', model: 'opus', effort: 'low' }],
      }));
    });

    it('a saved one shows its model, and Same as Easy or Reset puts it back', async () => {
      const own = { minimum: { source: 'custom' as const, custom: { model: 'sonnet', effort: null }, effective: { model: 'sonnet', effort: null }, follows: undefined } };
      app().getHelperRouting.mockResolvedValue(settings({}, 'r1.0', own));
      render(<HelperPresetsSection />);
      const model = await screen.findByTestId('helper-preset-claude-code-minimum-model') as HTMLSelectElement;
      expect(model.value).toBe('sonnet');
      expect(model.options[0].textContent).toBe('Same as Easy');
      expect((screen.getByTestId('helper-presets-claude-code-reset') as HTMLButtonElement).disabled).toBe(false);
      fireEvent.change(model, { target: { value: '' } });
      await waitFor(() => expect(app().updateHelperRouting).toHaveBeenCalledWith({ revision: 'r1.0', reset: { provider: 'claude-code', difficulty: 'minimum' } }));
    });

    it('says what is used when a saved maximum is no longer offered', async () => {
      app().getHelperRouting.mockResolvedValue(settings({}, 'r1.0', {
        maximum: { state: 'stale', staleReason: 'model_unavailable', source: 'custom', custom: { model: 'gone', effort: null }, fallback: 'builtin_preset' },
      }));
      render(<HelperPresetsSection />);
      expect((await screen.findByTestId('helper-preset-claude-code-maximum-note')).textContent).toBe('No longer offered. Using opus until you change it.');
      expect(select('helper-preset-claude-code-maximum-model').value).toBe('gone');
      expect((screen.getByTestId('helper-preset-claude-code-maximum-reset') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  describe('Copilot (#3085)', () => {
    const copilotWith = (cells: Partial<Record<'minimum' | 'easy' | 'medium' | 'hard' | 'maximum', Partial<PresetCellView>>>) => {
      const shown = settings();
      const copilot = shown.providers['copilot-cli'];
      if (!copilot.autoEligible) throw new Error('eligible');
      for (const [level, fields] of Object.entries(cells)) Object.assign(copilot.cells[level as 'easy'], fields);
      return shown;
    };

    it('lists all five levels under Copilot and explains its unknown-quota last-resort role', async () => {
      render(<HelperPresetsSection />);
      expect((await screen.findByTestId('helper-presets-copilot-cli')).textContent).toContain('Copilot');
      const rows = screen.getAllByTestId(/^helper-preset-copilot-cli-[a-z]+$/).map((row) => row.dataset.testid);
      expect(rows).toEqual(['minimum', 'easy', 'medium', 'hard', 'maximum'].map((level) => `helper-preset-copilot-cli-${level}`));
      expect((screen.getByTestId('helper-preset-copilot-cli-minimum-model') as HTMLSelectElement).selectedOptions[0].textContent).toBe('Same as Easy (Claude Sonnet 5.5)');
      expect((screen.getByTestId('helper-preset-copilot-cli-maximum-model') as HTMLSelectElement).selectedOptions[0].textContent).toBe('Same as Hard (Claude Sonnet 5.5)');
      expect(screen.queryByTestId('helper-presets-copilot-cli-not-candidate')).toBeNull();
      expect(screen.getByText(/Copilot's quota is unknown/).textContent).toContain('even if another provider');
      expect((screen.getByTestId('helper-preset-copilot-cli-hard-effort') as HTMLSelectElement).value).toBe('medium');
    });

    it('allows Copilot by default and saves the opt-out with the current revision without enabling Auto', async () => {
      const saved = { ...settings({}, 'r2.0'), copilotAuto: false };
      app().updateHelperRouting.mockResolvedValue({ ok: true, settings: saved });
      render(<HelperPresetsSection />);
      const toggle = await screen.findByTestId('helper-presets-copilot-auto');
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      fireEvent.click(toggle);
      await waitFor(() => expect(app().updateHelperRouting).toHaveBeenCalledWith({ revision: 'r1.0', copilotAuto: false }));
      await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
      expect(screen.getByTestId('helper-presets-auto').getAttribute('aria-checked')).toBe('false');
      fireEvent.click(toggle);
      await waitFor(() => expect(app().updateHelperRouting).toHaveBeenLastCalledWith({ revision: 'r2.0', copilotAuto: true }));
    });

    it('says a model has no effort levels instead of offering choices', async () => {
      const none = { custom: { model: 'claude-haiku-4.5', effort: null }, effective: { model: 'claude-haiku-4.5', effort: null }, source: 'custom' as const };
      app().getHelperRouting.mockResolvedValue(copilotWith({ easy: none }));
      render(<HelperPresetsSection />);
      const cellText = await screen.findByTestId('helper-preset-copilot-cli-easy-effort-none');
      expect(cellText.textContent).toBe('No effort levels');
      expect(screen.queryByTestId('helper-preset-copilot-cli-easy-effort')).toBeNull();
      expect(screen.queryByTestId('helper-preset-copilot-cli-easy-note')).toBeNull();
      // Other rows still offer their model's levels.
      expect(screen.getByTestId('helper-preset-copilot-cli-medium-effort')).toBeTruthy();
    });

    it('picking a model with no levels saves it with no effort', async () => {
      render(<HelperPresetsSection />);
      fireEvent.change(await screen.findByTestId('helper-preset-copilot-cli-hard-model'), { target: { value: 'claude-haiku-4.5' } });
      await waitFor(() => expect(app().updateHelperRouting).toHaveBeenCalledWith({
        revision: 'r1.0', cells: [{ provider: 'copilot-cli', difficulty: 'hard', model: 'claude-haiku-4.5', effort: null }],
      }));
    });

    it('still shows a saved level on a model the list gives none', async () => {
      const saved = { custom: { model: 'claude-haiku-4.5', effort: 'low' }, effective: { model: 'claude-haiku-4.5', effort: 'low' }, source: 'custom' as const };
      app().getHelperRouting.mockResolvedValue(copilotWith({ hard: saved }));
      render(<HelperPresetsSection />);
      expect((await screen.findByTestId('helper-preset-copilot-cli-hard-effort') as HTMLSelectElement).value).toBe('low');
      expect(screen.queryByTestId('helper-preset-copilot-cli-hard-effort-none')).toBeNull();
    });

    it('resets a Copilot cell like the others', async () => {
      app().getHelperRouting.mockResolvedValue(copilotWith({ maximum: { source: 'custom', custom: { model: 'claude-sonnet-5.5', effort: 'high' }, follows: undefined } }));
      render(<HelperPresetsSection />);
      fireEvent.click(await screen.findByTestId('helper-preset-copilot-cli-maximum-reset'));
      await waitFor(() => expect(app().updateHelperRouting).toHaveBeenCalledWith({ revision: 'r1.0', reset: { provider: 'copilot-cli', difficulty: 'maximum' } }));
    });
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
