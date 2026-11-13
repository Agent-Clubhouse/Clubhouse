import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DispatcherLeadState } from '../../../shared/dispatcher-lead';
import { LeadSection, leadConfirmation, leadStatus, listNames } from './DispatcherLeadSection';

const PEERS: DispatcherLeadState = {
  available: true, role: 'peer', lead: null,
  choices: [
    { machine: 'desk', name: 'Desk', self: true, online: true },
    { machine: 'laptop', name: 'Laptop', self: false, online: true },
    { machine: 'studio', name: 'Studio', self: false, online: false },
  ],
  confirmedBy: [], waitingOn: [], clearedFor: null, changedByName: null, changedAt: null,
};
const FOLLOWING: DispatcherLeadState = {
  ...PEERS, role: 'follower', lead: PEERS.choices[1], confirmedBy: ['Laptop'], waitingOn: ['Studio'],
  changedByName: 'Desk', changedAt: '2026-11-13T10:00:00.000Z',
};

let changed: ((state: DispatcherLeadState) => void) | undefined;
beforeEach(() => {
  changed = undefined;
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
    expect([...select.options].map((o) => o.textContent)).toEqual(['None', 'Desk (this computer)', 'Laptop', 'Studio (offline)']);
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

  it('words each state plainly', () => {
    expect(listNames(['A', 'B', 'C'])).toBe('A, B and C');
    expect(leadStatus({ ...PEERS, role: 'lead', lead: PEERS.choices[0] })).toBe('This computer’s Dispatcher leads. The others follow it.');
    expect(leadStatus({ ...PEERS, clearedFor: 'Studio' })).toBe('Studio left the network, so there’s no lead now. Each computer uses its own Dispatcher.');
    expect(leadConfirmation(PEERS)).toBeNull();
    expect(leadConfirmation({ ...FOLLOWING, confirmedBy: ['Laptop', 'Studio'], waitingOn: [] })).toBe('Every computer has this choice.');
    expect(leadConfirmation({ ...FOLLOWING, confirmedBy: [], waitingOn: ['Laptop', 'Studio'] })).toBe('Waiting for Laptop and Studio to get this choice.');
  });
});
