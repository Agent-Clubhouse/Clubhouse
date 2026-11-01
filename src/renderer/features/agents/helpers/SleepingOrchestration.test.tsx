import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent, DurableAgentConfig, HelperStartRequest } from '../../../../shared/types';
import type { OrchestrationPolicy, ResolvedOrchestrationPolicy } from '../../../../shared/orchestration-policy';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useHelperStartRequestStore } from '../../../stores/helperStartRequestStore';
import { useAgentDetailsStore } from '../details/detailsStore';
import { SleepingAgent } from '../SleepingAgent';

vi.mock('../SleepingMascots', () => ({ SleepingMascot: () => <div data-testid="sleeping-mascot" /> }));

const PROJECT = path.join('/work', 'proj');

const lead: Agent = { id: 'lead', projectId: 'p1', name: 'epic-lead', kind: 'durable', status: 'sleeping', color: 'teal' };
const plain: Agent = { id: 'plain', projectId: 'p1', name: 'buddy', kind: 'durable', status: 'sleeping', color: 'teal' };

function resolved(p: OrchestrationPolicy): ResolvedOrchestrationPolicy {
  return { ...p, sources: { orchestrate: 'agent', access: 'default', control: 'default', maxHelpers: 'default' } };
}

const request: HelperStartRequest = {
  requestId: 'hstart_a',
  orchestratorId: 'lead',
  orchestratorName: 'epic-lead',
  projectPath: PROJECT,
  args: { name: 'impl-api', task: 'Build the API' },
  createdAt: '2026-10-18T10:00:00Z',
} as HelperStartRequest;

let policies: Record<string, OrchestrationPolicy>;
let configs: DurableAgentConfig[];

beforeEach(() => {
  policies = {
    lead: { orchestrate: true, access: 'same', control: 'ask-before-start', maxHelpers: 5 },
    plain: { orchestrate: false, access: 'same', control: 'hands-off', maxHelpers: 5 },
  };
  configs = [
    { id: 'lead', name: 'epic-lead', color: 'teal', createdAt: '2026-10-18T09:00:00Z' },
    { id: 'plain', name: 'buddy', color: 'teal', createdAt: '2026-10-18T09:00:00Z' },
  ];
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: PROJECT }], activeProjectId: 'p1' } as never);
  useAgentStore.setState({ agents: { lead, plain }, agentIcons: {}, sessionNamePromptFor: null } as never);
  useAgentDetailsStore.setState({ open: false, focus: null });
  window.clubhouse.agent.listDurable = vi.fn(async () => configs) as never;
  window.clubhouse.agent.getSessionSummary = vi.fn(async () => null) as never;
  window.clubhouse.agent.getOrchestrationPolicy = vi.fn(async (_p: string, id: string) => resolved(policies[id])) as never;
  window.clubhouse.agent.resolveHelperAccess = vi.fn(async () => ({ freeAgentMode: false, permissionMode: 'default' as const, level: 'standard' as const, ceiling: 'standard' as const, clamped: false })) as never;
  window.clubhouse.app.getOrchestrationSettings = vi.fn(async () => ({ globalHelperCap: 8 }));
  window.clubhouse.agent.approveHelperStart = vi.fn(async () => ({ ok: true, message: 'Starting' }));
  window.clubhouse.agent.declineHelperStart = vi.fn(async () => ({ ok: true, message: 'Declined' }));
});

afterEach(() => {
  useHelperStartRequestStore.setState({ requests: {} });
  useAgentStore.setState({ agents: {} } as never);
  useProjectStore.setState({ projects: [] });
});

describe('Sleeping orchestrator view (#2232)', () => {
  it('shows the Orchestration card with the next-start note and the Helpers card', async () => {
    render(<SleepingAgent agent={lead} />);
    const section = await screen.findByTestId('sleeping-orchestration');
    expect(within(section).getByTestId('details-card-helpers')).toBeInTheDocument();
    fireEvent.click(within(section).getByTestId('details-card-orchestrate-toggle'));
    expect(within(section).getByTestId('orchestrate-note')).toHaveTextContent('The helper tools appear the next time epic-lead starts.');
  });

  it('shows a waiting start with Approve off, "Wake epic-lead to approve", and a working Decline', async () => {
    useHelperStartRequestStore.setState({ requests: { [request.requestId]: request } });
    render(<SleepingAgent agent={lead} />);
    // A waiting start opens the Helpers card by itself.
    const row = await screen.findByTestId('helper-request-hstart_a');
    expect(within(row).getByTestId('helper-approve')).toBeDisabled();
    expect(within(row).getByTestId('helper-approve-blocked')).toHaveTextContent('Wake epic-lead to approve');
    fireEvent.click(within(row).getByTestId('helper-decline'));
    await waitFor(() => expect(window.clubhouse.agent.declineHelperStart).toHaveBeenCalledWith(PROJECT, 'hstart_a'));
    expect(window.clubhouse.agent.approveHelperStart).not.toHaveBeenCalled();
  });

  it('opens the Helpers card when Needs you reveals it', async () => {
    render(<SleepingAgent agent={lead} />);
    const card = await screen.findByTestId('details-card-helpers');
    expect(card).not.toHaveAttribute('data-open');
    act(() => useAgentDetailsStore.getState().reveal({ agentId: 'lead', card: 'helpers' }));
    await waitFor(() => expect(screen.getByTestId('details-card-helpers')).toHaveAttribute('data-open', 'true'));
  });

  it('adds nothing for an agent that doesn’t orchestrate', async () => {
    render(<SleepingAgent agent={plain} />);
    await screen.findByTestId('wake-composer');
    await waitFor(() => expect(window.clubhouse.agent.getOrchestrationPolicy).toHaveBeenCalled());
    expect(screen.queryByTestId('sleeping-orchestration')).not.toBeInTheDocument();
  });
});
