import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ActionView } from '../../../shared/actions';
import { ActionsSettingsView, filterActions } from './ActionsSettingsView';

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

  it('turns an action off from its row', async () => {
    list = [action({})];
    render(<ActionsSettingsView />);
    const toggle = await screen.findByRole('switch', { name: 'Turn off Morning plan' });
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

  it('filters by owner and by turned off', () => {
    const all = [action({}), action({ id: 'b', owner: { kind: 'agent', agentId: 'x' } }), action({ id: 'c', enabled: false })];
    expect(filterActions(all, 'you').map((a) => a.id)).toEqual(['a1', 'c']);
    expect(filterActions(all, 'agents').map((a) => a.id)).toEqual(['b']);
    expect(filterActions(all, 'off').map((a) => a.id)).toEqual(['c']);
  });
});
