import { act, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupProjectOperation, GroupProjectOperations } from '../../../shared/group-project-types';
import { initGroupProjectListener, useGroupProjectStore } from '../../stores/groupProjectStore';
import { GroupOperationStatus, operationStatusText } from './GroupOperationStatus';

const GP = 'gp_ops';
const api = () => window.clubhouse.groupProject;

function op(over: Partial<GroupProjectOperation> & Pick<GroupProjectOperation, 'id' | 'outcome'>): GroupProjectOperation {
  return { groupProjectId: GP, op: 'update', section: 'details', author: { label: 'user' }, since: '2026-11-16T10:00:00.000Z', ...over };
}
const read = (...operations: GroupProjectOperation[]): GroupProjectOperations => ({ operations, omittedQueued: 0 });

beforeEach(() => {
  vi.restoreAllMocks();
  useGroupProjectStore.setState({ operations: {} });
});

describe('GroupOperationStatus', () => {
  it('says waiting for the host, applied, or refused with why, and never saved', async () => {
    vi.spyOn(api(), 'getOperations').mockResolvedValue(read(
      op({ id: 'a', op: 'update', since: '2026-11-16T10:00:00.000Z', outcome: { status: 'queued', waitingFor: 'Studio Mac', since: '2026-11-16T10:00:00.000Z' } }),
      op({ id: 'b', op: 'membership', section: 'members', outcome: { status: 'applied' }, settledAt: '2026-11-16T10:05:00.000Z' }),
    ));
    render(<GroupOperationStatus groupProjectId={GP} sections={['details', 'members']} label="Changes" />);
    const list = await screen.findByRole('list', { name: 'Changes' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-status'))).toEqual(['applied', 'queued']);
    expect(items[1]).toHaveTextContent(/^Details change: Waiting for Studio Mac since /);
    expect(items[0]).toHaveTextContent('Membership change: Applied');
    expect(list).not.toHaveTextContent(/saved/i);
  });

  it('shows a refusal with its reason, in the error style', async () => {
    vi.spyOn(api(), 'getOperations').mockResolvedValue(read(
      op({ id: 'r', op: 'deleteTopic', section: 'cleanup', outcome: { status: 'refused', reason: 'Studio Mac refused this change: The system channel can\'t be deleted.' } }),
    ));
    render(<GroupOperationStatus groupProjectId={GP} sections={['cleanup']} label="Cleanup changes" />);
    const item = await screen.findByText(/Topic deletion: Refused:/);
    expect(item).toHaveTextContent('Refused: Studio Mac refused this change');
    expect(item.className).toContain('text-ctp-error');
  });

  it('lists only its own sections, and nothing when none was forwarded', async () => {
    vi.spyOn(api(), 'getOperations').mockResolvedValue(read(op({ id: 'm', op: 'membership', section: 'members', outcome: { status: 'applied' } })));
    const { container } = render(<GroupOperationStatus groupProjectId={GP} sections={['cleanup']} label="Cleanup changes" />);
    await act(async () => undefined);
    expect(useGroupProjectStore.getState().operations[GP]).toBeDefined();
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the five latest and counts the rest', async () => {
    const many = Array.from({ length: 8 }, (_, n) => op({
      id: `q${n}`, since: `2026-11-16T10:0${n}:00.000Z`, outcome: { status: 'queued', waitingFor: 'Studio Mac', since: `2026-11-16T10:0${n}:00.000Z` },
    }));
    vi.spyOn(api(), 'getOperations').mockResolvedValue(read(...many));
    render(<GroupOperationStatus groupProjectId={GP} sections={['details']} label="Details changes" />);
    const list = await screen.findByRole('list', { name: 'Details changes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('and 3 more.')).toBeInTheDocument();
  });

  it('reads again when main says a change moved', async () => {
    let moved: ((id: string) => void) | undefined;
    vi.spyOn(api(), 'onOperationsChanged').mockImplementation((fn) => { moved = fn; return () => undefined; });
    const get = vi.spyOn(api(), 'getOperations').mockResolvedValue(read(
      op({ id: 'a', outcome: { status: 'queued', waitingFor: 'Studio Mac', since: '2026-11-16T10:00:00.000Z' } }),
    ));
    const stop = initGroupProjectListener();
    render(<GroupOperationStatus groupProjectId={GP} sections={['details']} label="Details changes" />);
    expect(await screen.findByText(/Waiting for Studio Mac/)).toBeInTheDocument();
    get.mockResolvedValue(read(op({ id: 'a', outcome: { status: 'applied' }, settledAt: '2026-11-16T10:10:00.000Z' })));
    await act(async () => { moved?.(GP); });
    expect(await screen.findByText('Details change: Applied')).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for/)).toBeNull();
    stop();
  });
});

describe('operationStatusText', () => {
  it('words each outcome', () => {
    expect(operationStatusText(op({ id: '1', outcome: { status: 'applied' } }))).toBe('Applied');
    expect(operationStatusText(op({ id: '2', outcome: { status: 'refused', reason: 'No.' } }))).toBe('Refused: No.');
    expect(operationStatusText(op({ id: '3', outcome: { status: 'queued', waitingFor: 'Desk', since: 'not a date' } }))).toBe('Waiting for Desk since an unknown time');
  });
});

describe('the store', () => {
  it('keeps the latest read when an older one finishes last, and the last read when one fails', async () => {
    let slow!: (value: GroupProjectOperations) => void;
    const get = vi.spyOn(api(), 'getOperations')
      .mockImplementationOnce(() => new Promise((resolve) => { slow = resolve; }))
      .mockResolvedValueOnce(read(op({ id: 'new', outcome: { status: 'applied' } })));
    const first = useGroupProjectStore.getState().loadOperations(GP);
    await useGroupProjectStore.getState().loadOperations(GP);
    slow(read(op({ id: 'old', outcome: { status: 'applied' } })));
    await first;
    expect(useGroupProjectStore.getState().operations[GP].operations.map((o) => o.id)).toEqual(['new']);
    get.mockRejectedValueOnce(new Error('IPC failed'));
    await useGroupProjectStore.getState().loadOperations(GP);
    expect(useGroupProjectStore.getState().operations[GP].operations.map((o) => o.id)).toEqual(['new']);
  });
});
