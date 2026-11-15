import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import { createChatViewState, type ChatViewState } from '../../../stores/chatStore';
import { ProviderSkillsCard } from './ProviderSkillsCard';
import { useProjectStore } from '../../../stores/projectStore';

const agent: Agent = { id: 'a', projectId: 'p', name: 'test', kind: 'durable', status: 'running', color: 'teal', orchestrator: 'claude-code' };
function chat(names: string[] | null = ['review']): ChatViewState {
  return {
    ...createChatViewState('a'), sessionId: 's1', nativeSessionId: 'native', provider: 'claude-code', driver: 'claude_agent_sdk',
    providerSkills: { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', nativeSessionId: 'native', sessionId: 's1', reportedAt: 1000, names },
  };
}

describe('ProviderSkillsCard', () => {
  it('invalidates an inherited report when the project default changes, and refuses unresolved inheritance', () => {
    const inherited = { ...agent, orchestrator: undefined };
    useProjectStore.setState({ projects: [{ id: 'p', name: 'project', path: '/project', orchestrator: 'claude-code' }] });
    const { rerender } = render(<ProviderSkillsCard agent={inherited} chat={chat()} open onToggle={vi.fn()} />);
    expect(screen.getByText('review')).toBeInTheDocument();
    act(() => { useProjectStore.setState({ projects: [{ id: 'p', name: 'project', path: '/project', orchestrator: 'codex-cli' }] }); });
    expect(screen.queryByText('review')).not.toBeInTheDocument();
    expect(screen.queryByTestId('details-card-provider-skills')).toBeNull();
    // An explicit agent override still wins over the new project default.
    rerender(<ProviderSkillsCard agent={agent} chat={chat()} open onToggle={vi.fn()} />);
    expect(screen.getByText('review')).toBeInTheDocument();
    rerender(<ProviderSkillsCard agent={inherited} chat={chat()} open onToggle={vi.fn()} />);
    act(() => { useProjectStore.setState({ projects: [] }); });
    expect(screen.queryByText('review')).not.toBeInTheDocument();
  });

  it('renders literal names, exact session/source/time, limited coverage and no execution claim', () => {
    const state = chat(['../review', '<script>alert(1)</script>']);
    const { container } = render(<ProviderSkillsCard agent={agent} chat={state} open onToggle={vi.fn()} />);
    expect(screen.getByText('../review')).toBeInTheDocument();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('Claude · system/init')).toBeInTheDocument();
    expect(screen.getByText('s1')).toBeInTheDocument();
    expect(screen.getByText('native')).toBeInTheDocument();
    expect(container.querySelector('time')).toHaveAttribute('dateTime', '1970-01-01T00:00:01.000Z');
    expect(screen.getByText(/do not prove a skill was used or executed/)).toHaveTextContent('Filesystem scope and origin are not reported.');
    expect(screen.getByTestId('details-card-provider-skills-summary')).toHaveTextContent('2 reported');
  });

  it('distinguishes explicit none from missing/malformed unknown and does not fetch metadata', () => {
    const { rerender } = render(<ProviderSkillsCard agent={agent} chat={chat([])} open onToggle={vi.fn()} />);
    expect(screen.getByText(/explicitly reported no skills/)).toBeInTheDocument();
    expect(screen.getByText(/Opening this card sends nothing/)).toBeInTheDocument();
    for (const state of [chat(null), { ...chat(), providerSkills: null }]) {
      rerender(<ProviderSkillsCard agent={agent} chat={state} open onToggle={vi.fn()} />);
      expect(screen.queryByTestId('details-card-provider-skills')).toBeNull();
      expect(screen.queryByText(/explicitly reported no skills/)).not.toBeInTheDocument();
    }
  });

  it('hides mismatched agent/session/provider/driver/native identities and labels history', () => {
    const { rerender } = render(<ProviderSkillsCard agent={{ ...agent, status: 'sleeping' }} chat={{ ...chat(), state: 'sleeping' }} open onToggle={vi.fn()} />);
    expect(screen.getByText(/Last session snapshot/)).toBeInTheDocument();
    for (const extra of [{ agentId: 'other' }, { sessionId: 's2' }, { provider: 'codex' }, { driver: 'claude_stream_json' }, { nativeSessionId: 'other' }] as Partial<ChatViewState>[]) {
      rerender(<ProviderSkillsCard agent={agent} chat={{ ...chat(), ...extra }} open onToggle={vi.fn()} />);
      expect(screen.queryByText('review')).not.toBeInTheDocument();
      expect(screen.queryByTestId('details-card-provider-skills')).toBeNull();
    }
    rerender(<ProviderSkillsCard agent={{ ...agent, orchestrator: 'codex' }} chat={chat()} open onToggle={vi.fn()} />);
    expect(screen.queryByText('review')).not.toBeInTheDocument();
    expect(screen.queryByText(/unavailable for this provider or session/)).toBeNull();
    expect(screen.queryByTestId('details-card-provider-skills')).toBeNull();
  });

  it.each([
    ['with delivery evidence', 'running', 't', 'Installed by Clubhouse'],
    ['without delivery evidence', 'running', undefined, 'Set up by Clubhouse'],
    ['while sleeping', 'sleeping', 't', 'Set up by Clubhouse'],
  ])('lists built-in skills outside the saved setup %s', async (_name, agentStatus, deliveredAt, label) => {
    const managed = window.clubhouse.managed;
    const saved = { ...managed };
    const skill = { id: 'builtin-skill-prepare-handoff', name: 'Prepare handoff', deliveredAt };
    let builtinSkills = [skill];
    let changed = () => {};
    managed.getSetup = vi.fn(async () => ({ ok: true, value: null }));
    managed.status = vi.fn(async () => ({ ok: true, value: { managed: true, running: true, waiting: false, changes: [], cliChanged: false, builtinSkills } }));
    managed.onChanged = vi.fn((callback) => { changed = callback; return () => {}; });
    useProjectStore.setState({ projects: [{ id: 'p', name: 'project', path: '/project', orchestrator: 'codex-cli' }] });
    try {
      render(<ProviderSkillsCard agent={{ ...agent, orchestrator: 'codex-cli', status: agentStatus as Agent['status'] }} chat={chat()} open onToggle={vi.fn()} />);
      expect(await screen.findByText('Prepare handoff')).toBeInTheDocument();
      expect(within(screen.getByRole('list', { name: label })).getByText('Prepare handoff')).toBeInTheDocument();
      expect(screen.getByTestId('details-card-provider-skills-summary')).toHaveTextContent(`1 ${label === 'Installed by Clubhouse' ? 'installed' : 'set up'} by Clubhouse`);
      // Current applicability changes remove the built-in even if an older session got it.
      builtinSkills = [];
      act(() => changed());
      await waitFor(() => expect(screen.queryByText('Prepare handoff')).toBeNull());
      expect(screen.queryByTestId('details-card-provider-skills')).toBeNull();
    } finally { Object.assign(managed, saved); }
  });

  it('hides the card when no built-in or managed skills apply and nothing was reported', async () => {
    const managed = window.clubhouse.managed;
    const saved = { ...managed };
    managed.getSetup = vi.fn(async () => ({ ok: true, value: null }));
    managed.status = vi.fn(async () => ({ ok: true, value: { managed: false, running: true, waiting: false, changes: [], cliChanged: false, builtinSkills: [] } }));
    useProjectStore.setState({ projects: [{ id: 'p', name: 'project', path: '/project' }] });
    try {
      render(<ProviderSkillsCard agent={agent} chat={chat(null)} open onToggle={vi.fn()} />);
      await waitFor(() => expect(managed.status).toHaveBeenCalledWith('/project', 'a'));
      expect(screen.queryByTestId('details-card-provider-skills')).toBeNull();
    } finally { Object.assign(managed, saved); }
  });

  it.each([
    ['delivered to a running session', { deliveredAt: 't', waiting: false }, 'running', 'Installed by Clubhouse', '1 installed by Clubhouse'],
    ['edited while running', { deliveredAt: 't', waiting: true }, 'running', 'Set up by Clubhouse', '1 set up by Clubhouse'],
    ['delivery failed', { deliveredAt: 't', waiting: false, deliveryFailed: 'x' }, 'running', 'Set up by Clubhouse', '1 set up by Clubhouse'],
    ['never started', null, 'sleeping', 'Set up by Clubhouse', '1 set up by Clubhouse'],
  ])('lists managed skills without a report, %s', async (_n, status, agentStatus, label, summary) => {
    const managed = (window as unknown as { clubhouse: { managed: Record<string, unknown> } }).clubhouse.managed;
    const saved = { ...managed };
    managed.getSetup = vi.fn(async () => ({ ok: true, value: { version: 1, blocks: [], skills: ['builtin-skill-build', 'gone'], mcps: [] } }));
    managed.listParts = vi.fn(async () => ({ ok: true, value: [{ id: 'builtin-skill-build', name: 'Build', kind: 'skill' }] }));
    managed.status = vi.fn(async () => ({ ok: true, value: status }));
    managed.onChanged = vi.fn(() => () => {});
    useProjectStore.setState({ projects: [{ id: 'p', name: 'project', path: '/project', orchestrator: 'codex-cli' }] });
    try {
      render(<ProviderSkillsCard agent={{ ...agent, orchestrator: 'codex-cli', status: agentStatus as Agent['status'] }} chat={chat()} open onToggle={vi.fn()} />);
      const list = await screen.findByTestId('details-installed-skills');
      expect(list).toHaveTextContent('Build');
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByTestId('details-card-provider-skills-summary')).toHaveTextContent(summary);
      expect(!!screen.queryByText('Applies when the agent next starts.')).toBe(label !== 'Installed by Clubhouse');
      expect(screen.queryByText(/Unknown|unavailable/)).toBeNull();
    } finally {
      Object.assign(managed, saved);
    }
  });
});
