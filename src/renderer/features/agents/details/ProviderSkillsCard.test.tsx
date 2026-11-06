import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import { createChatViewState, type ChatViewState } from '../../../stores/chatStore';
import { ProviderSkillsCard } from './ProviderSkillsCard';

const agent: Agent = { id: 'a', projectId: 'p', name: 'test', kind: 'durable', status: 'running', color: 'teal', orchestrator: 'claude-code' };
function chat(names: string[] | null = ['review']): ChatViewState {
  return {
    ...createChatViewState('a'), sessionId: 's1', nativeSessionId: 'native', provider: 'claude-code', driver: 'claude_agent_sdk',
    providerSkills: { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', nativeSessionId: 'native', sessionId: 's1', reportedAt: 1000, names },
  };
}

describe('ProviderSkillsCard', () => {
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
    for (const state of [chat(null), { ...chat(), providerSkills: null }]) {
      rerender(<ProviderSkillsCard agent={agent} chat={state} open onToggle={vi.fn()} />);
      expect(screen.getByTestId('details-card-provider-skills-summary')).toHaveTextContent('Unknown');
      expect(screen.getByText('No valid skill list reported for this session.')).toBeInTheDocument();
      expect(screen.queryByText(/explicitly reported no skills/)).not.toBeInTheDocument();
    }
    expect(screen.getByText(/Opening this card sends nothing/)).toBeInTheDocument();
  });

  it('hides mismatched agent/session/provider/driver/native identities and labels history', () => {
    const { rerender } = render(<ProviderSkillsCard agent={{ ...agent, status: 'sleeping' }} chat={{ ...chat(), state: 'sleeping' }} open onToggle={vi.fn()} />);
    expect(screen.getByText(/Last session snapshot/)).toBeInTheDocument();
    for (const extra of [{ agentId: 'other' }, { sessionId: 's2' }, { provider: 'codex' }, { driver: 'claude_stream_json' }, { nativeSessionId: 'other' }] as Partial<ChatViewState>[]) {
      rerender(<ProviderSkillsCard agent={agent} chat={{ ...chat(), ...extra }} open onToggle={vi.fn()} />);
      expect(screen.queryByText('review')).not.toBeInTheDocument();
      expect(screen.getByTestId('details-card-provider-skills-summary')).toHaveTextContent('Unknown');
    }
    rerender(<ProviderSkillsCard agent={{ ...agent, orchestrator: 'codex' }} chat={chat()} open onToggle={vi.fn()} />);
    expect(screen.queryByText('review')).not.toBeInTheDocument();
    expect(screen.getByText(/unavailable for this provider or session/)).toBeInTheDocument();
  });
});
