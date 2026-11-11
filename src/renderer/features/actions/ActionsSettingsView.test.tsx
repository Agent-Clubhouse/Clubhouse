import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ActionView } from '../../../shared/actions';
import { ActionsSettingsView, filterActions } from './ActionsSettingsView';
import { useDispatcherStore } from '../dispatcher/dispatcherStore';
import { ActionForm } from './ActionForm';
import { useAgentStore } from '../../stores/agentStore';

function action(over: Partial<ActionView>): ActionView {
  return {
    id: 'a1', name: 'Morning plan', trigger: { kind: 'schedule', preset: 'weekdays', cron: '0 9 * * 1-5', missed: 'skip' },
    steps: [{ kind: 'notify', text: 'Plan the day' }], overlap: 'skip', owner: { kind: 'user' }, enabled: true,
    createdAt: 1, updatedAt: 1, running: false, ...over,
  };
}

let list: ActionView[];
beforeEach(() => {
  list = [];
  window.clubhouse.actions.list = vi.fn(async () => list);
  window.clubhouse.actions.setEnabled = vi.fn(async (id: string, enabled: boolean) => ({ ...list.find((a) => a.id === id)!, enabled }));
  window.clubhouse.actions.history = vi.fn(async () => []);
  window.clubhouse.actions.usage = vi.fn(async () => []);
});

describe('Settings > Actions', () => {
  it('keeps an older quick step on the project provider until Auto is explicitly selected', () => {
    render(<ActionForm open action={action({ steps: [{ kind: 'quick', projectId: 'p1', prompt: 'Review changes' }] })} onClose={vi.fn()} onSaved={vi.fn()} />);
    const form = screen.getByTestId('action-form');
    expect((within(form).getByLabelText('Provider') as HTMLSelectElement).value).toBe('');
    expect(within(form).queryByLabelText('Difficulty')).toBeNull();
    fireEvent.change(within(form).getByLabelText('Provider'), { target: { value: 'auto' } });
    expect((within(form).getByLabelText('Difficulty') as HTMLSelectElement).value).toBe('medium');
    fireEvent.change(within(form).getByLabelText('Difficulty'), { target: { value: 'hard' } });
    expect((within(form).getByLabelText('Difficulty') as HTMLSelectElement).value).toBe('hard');
    fireEvent.change(within(form).getByLabelText('Provider'), { target: { value: '' } });
    expect(within(form).queryByLabelText('Difficulty')).toBeNull();
  });

  it('shows a plain owner list with recent runs, failures and links to saved Actions', async () => {
    list = [action({})];
    window.clubhouse.actions.usage = vi.fn(async () => [
      { owner: { kind: 'user' }, actions: [{ id: 'a1', name: 'Morning plan' }], runs24h: 2, runs7d: 3, failures24h: 1, failures7d: 1 },
      { owner: { kind: 'dispatcher' }, actions: [], runs24h: 1, runs7d: 4, failures24h: 0, failures7d: 2 },
    ]);
    const { rerender } = render(<ActionsSettingsView />);
    fireEvent.click(await screen.findByRole('tab', { name: 'By owner' }));
    const usage = await screen.findByTestId('actions-owner-usage');
    expect(await within(usage).findByText('You')).toBeTruthy();
    expect(within(usage).getByText('Last 24 hours: 2 recent runs, 1 failure.')).toBeTruthy();
    expect(within(usage).getByText('Last 7 days: 3 recent runs, 1 failure.')).toBeTruthy();
    expect(within(usage).getByText(/last 7 days is not a full total/)).toBeTruthy();
    expect(within(usage).getAllByTestId('actions-owner')).toHaveLength(2);
    rerender(<ActionsSettingsView />);
    expect(window.clubhouse.actions.usage).toHaveBeenCalledTimes(1);
    expect(window.clubhouse.actions.history).not.toHaveBeenCalled();
    fireEvent.click(within(usage).getByRole('button', { name: 'Morning plan' }));
    expect(await screen.findByTestId('action-card')).toBeTruthy();
  });

  it('keeps owner usage available after all saved Actions are gone and reports load failures', async () => {
    window.clubhouse.actions.usage = vi.fn(async () => { throw new Error('History unavailable'); });
    render(<ActionsSettingsView />);
    fireEvent.click(await screen.findByRole('tab', { name: 'By owner' }));
    expect((await screen.findByRole('alert')).textContent).toContain('History unavailable');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('offers quick agents as trigger sources without offering them as durable step targets', () => {
    const previous = useAgentStore.getState().agents;
    useAgentStore.setState({ agents: { ...previous, quick: { id: 'quick', name: 'Quick review', projectId: 'p1', kind: 'quick', status: 'running', color: 'gray' } } });
    try {
      render(<ActionForm open onClose={vi.fn()} initial={{
        trigger: { kind: 'event', event: 'agent.quick_finished', source: { kind: 'agent', agentId: 'quick' } },
        steps: [{ kind: 'wake', agentId: '' }],
      }} />);
      expect(screen.getByRole('option', { name: 'Quick review' })).toHaveValue('agent:quick');
      expect(within(screen.getByTestId('action-step-0')).queryByRole('option', { name: 'Quick review' })).toBeNull();
    } finally {
      useAgentStore.setState({ agents: previous });
    }
  });
  it('offers any readable agent for turns and quick finishes with bounded grouping', async () => {
    list = [action({
      trigger: { kind: 'event', event: 'agent.turn_ended', source: { kind: 'any' }, coalesceSeconds: 15 },
    })];
    render(<ActionsSettingsView />);
    fireEvent.click(await screen.findByText('Morning plan'));
    const card = await screen.findByTestId('action-card');
    expect(within(card).getByText(/any readable agent finishes a turn, grouped for 15 seconds from the first turn/)).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    const form = await screen.findByTestId('action-form');
    const group = within(form).getByLabelText('Group turns for (seconds)') as HTMLInputElement;
    expect([group.min, group.max, group.value]).toEqual(['10', '600', '15']);
    expect(within(form).getByText(/allowed by default for the Dispatcher and can be turned off/)).toBeTruthy();
    expect(within(form).queryByLabelText('Wait first (minutes, optional)')).toBeNull();
    fireEvent.change(within(form).getByLabelText('What happens'), { target: { value: 'agent.turn_failed' } });
    expect(within(form).getByRole('option', { name: 'Any readable agent' })).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('What happens'), { target: { value: 'agent.quick_finished' } });
    expect(within(form).getByRole('option', { name: 'Any readable agent' })).toBeTruthy();
    expect(within(form).getByLabelText('Group finishes for (seconds)')).toHaveValue(15);
    expect(within(form).getByText(/Includes durable and quick agents/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('What happens'), { target: { value: 'agent.slept' } });
    expect(within(form).queryByRole('option', { name: 'Any readable agent' })).toBeNull();
    expect(within(form).queryByLabelText('Group turns for (seconds)')).toBeNull();
    expect(within(form).getByLabelText('Wait first (minutes, optional)')).toBeTruthy();
  });

  it('offers time and daily filters for all event kinds and shows them on the card', async () => {
    list = [action({
      trigger: { kind: 'event', event: 'app.returned', source: { kind: 'app' }, afterLocalTime: '08:00', oncePerDay: true },
    })];
    render(<ActionsSettingsView />);
    fireEvent.click(await screen.findByText('Morning plan'));
    const card = await screen.findByTestId('action-card');
    expect(within(card).getByText(/at or after 8:00 AM local time, once per calendar day/)).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    const form = await screen.findByTestId('action-form');
    expect((within(form).getByLabelText('After local time (optional)') as HTMLInputElement).value).toBe('08:00');
    expect((within(form).getByLabelText('Once per calendar day') as HTMLInputElement).checked).toBe(true);
    fireEvent.change(within(form).getByLabelText('What happens'), { target: { value: 'agent.turn_ended' } });
    expect((within(form).getByLabelText('Once per calendar day') as HTMLInputElement).checked).toBe(true);
  });

  it('offers the return event with a configurable absence threshold', async () => {
    render(<ActionsSettingsView />);
    fireEvent.click(await screen.findByTestId('actions-new'));
    const form = await screen.findByTestId('action-form');
    fireEvent.change(within(form).getByLabelText('Runs'), { target: { value: 'event' } });
    fireEvent.change(within(form).getByLabelText('What happens'), { target: { value: 'app.returned' } });
    const absence = within(form).getByLabelText('Away for (minutes)') as HTMLInputElement;
    expect(absence.min).toBe('5');
    expect(absence.placeholder).toBe('30');
    expect(within(form).getAllByLabelText('Agent')).toHaveLength(1);
    expect(within(form).getByText(/Relaunching Clubhouse does not count/)).toBeTruthy();
  });

  it('shows remaining runs and the end time on a bounded action card', async () => {
    list = [action({ maxRuns: 5, runsUsed: 2, endsAt: new Date(2027, 0, 5, 9).getTime() })];
    render(<ActionsSettingsView />);
    fireEvent.click(await screen.findByText('Morning plan'));
    const card = await screen.findByTestId('action-card');
    expect(within(card).getByText(/3 of 5 runs remaining\. Ends Jan 5, 2027 at 9:00 AM/)).toBeTruthy();
  });

  it('offers optional recurring limits and hides them for once', async () => {
    render(<ActionsSettingsView />);
    fireEvent.click(await screen.findByTestId('actions-new'));
    const form = await screen.findByTestId('action-form');
    expect(within(form).getByLabelText('Ends at (optional)')).toBeTruthy();
    expect(within(form).getByLabelText('Maximum runs (optional)')).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Runs'), { target: { value: 'once' } });
    expect(within(form).queryByLabelText('Maximum runs (optional)')).toBeNull();
    expect(within(form).queryByLabelText('Ends at (optional)')).toBeNull();
  });

  it('shows what actions do and three starters when there are none', async () => {
    render(<ActionsSettingsView />);
    const empty = await screen.findByTestId('actions-empty');
    expect(within(empty).getAllByRole('button', { name: 'Use' })).toHaveLength(3);
    fireEvent.click(within(empty).getAllByRole('button', { name: 'Use' })[0]);
    expect(await screen.findByTestId('action-form')).toBeTruthy();
  });

  describe('Action form dismissal', () => {
    const ways = ['Escape', 'backdrop', 'Close', 'Cancel'];
    const dismiss = (way: string) => {
      const form = screen.getByTestId('action-form');
      if (way === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
      else if (way === 'backdrop') fireEvent.click(form.parentElement!);
      else fireEvent.click(within(form).getByRole('button', { name: way }));
    };

    it.each(ways)('closes a pristine new form via %s', (way) => {
      const onClose = vi.fn();
      render(<ActionForm open onClose={onClose} />);
      dismiss(way);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it.each(ways)('closes a pristine edit form via %s', (way) => {
      const onClose = vi.fn();
      render(<ActionForm open action={action({})} onClose={onClose} />);
      dismiss(way);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('treats a prefilled starter as pristine', () => {
      const onClose = vi.fn();
      render(<ActionForm open initial={action({})} onClose={onClose} />);
      dismiss('Escape');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it.each(ways)('confirms dirty dismissal via %s', (way) => {
      const onClose = vi.fn();
      render(<ActionForm open action={action({})} onClose={onClose} />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My changed action' } });
      dismiss(way);
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
      expect(screen.getByLabelText('Name')).toHaveValue('My changed action');
      dismiss(way);
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('treats reverted changes as pristine', () => {
      const onClose = vi.fn();
      render(<ActionForm open action={action({})} onClose={onClose} />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Changed' } });
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Morning plan' } });
      dismiss('Escape');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it.each(['Save', 'Run now'])('blocks every dismissal while %s is pending and shows its eventual error', async (operation) => {
      let fail!: (reason: Error) => void;
      const pending = new Promise<never>((_resolve, reject) => { fail = reject; });
      const api = window.clubhouse.actions;
      if (operation === 'Save') api.update = vi.fn(() => pending);
      else api.runNow = vi.fn(() => pending);
      const onClose = vi.fn();
      render(<ActionForm open action={action({})} onClose={onClose} />);
      fireEvent.click(within(screen.getByTestId('action-form')).getByRole('button', { name: operation }));
      for (const way of ways) dismiss(way);
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
      fail(new Error('Operation failed'));
      expect(await screen.findByText('Operation failed')).toBeVisible();
      dismiss('Close');
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('says a quick agent step runs with Full access, with no Access choice', async () => {
    render(<ActionsSettingsView />);
    fireEvent.click(await screen.findByTestId('actions-new'));
    const form = await screen.findByTestId('action-form');
    fireEvent.change(within(form).getByLabelText('Step 1 type'), { target: { value: 'quick' } });
    expect(within(form).getByTestId('action-form-quick-access').textContent).toBe('Agent steps run with Full access, so they never stop to ask.');
    expect(within(form).queryByLabelText('Access')).toBeNull();
  });

  it('lists actions in plain words, with owner, last run and the reason a row needs attention', async () => {
    list = [
      action({}),
      action({ id: 'a2', name: 'Tidy', owner: { kind: 'dispatcher' }, enabled: false, offReason: 'Turned off: pm was deleted' }),
    ];
    render(<ActionsSettingsView />);
    const rows = await screen.findAllByTestId('action-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Weekdays at 9:00 AM → Notify you')).toBeTruthy();
    expect(within(rows[0]).getByText('You')).toBeTruthy();
    expect(within(rows[0]).getByText('Not run yet')).toBeTruthy();
    expect(within(rows[1]).getByTestId('action-row-reason').textContent).toBe('Turned off: pm was deleted');
    expect(within(rows[1]).getByText('Dispatcher')).toBeTruthy();
  });

  it('shows an agent’s subscription as its own action that tells it (#3042)', async () => {
    list = [action({
      id: 's1', name: 'Tell the agent when main is pushed', owner: { kind: 'dispatcher' }, subscription: true,
      trigger: { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: 'nobody' } },
      steps: [{ kind: 'message', agentId: 'disp', text: 'You asked to be told when this happens.' }],
    })];
    render(<ActionsSettingsView />);
    const rows = await screen.findAllByTestId('action-row');
    expect(within(rows[0]).getByText('When an agent goes to sleep → Tell the Dispatcher')).toBeTruthy();
  });

  it('names the Dispatcher by its display name as the creator (#3184)', async () => {
    useDispatcherStore.setState({ state: { config: { name: 'Navi' } } } as never);
    try {
      list = [
        action({ id: 'a2', name: 'Tidy', owner: { kind: 'dispatcher' } }),
        action({ id: 's1', name: 'Tell', owner: { kind: 'dispatcher' }, subscription: true, trigger: { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: 'nobody' } }, steps: [{ kind: 'message', agentId: 'disp', text: 'hi' }] }),
      ];
      render(<ActionsSettingsView />);
      const rows = await screen.findAllByTestId('action-row');
      expect(within(rows[0]).getAllByText('Navi').length).toBeGreaterThan(0);
      expect(within(rows[0]).queryByText('Dispatcher')).toBeNull();
      expect(within(rows[1]).getByText('When an agent goes to sleep → Tell Navi')).toBeTruthy();
    } finally {
      useDispatcherStore.setState({ state: null } as never);
    }
  });

  it('turns an action off from its row', async () => {
    list = [action({})];
    render(<ActionsSettingsView />);
    const toggle = await screen.findByRole('switch', { name: 'Morning plan' });
    fireEvent.click(toggle);
    await waitFor(() => expect(window.clubhouse.actions.setEnabled).toHaveBeenCalledWith('a1', false));
  });

  it('opens the card from a row', async () => {
    list = [action({ problem: 'Couldn’t wake pm: it is gone.' })];
    render(<ActionsSettingsView />);
    fireEvent.click(await screen.findByText('Morning plan'));
    const card = await screen.findByTestId('action-card');
    expect(within(card).getByText(/Last run couldn’t finish/)).toBeTruthy();
    expect(await within(card).findByText('No runs yet.')).toBeTruthy();
  });

  it('shows queued message acceptance without claiming confirmed delivery', async () => {
    list = [action({ steps: [{ kind: 'message', agentId: 'pm', text: 'Plan the day' }] })];
    window.clubhouse.actions.history = vi.fn(async () => [{
      id: 'r1', actionId: 'a1', trigger: { kind: 'schedule' as const, at: 1 }, chain: [],
      startedAt: 1, endedAt: 2, outcome: 'done' as const,
      steps: [{ kind: 'message' as const, outcome: 'done' as const, detail: "Queued for pm's next turn", delivery: 'queued' as const, agentId: 'pm' }],
    }]);
    render(<ActionsSettingsView />);
    fireEvent.click(await screen.findByText('Morning plan'));
    const run = await screen.findByTestId('action-run');
    expect(within(run).getByText("Queued for pm's next turn")).toBeTruthy();
    expect(within(run).getByText('The action fired. The message was queued, not confirmed delivered.')).toBeTruthy();
    expect(within(run).queryByText('Sent the message to pm')).toBeNull();
  });

  it('filters by owner and by turned off', () => {
    const all = [action({}), action({ id: 'b', owner: { kind: 'agent', agentId: 'x' } }), action({ id: 'c', enabled: false })];
    expect(filterActions(all, 'you').map((a) => a.id)).toEqual(['a1', 'c']);
    expect(filterActions(all, 'agents').map((a) => a.id)).toEqual(['b']);
    expect(filterActions(all, 'off').map((a) => a.id)).toEqual(['c']);
  });
});
