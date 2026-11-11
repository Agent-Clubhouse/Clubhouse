import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { grantRows, type AgentGrantsView, type GrantRow } from '../../../shared/agent-grant-changes';
import { defaultGrants } from '../../../shared/default-grants';
import { AgentGrantsSettings, groupGrantRows } from './AgentGrantsSettings';
import { useMcpBindingStore } from '../../stores/mcpBindingStore';
import { useAgentStore } from '../../stores/agentStore';
import { useAgentDetailsStore } from './details/detailsStore';

const PROJECT = path.join('/work', 'proj');
const agent = { id: 'lead', name: 'epic-lead' };

const row = (r: Partial<GrantRow> & Pick<GrantRow, 'action' | 'target'>): GrantRow => ({
  mode: 'allow', defaultMode: 'allow', source: 'every_agent', fixed: false, ...r,
});

/** Out of page order on purpose: the page sorts groups by target. */
function defaultsView(): AgentGrantsView {
  return {
    helper: true,
    dispatcher: false,
    orchestrates: true,
    rows: [
      row({ action: 'settings.app.read', target: { kind: 'app' } }),
      row({ action: 'agent.wake', target: { kind: 'my_helpers' }, source: 'structural' }),
      row({ action: 'agent.read', target: { kind: 'self' } }),
      row({ action: 'agent.message', target: { kind: 'parent' }, source: 'structural', fixed: true }),
      row({ action: 'project.read', target: { kind: 'project', project: 'own' } }),
      row({ action: 'agent.message', target: { kind: 'connected' } }),
      row({ action: 'agent.sleep', target: { kind: 'my_helpers' }, source: 'structural' }),
    ],
  };
}

function withChange(view: AgentGrantsView, action: string, mode: GrantRow['mode']): AgentGrantsView {
  return {
    ...view,
    rows: view.rows.map((r) => (r.action === action ? { ...r, mode, source: r.mode === mode ? r.source : 'user' } : r)),
  };
}

function radios(name: string) {
  return within(screen.getByRole('radiogroup', { name }));
}

beforeEach(() => {
  useMcpBindingStore.setState({ bindings: [] });
  useAgentDetailsStore.setState({ open: false, focus: null });
  useAgentStore.setState({
    agents: { lead: { ...agent, projectId: 'p1', kind: 'durable', status: 'sleeping', color: 'teal' } },
    agentSettingsOpenFor: 'lead',
  });
  window.clubhouse.agent.getGrants = vi.fn(async () => defaultsView());
  window.clubhouse.agent.getGrantTools = vi.fn(async () => ({ 'agent.message': ['send_file', 'send_message', 'wake_agent'] }));
  window.clubhouse.agent.setGrant = vi.fn(async () => defaultsView());
  window.clubhouse.agent.resetGrants = vi.fn(async () => defaultsView());
});

describe('Clubhouse permissions page (#2971)', () => {
  it.each([0, 1, 3])('explains a non-orchestrating template with %i outgoing connections (#3275)', async (count) => {
    const traits = { helper: false, dispatcher: false, orchestrates: false, crossProject: false };
    window.clubhouse.agent.getGrants = vi.fn(async () => ({
      ...traits, rows: grantRows(defaultGrants(traits), undefined),
    }));
    useMcpBindingStore.setState({ bindings: [
      ...Array.from({ length: count }, (_, i) => ({ agentId: 'lead', targetId: `other-${i}`, targetKind: 'agent' as const, label: `Other ${i}` })),
      { agentId: 'incoming', targetId: 'lead', targetKind: 'agent', label: 'epic-lead' },
      { agentId: 'lead', targetId: 'browser', targetKind: 'browser', label: 'Browser' },
    ] });
    render(<AgentGrantsSettings agent={agent} projectPath={PROJECT} />);
    const groups = await screen.findAllByTestId('agent-connection-summary');
    for (const summary of groups) {
      expect(summary).toHaveTextContent(`${count} outgoing ${count === 1 ? 'connection.' : 'connections.'}`);
      expect(summary).toHaveTextContent("the tool's per-direction switch");
      if (count === 0) expect(summary).toHaveTextContent('These grants currently reach no agents');
      else expect(summary).not.toHaveTextContent('These grants currently reach no agents');
    }
    fireEvent.click(within(groups[0]).getByRole('button', { name: 'Edit connections' }));
    expect(useAgentDetailsStore.getState().focus).toMatchObject({ agentId: 'lead', card: 'connections' });
    expect(useAgentDetailsStore.getState().open).toBe(true);
    expect(useAgentStore.getState().agentSettingsOpenFor).toBeNull();
  });

  it('updates the connection count when the live bindings change (#3275)', async () => {
    render(<AgentGrantsSettings agent={agent} projectPath={PROJECT} />);
    const summary = await screen.findByTestId('agent-connection-summary');
    expect(summary).toHaveTextContent('0 outgoing connections.');
    act(() => useMcpBindingStore.setState({ bindings: [{ agentId: 'lead', targetId: 'other', targetKind: 'agent', label: 'Other' }] }));
    expect(summary).toHaveTextContent('1 outgoing connection.');
    expect(summary).not.toHaveTextContent('currently reach no agents');
  });

  it('reveals only the tools mapped to that row, without changing its grant (#3275)', async () => {
    render(<AgentGrantsSettings agent={agent} projectPath={PROJECT} />);
    const grant = await screen.findByTestId('agent-grant-row-agent.message@connected');
    const disclosure = grant.querySelector('details')!;
    expect(disclosure).not.toHaveAttribute('open');
    fireEvent.click(within(grant).getByText('MCP tools'));
    expect(disclosure).toHaveAttribute('open');
    expect([...disclosure.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['send_file', 'send_message', 'wake_agent']);
    expect(disclosure).not.toHaveTextContent('clear_agent');
    expect(window.clubhouse.agent.setGrant).not.toHaveBeenCalled();
  });

  it('groups rows by target in page order, with where each comes from', async () => {
    render(<AgentGrantsSettings agent={agent} projectPath={PROJECT} />);
    await screen.findByRole('radiogroup', { name: 'Wake (Its helpers)' });
    expect(window.clubhouse.agent.getGrants).toHaveBeenCalledWith(PROJECT, 'lead');
    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(headings).toEqual(['Itself', 'Its orchestrator', 'Its helpers', 'Connected agents', 'Its project', 'The app']);
    const helpers = within(screen.getByRole('region', { name: 'Its helpers' }));
    expect(helpers.getByText('Wake')).toBeInTheDocument();
    expect(helpers.getByText('Put to sleep')).toBeInTheDocument();
    expect(helpers.getAllByText('Built in')).toHaveLength(2);
    expect(within(screen.getByRole('region', { name: 'Itself' })).getByText('Default for all agents')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Connected agents' })).getByText('Default for all agents')).toBeInTheDocument();
    expect(screen.queryByText('Every agent')).not.toBeInTheDocument();
    expect(radios('See status, output and settings (Itself)').getByRole('radio', { name: 'Allow' })).toBeChecked();
    // Nothing differs from its default yet.
    expect(screen.queryByRole('button', { name: 'Reset to defaults' })).not.toBeInTheDocument();
  });

  it('sorts groups the same way without rendering', () => {
    expect(groupGrantRows(defaultsView().rows).map((g) => g.label)).toEqual(
      ['Itself', 'Its orchestrator', 'Its helpers', 'Connected agents', 'Its project', 'The app'],
    );
  });

  it('sets one action on one target and shows the view main hands back', async () => {
    const saved = withChange(defaultsView(), 'agent.wake', 'ask');
    window.clubhouse.agent.setGrant = vi.fn(async () => saved);
    render(<AgentGrantsSettings agent={agent} projectPath={PROJECT} />);
    const group = await screen.findByRole('radiogroup', { name: 'Wake (Its helpers)' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Ask first' }));
    expect(window.clubhouse.agent.setGrant).toHaveBeenCalledWith(PROJECT, 'lead', { action: 'agent.wake', target: { kind: 'my_helpers' }, mode: 'ask' });
    await waitFor(() => expect(within(screen.getByTestId('agent-grant-row-agent.wake@my_helpers')).getByText('Set by you')).toBeInTheDocument());
    expect(within(group).getByRole('radio', { name: 'Ask first' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Reset to defaults' })).toBeInTheDocument();
  });

  it('shows fixed rows disabled and always on', async () => {
    render(<AgentGrantsSettings agent={agent} projectPath={PROJECT} />);
    const fixed = await screen.findByRole('radiogroup', { name: 'Send messages and files (Its orchestrator)' });
    for (const radio of within(fixed).getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(within(fixed).getByRole('radio', { name: 'Allow' })).toBeChecked();
    expect(within(screen.getByTestId('agent-grant-row-agent.message@parent')).getByText('Always on')).toBeInTheDocument();
    expect(radios('Send messages and files (Connected agents)').getByRole('radio', { name: 'Off' })).toBeEnabled();
  });

  it('disables a row a wider row allows, and names that row', async () => {
    window.clubhouse.agent.getGrants = vi.fn(async () => ({
      ...defaultsView(),
      rows: [
        row({ action: 'agent.create', target: { kind: 'project', project: 'own' }, source: 'structural', coveredBy: 'agent.create@project:any' }),
        row({ action: 'agent.create', target: { kind: 'project', project: 'any' }, source: 'structural' }),
      ],
    }));
    render(<AgentGrantsSettings agent={agent} projectPath={PROJECT} />);
    const covered = await screen.findByRole('radiogroup', { name: 'Create agents (Its project)' });
    for (const radio of within(covered).getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.getByText('Allowed by Every project. Change it there.')).toBeInTheDocument();
    expect(radios('Create agents (Every project)').getByRole('radio', { name: 'Off' })).toBeEnabled();
  });

  it('offers Reset to defaults only with a change, and resets without asking', async () => {
    window.clubhouse.agent.getGrants = vi.fn(async () => withChange(defaultsView(), 'settings.app.read', 'off'));
    render(<AgentGrantsSettings agent={agent} projectPath={PROJECT} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset to defaults' }));
    expect(window.clubhouse.agent.resetGrants).toHaveBeenCalledWith(PROJECT, 'lead');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reset to defaults' })).not.toBeInTheDocument());
    expect(radios('See app settings (The app)').getByRole('radio', { name: 'Allow' })).toBeChecked();
  });

  it('puts a row back to its saved value and says so when the change fails', async () => {
    window.clubhouse.agent.setGrant = vi.fn(async () => { throw new Error('disk full'); });
    render(<AgentGrantsSettings agent={agent} projectPath={PROJECT} />);
    const group = await screen.findByRole('radiogroup', { name: 'See app settings (The app)' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Off' }));
    expect(within(group).getByRole('radio', { name: 'Off' })).toBeChecked();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that change, so it wasn't changed. Try again.");
    expect(within(screen.getByTestId('agent-grant-row-settings.app.read@app')).getByRole('alert')).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: 'Allow' })).toBeChecked();
  });

  it('says so when a reset fails', async () => {
    window.clubhouse.agent.getGrants = vi.fn(async () => withChange(defaultsView(), 'settings.app.read', 'off'));
    window.clubhouse.agent.resetGrants = vi.fn(async () => { throw new Error('nope'); });
    render(<AgentGrantsSettings agent={agent} projectPath={PROJECT} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset to defaults' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reset to defaults, so nothing changed. Try again.");
    expect(radios('See app settings (The app)').getByRole('radio', { name: 'Off' })).toBeChecked();
  });

  it('shows plain loading, empty and failed reads', async () => {
    let resolve!: (v: AgentGrantsView) => void;
    window.clubhouse.agent.getGrants = vi.fn(() => new Promise<AgentGrantsView>((r) => { resolve = r; }));
    const { unmount } = render(<AgentGrantsSettings agent={agent} projectPath={PROJECT} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    resolve({ rows: [], helper: false, dispatcher: false, orchestrates: false });
    expect(await screen.findByText('epic-lead has no Clubhouse permissions to show.')).toBeInTheDocument();
    unmount();

    window.clubhouse.agent.getGrants = vi.fn()
      .mockRejectedValueOnce(new Error('gone'))
      .mockResolvedValueOnce(defaultsView());
    render(<AgentGrantsSettings agent={agent} projectPath={PROJECT} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't read epic-lead's Clubhouse permissions.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('radiogroup', { name: 'Wake (Its helpers)' })).toBeInTheDocument();
  });
});
