import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import type { OrchestrationPolicy, OrchestrationPolicyPatch, ResolvedOrchestrationPolicy } from '../../../../shared/orchestration-policy';
import { AgentHelpersSettings } from './AgentHelpersSettings';

const PROJECT = path.join('/work', 'proj');
const lead: Agent = { id: 'lead', projectId: 'p1', name: 'epic-lead', kind: 'durable', status: 'sleeping', color: 'teal' };

let stored: OrchestrationPolicy;
let helperIds: string[];

function resolved(p: OrchestrationPolicy): ResolvedOrchestrationPolicy {
  return { ...p, sources: { orchestrate: 'agent', access: 'default', control: 'default', maxHelpers: 'default' } };
}

beforeEach(() => {
  stored = { orchestrate: false, access: 'same', control: 'hands-off', maxHelpers: 5 };
  helperIds = [];
  window.clubhouse.agent.getOrchestrationPolicy = vi.fn(async () => resolved(stored));
  window.clubhouse.agent.listDurable = vi.fn(async () => []) as never;
  window.clubhouse.app.getOrchestrationSettings = vi.fn(async () => ({ globalHelperCap: 20 }));
  window.clubhouse.agent.setOrchestrationPolicy = vi.fn(async (_p: string, _id: string, patch: OrchestrationPolicyPatch) => {
    if (patch.orchestrate === false && helperIds.length > 0) return { ok: true, message: 'Choose', needsHelperChoice: { helperIds } };
    stored = { ...stored, ...patch } as OrchestrationPolicy;
    return { ok: true, message: 'Saved', policy: resolved(stored) };
  });
});

describe('Agent Helpers settings page (#2232)', () => {
  it('duplicates the Orchestrate card\'s switch and fields', async () => {
    render(<AgentHelpersSettings agent={lead} projectPath={PROJECT} />);
    const toggle = await screen.findByTestId('settings-orchestrate-toggle');
    // Off: the fields wait for the switch.
    expect(screen.getByTestId('settings-orchestrate-control')).toBeDisabled();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByTestId('settings-orchestrate-note')).toHaveTextContent('The helper tools appear the next time epic-lead starts.');

    fireEvent.change(screen.getByTestId('settings-orchestrate-control'), { target: { value: 'ask-before-start' } });
    await waitFor(() => expect(window.clubhouse.agent.setOrchestrationPolicy).toHaveBeenLastCalledWith(PROJECT, 'lead', { control: 'ask-before-start' }));
    fireEvent.change(screen.getByTestId('settings-orchestrate-access'), { target: { value: 'auto' } });
    await waitFor(() => expect(window.clubhouse.agent.setOrchestrationPolicy).toHaveBeenLastCalledWith(PROJECT, 'lead', { access: 'auto' }));
    const count = screen.getByTestId('settings-orchestrate-max-helpers');
    fireEvent.change(count, { target: { value: '7' } });
    fireEvent.blur(count);
    await waitFor(() => expect(window.clubhouse.agent.setOrchestrationPolicy).toHaveBeenLastCalledWith(PROJECT, 'lead', { maxHelpers: 7 }));
  });

  it('asks about helpers before turning off, as the card does', async () => {
    stored.orchestrate = true;
    helperIds = ['h1'];
    render(<AgentHelpersSettings agent={lead} projectPath={PROJECT} />);
    const toggle = await screen.findByTestId('settings-orchestrate-toggle');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(toggle);
    expect(await screen.findByTestId('turn-off-orchestration')).toHaveTextContent('epic-lead has 1 helper.');
  });

  it('says so when the policy can\'t be read', async () => {
    window.clubhouse.agent.getOrchestrationPolicy = vi.fn(async () => null);
    render(<AgentHelpersSettings agent={lead} projectPath={PROJECT} />);
    expect(await screen.findByTestId('agent-helpers-settings-unavailable')).toBeInTheDocument();
  });
});
