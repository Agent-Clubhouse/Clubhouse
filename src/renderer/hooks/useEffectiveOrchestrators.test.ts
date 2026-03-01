import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useEffectiveOrchestrators } from './useEffectiveOrchestrators';
import { useOrchestratorStore } from '../stores/orchestratorStore';
import { useProfileStore } from '../stores/profileStore';
import type { OrchestratorInfo } from '../../shared/types';

const mockOrchestrators: OrchestratorInfo[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    shortName: 'CC',
    capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true, structuredMode: false },
  },
  {
    id: 'codex-cli',
    displayName: 'Codex CLI',
    shortName: 'CX',
    capabilities: { headless: false, structuredOutput: false, hooks: false, sessionResume: false, permissions: false, structuredMode: false },
  },
  {
    id: 'copilot-cli',
    displayName: 'Copilot CLI',
    shortName: 'CP',
    capabilities: { headless: false, structuredOutput: false, hooks: false, sessionResume: false, permissions: false, structuredMode: false },
  },
];

describe('useEffectiveOrchestrators', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrchestratorStore.setState({
      allOrchestrators: mockOrchestrators,
      enabled: ['claude-code', 'codex-cli', 'copilot-cli'],
    });
    useProfileStore.setState({ profiles: [] });

    // Mock window.clubhouse.agentSettings.readProjectAgentDefaults
    (window as any).clubhouse = {
      ...(window as any).clubhouse,
      agentSettings: {
        ...((window as any).clubhouse?.agentSettings || {}),
        readProjectAgentDefaults: vi.fn().mockResolvedValue({}),
      },
      profile: {
        getSettings: vi.fn().mockResolvedValue({ profiles: [] }),
        saveProfile: vi.fn(),
        deleteProfile: vi.fn(),
        getProfileEnvKeys: vi.fn().mockResolvedValue([]),
      },
    };
  });

  it('returns all enabled orchestrators when no profile is active', async () => {
    const { result } = renderHook(() => useEffectiveOrchestrators('/project'));

    await waitFor(() => {
      expect(result.current.effectiveOrchestrators).toHaveLength(3);
    });

    expect(result.current.activeProfile).toBeUndefined();
    expect(result.current.isOrchestratorInProfile('claude-code')).toBe(true);
    expect(result.current.isOrchestratorInProfile('codex-cli')).toBe(true);
  });

  it('returns all enabled orchestrators when no projectPath', () => {
    const { result } = renderHook(() => useEffectiveOrchestrators(undefined));

    expect(result.current.effectiveOrchestrators).toHaveLength(3);
    expect(result.current.activeProfile).toBeUndefined();
  });

  it('filters orchestrators when a profile is active', async () => {
    const profile = {
      id: 'work-profile',
      name: 'Work',
      orchestrators: {
        'claude-code': { env: { CLAUDE_CONFIG_DIR: '~/.claude-work' } },
        'codex-cli': { env: { OPENAI_API_KEY: 'sk-work' } },
      },
    };
    useProfileStore.setState({ profiles: [profile] });
    // loadProfiles will re-fetch from IPC, so mock it to return the same profiles
    (window as any).clubhouse.profile.getSettings.mockResolvedValue({ profiles: [profile] });
    (window as any).clubhouse.agentSettings.readProjectAgentDefaults.mockResolvedValue({
      profileId: 'work-profile',
    });

    const { result } = renderHook(() => useEffectiveOrchestrators('/project'));

    await waitFor(() => {
      expect(result.current.effectiveOrchestrators).toHaveLength(2);
    });

    expect(result.current.activeProfile).toEqual(profile);
    expect(result.current.effectiveOrchestrators.map((o) => o.id)).toEqual(['claude-code', 'codex-cli']);
    expect(result.current.isOrchestratorInProfile('claude-code')).toBe(true);
    expect(result.current.isOrchestratorInProfile('codex-cli')).toBe(true);
    expect(result.current.isOrchestratorInProfile('copilot-cli')).toBe(false);
  });

  it('falls back to all enabled when profile has no matching enabled orchestrators', async () => {
    const profile = {
      id: 'broken-profile',
      name: 'Broken',
      orchestrators: {
        'nonexistent': { env: {} },
      },
    };
    useProfileStore.setState({ profiles: [profile] });
    (window as any).clubhouse.profile.getSettings.mockResolvedValue({ profiles: [profile] });
    (window as any).clubhouse.agentSettings.readProjectAgentDefaults.mockResolvedValue({
      profileId: 'broken-profile',
    });

    const { result } = renderHook(() => useEffectiveOrchestrators('/project'));

    await waitFor(() => {
      expect(result.current.activeProfile).toEqual(profile);
    });

    // Falls back to all enabled since no profile orchestrators are enabled
    expect(result.current.effectiveOrchestrators).toHaveLength(3);
  });

  it('returns all enabled when profile ID does not match any profile', async () => {
    (window as any).clubhouse.agentSettings.readProjectAgentDefaults.mockResolvedValue({
      profileId: 'nonexistent-profile',
    });

    const { result } = renderHook(() => useEffectiveOrchestrators('/project'));

    await waitFor(() => {
      expect(result.current.effectiveOrchestrators).toHaveLength(3);
    });

    expect(result.current.activeProfile).toBeUndefined();
  });
});
