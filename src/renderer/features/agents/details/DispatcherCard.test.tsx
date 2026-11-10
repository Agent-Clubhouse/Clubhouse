import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { GrantAction, GrantTarget } from '../../../../shared/agent-grants';
import type { AgentGrantsView, GrantChangeMode, GrantRow } from '../../../../shared/agent-grant-changes';
import type { AgentCardView } from '../../../../shared/dispatcher-agent-card';
import { DISPATCHER_OFF } from '../../../../shared/dispatcher-types';
import type { OrchestrationPolicyPatch, ResolvedOrchestrationPolicy } from '../../../../shared/orchestration-policy';
import { ToastContainer } from '../../../components/ToastContainer';
import { useToastStore } from '../../../stores/toastStore';
import { useDispatcherStore } from '../../dispatcher/dispatcherStore';
import { ASKING_TEXT, DispatcherCard, TURNING_ON_MS, cardStatus, cardSummary, dispatcherName } from './DispatcherCard';
import { reachRows, reachSummary } from './dispatcher-card-model';

const lead = { id: 'lead', name: 'epic-lead' };
const DISPATCHER_PATH = '/home/me/.clubhouse/dispatcher';

function policy(connectToDispatcher: boolean): ResolvedOrchestrationPolicy {
  return {
    orchestrate: false, access: 'same', control: 'hands-off', maxHelpers: 5, crossProjectHelpers: false, connectToDispatcher,
    sources: { orchestrate: 'default', access: 'default', control: 'default', maxHelpers: 'default', crossProjectHelpers: 'default', connectToDispatcher: 'agent' },
  };
}

function row(action: GrantAction, target: GrantTarget, mode: GrantChangeMode = 'allow'): GrantRow {
  return { action, target, mode, defaultMode: mode, source: 'structural', fixed: false };
}

const CONNECTED: GrantTarget = { kind: 'connected' };
const ANY: GrantTarget = { kind: 'any' };

/** Close to the Dispatcher's defaults: broad on connected agents, a few on every agent. */
function grantsView(overrides: GrantRow[] = []): AgentGrantsView {
  const rows = [
    row('agent.read', CONNECTED), row('agent.message', CONNECTED), row('agent.wake', CONNECTED), row('agent.sleep', CONNECTED),
    row('agent.reset', CONNECTED), row('agent.display', CONNECTED), row('agent.configure', CONNECTED), row('connection.manage', CONNECTED),
    row('agent.read', ANY), row('agent.display', ANY), row('agent.grant', ANY), row('agent.restart', ANY),
    row('agent.wake', { kind: 'connected', onlyDispatcher: true }),
  ];
  for (const o of overrides) {
    const i = rows.findIndex((r) => r.action === o.action && JSON.stringify(r.target) === JSON.stringify(o.target));
    if (i >= 0) rows[i] = o; else rows.push(o);
  }
  return { rows, helper: false, dispatcher: true, orchestrates: false };
}

let card: AgentCardView | null;
let cardListeners: Array<(id: string) => void>;
let setPolicy: ReturnType<typeof vi.fn>;

function Harness({ initial = true, saveOk = true }: { initial?: boolean; saveOk?: boolean }) {
  const [p, setP] = useState(policy(initial));
  const [open, setOpen] = useState(true);
  setPolicy.mockImplementation(async (patch: OrchestrationPolicyPatch) => {
    if (!saveOk) return false;
    setP((cur) => ({ ...cur, connectToDispatcher: !!patch.connectToDispatcher }));
    return true;
  });
  return (
    <>
      <DispatcherCard agent={lead} orch={{ policy: p, saving: false, setPolicy }} open={open} onToggle={() => setOpen((o) => !o)} />
      <ToastContainer />
    </>
  );
}

function emitCardChanged(id = 'lead') {
  act(() => { for (const l of cardListeners) l(id); });
}

beforeEach(() => {
  card = { state: 'ready', card: { purpose: 'Runs the web app epic', contactWhen: 'Anything about checkout', owns: 'webapp repo' } };
  cardListeners = [];
  setPolicy = vi.fn();
  useToastStore.setState({ toasts: [] });
  useDispatcherStore.setState({
    state: {
      ...DISPATCHER_OFF, enabled: true, savedOn: true, offReason: null, agentId: 'disp', path: DISPATCHER_PATH,
      config: { id: 'disp', name: 'Rosie', color: 'teal', createdAt: '2026-11-08T00:00:00Z' },
      chatAgentId: 'disp-chat', chatPath: `${DISPATCHER_PATH}-chat`,
    },
  });
  window.clubhouse.dispatcher.getAgentCard = vi.fn(async () => card);
  window.clubhouse.dispatcher.saveAgentCard = vi.fn(async (_id: string, fields) => {
    card = { state: 'ready', card: { ...card?.card, ...fields } };
    return card;
  });
  window.clubhouse.dispatcher.onAgentCardChanged = vi.fn((cb: (id: string) => void) => {
    cardListeners.push(cb);
    return () => { cardListeners = cardListeners.filter((l) => l !== cb); };
  });
  window.clubhouse.agent.getGrants = vi.fn(async () => grantsView());
  window.clubhouse.agent.setGrant = vi.fn(async (_p: string, _id: string, change) => grantsView([row(change.action, change.target, change.mode)]));
});

afterEach(() => {
  vi.useRealTimers();
  useDispatcherStore.setState({ state: null, project: null });
});

describe('the Dispatcher card (#3049)', () => {
  it('is titled with the Dispatcher\'s name, falling back to its working name', () => {
    expect(dispatcherName({ config: { id: 'd', name: '  Rosie ', color: 'teal', createdAt: '' } })).toBe('Rosie');
    expect(dispatcherName({ config: null })).toBe('Dispatcher');
    expect(dispatcherName(null)).toBe('Dispatcher');
  });

  it('Off: the header says not connected, and no card or permissions are read', async () => {
    render(<Harness initial={false} />);
    expect(screen.getByRole('region', { name: 'Rosie' })).toBeInTheDocument();
    expect(screen.getByTestId('details-card-dispatcher-summary')).toHaveTextContent('not connected');
    expect(screen.getByTestId('dispatcher-card-switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('dispatcher-card-switch')).toHaveAccessibleName('Connect epic-lead to Rosie');
    expect(screen.getByText('Turn this on so Rosie can message epic-lead and get its reports.')).toBeInTheDocument();
    expect(screen.queryByTestId('dispatcher-card-edit')).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(window.clubhouse.dispatcher.getAgentCard).not.toHaveBeenCalled();
    expect(window.clubhouse.agent.getGrants).not.toHaveBeenCalled();
  });

  it('On: When to reach it, Owns, what it can do here, with Edit and Permissions', async () => {
    render(<Harness />);
    expect(await screen.findByTestId('dispatcher-card-contact')).toHaveTextContent('Anything about checkout');
    expect(screen.getByTestId('dispatcher-card-owns')).toHaveTextContent('webapp repo');
    // The Dispatcher's name, not the agent's card text (#3249).
    expect(screen.getByTestId('details-card-dispatcher-summary')).toHaveTextContent('Rosie, your dispatcher');
    expect(screen.getByTestId('details-card-dispatcher-summary')).not.toHaveTextContent('Runs the web app epic');
    await waitFor(() => expect(screen.getByTestId('dispatcher-card-reach')).toHaveTextContent('Rosie canMessage it, wake it, put it to sleep and 7 more.'));
    expect(window.clubhouse.agent.getGrants).toHaveBeenCalledWith(DISPATCHER_PATH, 'disp');
    expect(window.clubhouse.dispatcher.getAgentCard).toHaveBeenCalledWith('lead');
    expect(screen.getByTestId('dispatcher-card-edit')).toBeInTheDocument();
    expect(screen.getByTestId('dispatcher-card-permissions')).toBeInTheDocument();
  });

  it('Turning on: "Asking what it does…" until the agent answers, then the fields fill in', async () => {
    card = null;
    render(<Harness initial={false} />);
    fireEvent.click(screen.getByTestId('dispatcher-card-switch'));
    await waitFor(() => expect(setPolicy).toHaveBeenCalledWith({ connectToDispatcher: true }));
    expect(await screen.findByTestId('dispatcher-card-asking')).toHaveTextContent(ASKING_TEXT);
    expect(screen.getByTestId('details-card-dispatcher-summary')).toHaveTextContent(ASKING_TEXT);
    // Main asked it: still asking.
    card = { state: 'asking', card: null };
    emitCardChanged();
    await waitFor(() => expect(window.clubhouse.dispatcher.getAgentCard).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('dispatcher-card-asking')).toBeInTheDocument();
    // It answered.
    card = { state: 'ready', card: { contactWhen: 'Release questions', owns: 'release branch' } };
    emitCardChanged();
    expect(await screen.findByTestId('dispatcher-card-contact')).toHaveTextContent('Release questions');
    expect(screen.queryByTestId('dispatcher-card-asking')).not.toBeInTheDocument();
    expect(screen.getByTestId('details-card-dispatcher-summary')).toHaveTextContent('Rosie, your dispatcher');
  });

  it('No answer: "No description yet" with Edit, and says when an asleep agent is asked', async () => {
    card = { state: 'none', card: null, waitingToAsk: true };
    render(<Harness />);
    expect(await screen.findByTestId('dispatcher-card-none')).toHaveTextContent('No description yet. epic-lead is asked the next time it runs.');
    expect(screen.getByTestId('details-card-dispatcher-summary')).toHaveTextContent('No description yet');
    expect(screen.getByTestId('dispatcher-card-edit')).toBeInTheDocument();
  });

  it('Turning on with nothing coming back falls to "No description yet" after a while', async () => {
    card = null;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness initial={false} />);
    fireEvent.click(screen.getByTestId('dispatcher-card-switch'));
    // "Asking" shows while the card loads too, before the switch's save returns and the
    // turning-on wait starts. Advancing time then fires nothing (#3163). The wait has
    // started once its card-changed listener joins the card read's: two listeners.
    await waitFor(() => expect(cardListeners).toHaveLength(2));
    await waitFor(() => expect(window.clubhouse.dispatcher.getAgentCard).toHaveBeenCalledTimes(1));
    // Well inside the wait, with the card read back empty: still asking.
    await act(async () => { vi.advanceTimersByTime(TURNING_ON_MS / 2); });
    expect(screen.getByTestId('dispatcher-card-asking')).toBeInTheDocument();
    // Past it: no description yet.
    await act(async () => { vi.advanceTimersByTime(TURNING_ON_MS / 2 + 10); });
    expect(await screen.findByTestId('dispatcher-card-none')).toHaveTextContent('No description yet.');
  });

  it('Edit: both fields in place, Save replaces the card, Cancel keeps it', async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByTestId('dispatcher-card-edit'));
    const editor = screen.getByTestId('dispatcher-card-editor');
    expect(within(editor).getByText('Saving replaces what epic-lead wrote.')).toBeInTheDocument();
    const contact = screen.getByTestId('dispatcher-card-edit-contact');
    expect(contact).toHaveValue('Anything about checkout');
    expect(screen.getByTestId('dispatcher-card-edit-owns')).toHaveValue('webapp repo');

    // Cancel leaves it as it was.
    fireEvent.change(contact, { target: { value: 'changed my mind' } });
    fireEvent.click(screen.getByTestId('dispatcher-card-cancel'));
    expect(screen.getByTestId('dispatcher-card-contact')).toHaveTextContent('Anything about checkout');
    expect(window.clubhouse.dispatcher.saveAgentCard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('dispatcher-card-edit'));
    fireEvent.change(screen.getByTestId('dispatcher-card-edit-contact'), { target: { value: 'Payments and checkout' } });
    fireEvent.change(screen.getByTestId('dispatcher-card-edit-owns'), { target: { value: 'webapp and payments' } });
    fireEvent.click(screen.getByTestId('dispatcher-card-save'));
    await waitFor(() => expect(screen.getByTestId('dispatcher-card-contact')).toHaveTextContent('Payments and checkout'));
    expect(screen.getByTestId('dispatcher-card-owns')).toHaveTextContent('webapp and payments');
    expect(window.clubhouse.dispatcher.saveAgentCard).toHaveBeenCalledWith('lead', { contactWhen: 'Payments and checkout', owns: 'webapp and payments' });
    expect(screen.queryByTestId('dispatcher-card-editor')).not.toBeInTheDocument();
  });

  it('Edit from "No description yet", and a failed save keeps the draft and says so', async () => {
    card = { state: 'none', card: null };
    window.clubhouse.dispatcher.saveAgentCard = vi.fn(async () => { throw new Error('disk full'); });
    render(<Harness />);
    fireEvent.click(await screen.findByTestId('dispatcher-card-edit'));
    expect(screen.getByTestId('dispatcher-card-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('dispatcher-card-edit-owns'), { target: { value: 'docs site' } });
    fireEvent.click(screen.getByTestId('dispatcher-card-save'));
    expect(await screen.findByTestId('dispatcher-card-edit-error')).toHaveTextContent('Couldn’t save. Try again.');
    expect(screen.getByTestId('dispatcher-card-edit-owns')).toHaveValue('docs site');
  });

  it('Permissions: a popover of what reaches this agent, changed on the connected row, with a link to all of them', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('dispatcher-card-reach')).toHaveTextContent('7 more'));
    fireEvent.click(screen.getByTestId('dispatcher-card-permissions'));
    const popover = await screen.findByTestId('dispatcher-card-permissions-popover');
    expect(popover).toHaveTextContent('What Rosie can do to epic-lead');
    expect(popover).toHaveTextContent('These apply to every agent connected to Rosie.');

    // A row set on connected agents changes here.
    const sleep = within(screen.getByTestId('dispatcher-card-permission-agent.sleep'));
    expect(sleep.getByRole('radio', { name: 'Allow' })).toBeChecked();
    fireEvent.click(sleep.getByRole('radio', { name: 'Ask' }));
    await waitFor(() => expect(window.clubhouse.agent.setGrant).toHaveBeenCalledWith(DISPATCHER_PATH, 'disp', { action: 'agent.sleep', target: { kind: 'connected' }, mode: 'ask' }));
    await waitFor(() => expect(sleep.getByRole('radio', { name: 'Ask' })).toBeChecked());
    expect(screen.getByTestId('dispatcher-card-reach')).toHaveTextContent('Asks you first to put it to sleep.');

    // A row set on every agent can't narrow from one agent's card.
    const restart = within(screen.getByTestId('dispatcher-card-permission-agent.restart'));
    expect(restart.getByRole('radio', { name: 'Allow' })).toBeChecked();
    expect(restart.getByRole('radio', { name: 'Off' })).toBeDisabled();
    expect(restart.getByText('Set for every agent. Change it in all permissions.')).toBeInTheDocument();

    // Escape closes it.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('dispatcher-card-permissions-popover')).not.toBeInTheDocument();

    // All Clubhouse permissions opens the full list for the Dispatcher.
    fireEvent.click(screen.getByTestId('dispatcher-card-permissions'));
    fireEvent.click(await screen.findByTestId('dispatcher-card-all-permissions-link'));
    expect(screen.queryByTestId('dispatcher-card-permissions-popover')).not.toBeInTheDocument();
    const modal = await screen.findByTestId('dispatcher-card-all-permissions');
    expect(modal).toHaveTextContent('Rosie’s Clubhouse permissions');
    expect(await within(modal).findByTestId('agent-grants-settings')).toBeInTheDocument();
  });

  it('a failed permission change says so and leaves the row as it was', async () => {
    window.clubhouse.agent.setGrant = vi.fn(async () => { throw new Error('nope'); });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('dispatcher-card-reach')).toHaveTextContent('7 more'));
    fireEvent.click(screen.getByTestId('dispatcher-card-permissions'));
    const wake = within(await screen.findByTestId('dispatcher-card-permission-agent.wake'));
    fireEvent.click(wake.getByRole('radio', { name: 'Off' }));
    expect(await screen.findByText('Couldn’t save that change, so it wasn’t changed. Try again.')).toBeInTheDocument();
    expect(wake.getByRole('radio', { name: 'Allow' })).toBeChecked();
  });

  it('Turned off: takes effect at once, with Undo in a toast, and the description is kept for turning back on', async () => {
    render(<Harness />);
    await screen.findByTestId('dispatcher-card-contact');
    fireEvent.click(screen.getByTestId('dispatcher-card-switch'));
    await waitFor(() => expect(screen.getByTestId('dispatcher-card-switch')).toHaveAttribute('aria-checked', 'false'));
    expect(setPolicy).toHaveBeenLastCalledWith({ connectToDispatcher: false });
    expect(screen.getByTestId('details-card-dispatcher-summary')).toHaveTextContent('not connected');
    const toast = await screen.findByTestId('toast-message');
    expect(toast).toHaveTextContent('epic-lead is no longer connected to Rosie.');

    fireEvent.click(within(toast).getByTestId('toast-action'));
    await waitFor(() => expect(screen.getByTestId('dispatcher-card-switch')).toHaveAttribute('aria-checked', 'true'));
    expect(setPolicy).toHaveBeenLastCalledWith({ connectToDispatcher: true });
    expect(screen.queryByTestId('toast-message')).not.toBeInTheDocument();
    // The kept card is back at once: no asking.
    expect(await screen.findByTestId('dispatcher-card-contact')).toHaveTextContent('Anything about checkout');
    expect(screen.queryByTestId('dispatcher-card-asking')).not.toBeInTheDocument();
  });

  it('a switch change that doesn\'t save shows no toast and says so', async () => {
    render(<Harness saveOk={false} />);
    await screen.findByTestId('dispatcher-card-contact');
    fireEvent.click(screen.getByTestId('dispatcher-card-switch'));
    expect(await screen.findByTestId('dispatcher-card-error')).toHaveTextContent('Couldn’t save. Try again.');
    expect(screen.getByTestId('dispatcher-card-switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('toast-message')).not.toBeInTheDocument();
  });
});

describe('the card\'s words', () => {
  it('picks a state from the switch and the card', () => {
    expect(cardStatus(false, { state: 'ready', card: {} }, false)).toBe('off');
    expect(cardStatus(true, { state: 'ready', card: {} }, true)).toBe('ready');
    expect(cardStatus(true, { state: 'asking', card: null }, false)).toBe('asking');
    expect(cardStatus(true, null, true)).toBe('asking');
    expect(cardStatus(true, { state: 'none', card: null }, false)).toBe('none');
    expect(cardStatus(true, null, false)).toBe('none');
    expect(cardSummary('ready', 'Navi')).toBe('Navi, your dispatcher');
    expect(cardSummary('ready', 'Dispatcher')).toBe('connected');
    expect(cardSummary('off', 'Navi')).toBe('not connected');
  });

  it('summarizes what reaches the agent from the real rows', () => {
    expect(reachSummary(reachRows(grantsView()))).toBe('Message it, wake it, put it to sleep and 7 more.');
    const narrow = grantsView([
      row('agent.sleep', CONNECTED, 'ask'), row('agent.reset', CONNECTED, 'off'), row('agent.display', CONNECTED, 'off'),
      row('agent.configure', CONNECTED, 'off'), row('connection.manage', CONNECTED, 'off'), row('agent.grant', ANY, 'off'),
      row('agent.restart', ANY, 'ask'), row('agent.read', ANY, 'off'), row('agent.display', ANY, 'off'),
    ]);
    expect(reachSummary(reachRows(narrow))).toBe('Message it, wake it and see its status and output. Asks you first to put it to sleep and restart it.');
    const none = grantsView(grantsView().rows.map((r) => ({ ...r, mode: 'off' as const })));
    expect(reachSummary(reachRows(none))).toBe('Nothing on this agent.');
  });

  it('locks a row only when every agent has it at least as strongly', () => {
    const rows = reachRows(grantsView([row('agent.read', ANY, 'ask')]));
    const read = rows.find((r) => r.action === 'agent.read')!;
    expect(read).toMatchObject({ mode: 'allow', everyAgent: false });
    const restart = rows.find((r) => r.action === 'agent.restart')!;
    expect(restart).toMatchObject({ mode: 'allow', everyAgent: true });
    // The Dispatcher-only wake row never counts as reaching another agent.
    const wake = reachRows(grantsView([row('agent.wake', CONNECTED, 'off')])).find((r) => r.action === 'agent.wake')!;
    expect(wake.mode).toBe('off');
  });
});
