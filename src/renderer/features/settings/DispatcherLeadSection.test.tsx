import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DispatcherLeadState } from '../../../shared/dispatcher-lead';
import { LeadSection, leadConfirmation, leadOffWarning, leadStatus, listNames } from './DispatcherLeadSection';
import { _resetLeadStoreForTesting } from '../dispatcher/leadStore';

const PEERS: DispatcherLeadState = {
  available: true, canChoose: true, role: 'peer', lead: null,
  choices: [
    { machine: 'desk', name: 'Desk', self: true, online: true, dispatcherOn: true },
    { machine: 'laptop', name: 'Laptop', self: false, online: true, dispatcherOn: true },
    { machine: 'studio', name: 'Studio', self: false, online: false, dispatcherOn: false },
  ],
  confirmedBy: [], waitingOn: [], clearedFor: null, changedByName: null, changedAt: null,
  following: false, tookBack: false, leadLastSeen: null, outbox: { waiting: 0, oldestAt: null, expired: 0, failed: null },
};
const FOLLOWING: DispatcherLeadState = {
  ...PEERS, role: 'follower', following: true, lead: PEERS.choices[1], confirmedBy: ['Laptop'], waitingOn: ['Studio'],
  changedByName: 'Desk', changedAt: '2026-11-13T10:00:00.000Z',
};

let changed: ((state: DispatcherLeadState) => void) | undefined;
beforeEach(() => {
  changed = undefined;
  _resetLeadStoreForTesting();
  Object.assign(window.clubhouse.dispatcher, {
    getLead: vi.fn(async () => PEERS),
    setLead: vi.fn(async () => FOLLOWING),
    onLeadChanged: vi.fn((cb: (state: DispatcherLeadState) => void) => { changed = cb; return () => { changed = undefined; }; }),
  });
});

describe('Settings › Dispatcher › Lead (#3351)', () => {
  it('is hidden outside a network with another computer', async () => {
    window.clubhouse.dispatcher.getLead = vi.fn(async () => ({ ...PEERS, available: false, choices: [] }));
    const { container } = render(<LeadSection />);
    await waitFor(() => expect(window.clubhouse.dispatcher.getLead).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('lists None, this computer and each member, and saves a person’s choice', async () => {
    render(<LeadSection />);
    const select = await screen.findByTestId('dispatcher-lead') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['None', 'Desk (this computer)', 'Laptop', 'Studio (offline, Dispatcher off)']);
    expect(select.value).toBe('');
    expect(screen.getByTestId('dispatcher-lead-status').textContent).toBe('Each computer uses its own Dispatcher.');
    fireEvent.change(select, { target: { value: 'laptop' } });
    await waitFor(() => expect(window.clubhouse.dispatcher.setLead).toHaveBeenCalledWith('laptop'));
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(window.clubhouse.dispatcher.setLead).toHaveBeenCalledWith(null));
  });

  it('follows changes from other computers, with who has the choice', async () => {
    render(<LeadSection />);
    await screen.findByTestId('dispatcher-lead');
    act(() => changed?.(FOLLOWING));
    expect((screen.getByTestId('dispatcher-lead') as HTMLSelectElement).value).toBe('laptop');
    expect(screen.getByTestId('dispatcher-lead-status').textContent).toBe('This computer follows Laptop’s Dispatcher.');
    expect(screen.getByTestId('dispatcher-lead-confirmation').textContent).toBe('Laptop has this choice. Waiting for Studio.');
  });

  it('shows why a save failed and keeps the saved choice', async () => {
    window.clubhouse.dispatcher.setLead = vi.fn(async () => { throw new Error('That computer isn’t in this Annex Network.'); });
    render(<LeadSection />);
    fireEvent.change(await screen.findByTestId('dispatcher-lead'), { target: { value: 'studio' } });
    expect((await screen.findByTestId('dispatcher-lead-error')).textContent).toContain('Couldn’t change the lead.');
  });

  it('offers Follow again on a computer that took back', async () => {
    window.clubhouse.dispatcher.getLead = vi.fn(async () => ({ ...FOLLOWING, following: false, tookBack: true }));
    window.clubhouse.dispatcher.followAgain = vi.fn(async () => FOLLOWING);
    render(<LeadSection />);
    expect((await screen.findByTestId('dispatcher-lead-status')).textContent).toBe('Laptop leads, but this computer took back and uses its own Dispatcher.');
    fireEvent.click(screen.getByTestId('dispatcher-lead-follow-again'));
    await waitFor(() => expect(window.clubhouse.dispatcher.followAgain).toHaveBeenCalled());
  });

  it('after the only other computer left, still says who left, with nothing to choose', async () => {
    window.clubhouse.dispatcher.getLead = vi.fn(async () => ({ ...PEERS, canChoose: false, choices: [PEERS.choices[0]], clearedFor: 'Laptop' }));
    render(<LeadSection />);
    expect((await screen.findByTestId('dispatcher-lead-status')).textContent).toBe('Laptop left the network, so there’s no lead now. Each computer uses its own Dispatcher.');
    expect((screen.getByTestId('dispatcher-lead') as HTMLSelectElement).disabled).toBe(true);
  });

  it('warns when the lead’s Dispatcher is off', () => {
    expect(leadOffWarning({ ...FOLLOWING, lead: PEERS.choices[2] })).toBe('Studio’s Dispatcher is off. The other computers show its chat once it’s on there.');
    expect(leadOffWarning({ ...FOLLOWING, lead: { ...PEERS.choices[0], dispatcherOn: false } })).toContain('This computer’s Dispatcher is off.');
    expect(leadOffWarning(FOLLOWING)).toBeNull();
  });

  it('words each state plainly', () => {
    expect(listNames(['A', 'B', 'C'])).toBe('A, B and C');
    expect(leadStatus({ ...PEERS, role: 'lead', lead: PEERS.choices[0] })).toBe('This computer’s Dispatcher leads. The others follow it.');
    expect(leadStatus({ ...PEERS, clearedFor: 'Studio' })).toBe('Studio left the network, so there’s no lead now. Each computer uses its own Dispatcher.');
    expect(leadConfirmation(PEERS)).toBeNull();
    expect(leadConfirmation({ ...FOLLOWING, confirmedBy: ['Laptop', 'Studio'], waitingOn: [] })).toBe('Every computer has this choice.');
    expect(leadConfirmation({ ...FOLLOWING, confirmedBy: [], waitingOn: ['Laptop', 'Studio'] })).toBe('Waiting for Laptop and Studio to get this choice.');
  });
});
