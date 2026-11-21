import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RemoteActionRelationshipPage } from '../../../../shared/remote-action-page';
import { SelectedActionsPage, type SelectedActionPageStatus } from './SelectedActionsPage';
const value = (offset = 0): RemoteActionRelationshipPage => ({ version: 1, source: 'selected-action-relationships', state: 'recorded', offset, selection: 'a'.repeat(64), next: offset ? null : 25, totalRelationships: 26, uniqueActions: 26, observedAt: 1, notes: ['Recorded host history only.'], rows: Array.from({ length: offset ? 1 : 25 }, (_, i) => ({ key: (offset + i).toString(16).padStart(64, '0'), name: `Action ${offset + i}`, group: 'owned', enabled: i % 2 === 0, description: 'When Selected sleeps → Notify you', lastRun: { outcome: 'done', startedAt: 1_800_000_000_000 } })) });
const show = (extra = {}) => { const onPage = vi.fn(); return { onPage, ...render(<SelectedActionsPage selectionKey="host1:parent:epoch1" offset={0} result={{ selectionKey: 'host1:parent:epoch1', value: value() }} status="ok" agentName="Selected" onPage={onPage} {...extra} />) }; };
afterEach(cleanup);
it('presents bounded read-only rows with the existing short descriptions and recorded state/time', () => {
  const { onPage } = show(); expect(screen.getAllByTestId('selected-action-row')).toHaveLength(25); expect(screen.getByText('Action 0')).toBeInTheDocument(); expect(screen.getAllByText('When Selected sleeps → Notify you')).toHaveLength(25); expect(screen.getAllByText(/Last recorded: Done/)).toHaveLength(25);
  fireEvent.click(screen.getByRole('button', { name: 'Next Actions' })); expect(onPage).toHaveBeenCalledExactlyOnceWith(25, 'a'.repeat(64));
  expect(screen.queryByRole('button', { name: /Run|Edit|Delete/i })).not.toBeInTheDocument();
});
it.each(['loading', 'offline', 'forbidden', 'unavailable', 'error', 'rate_limited'] as SelectedActionPageStatus[])('withholds prior private rows when the read is %s', (status) => { show({ status }); expect(screen.queryByText('Action 0')).not.toBeInTheDocument(); expect(screen.queryByTestId('selected-action-row')).not.toBeInTheDocument(); });
it('rejects late selection/reconnect/wrong-page results rather than falling back to older rows', () => {
  const { rerender, onPage } = show();
  for (const key of ['host2:parent:epoch1', 'host1:other:epoch1', 'host1:parent:epoch2']) {
    rerender(<SelectedActionsPage selectionKey={key} offset={0} result={{ selectionKey: 'host1:parent:epoch1', value: value() }} status="ok" agentName="Selected" onPage={onPage} />); expect(screen.queryByText('Action 0')).not.toBeInTheDocument();
  }
  rerender(<SelectedActionsPage selectionKey="host1:parent:epoch1" offset={25} result={{ selectionKey: 'host1:parent:epoch1', value: value() }} status="ok" agentName="Selected" onPage={onPage} />); expect(screen.queryByText('Action 0')).not.toBeInTheDocument();
  rerender(<SelectedActionsPage selectionKey="host1:parent:epoch1" offset={25} result={{ selectionKey: 'host1:parent:epoch1', value: value(25) }} status="ok" agentName="Selected" onPage={onPage} />); expect(screen.getByText('Action 25')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Next Actions' })).toBeDisabled();
});
it('lets a changed relationship inventory return to a fresh first page without reusing its stale token', () => {
  const { onPage } = show({ result: { selectionKey: 'host1:parent:epoch1', value: { version: 1, source: 'selected-action-relationships', state: 'unavailable', offset: 0, observedAt: 1, notes: [], reason: 'changed' } } });
  expect(screen.queryByText('Action 0')).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: 'First Actions page' })); expect(onPage).toHaveBeenCalledExactlyOnceWith(0);
});
it('preserves all relationship groups when an Action has multiple roles', () => {
  const all = value(); if (all.state !== 'recorded') throw new Error('Expected page');
  const row = all.rows[0]; const multi = { ...all, next: null, totalRelationships: 3, uniqueActions: 1, rows: [{ ...row, key: 'b'.repeat(64), group: 'owned' }, { ...row, key: 'c'.repeat(64), group: 'targeting' }, { ...row, key: 'd'.repeat(64), group: 'triggered-by' }] };
  show({ result: { selectionKey: 'host1:parent:epoch1', value: multi } }); expect(screen.getAllByText('Action 0')).toHaveLength(3); expect(screen.getByRole('region', { name: 'Owned by Selected' })).toBeInTheDocument(); expect(screen.getByRole('region', { name: 'Targets Selected' })).toBeInTheDocument(); expect(screen.getByRole('region', { name: 'Set off by Selected' })).toBeInTheDocument();
});
