import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ActionView } from '../../../shared/actions';
import { ActionsSettingsView, filterActions } from './ActionsSettingsView';
import { useDispatcherStore } from '../dispatcher/dispatcherStore';
import { ActionForm } from './ActionForm';

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
});

describe('Settings > Actions', () => {
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
