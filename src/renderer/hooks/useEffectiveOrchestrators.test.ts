import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useEffectiveOrchestrators } from './useEffectiveOrchestrators';
import { useOrchestratorStore } from '../stores/orchestratorStore';
import type { OrchestratorInfo } from '../../shared/types';

const caps = { headless: false, structuredOutput: false, hooks: false, sessionResume: false, permissions: false, structuredMode: false };
const mockOrchestrators: OrchestratorInfo[] = [
  { id: 'claude-code', displayName: 'Claude Code', shortName: 'CC', capabilities: { ...caps, headless: true } },
  { id: 'codex-cli', displayName: 'Codex CLI', shortName: 'CX', capabilities: caps },
  { id: 'copilot-cli', displayName: 'Copilot CLI', shortName: 'CP', capabilities: caps },
];

describe('useEffectiveOrchestrators', () => {
  beforeEach(() => {
    useOrchestratorStore.setState({
      allOrchestrators: mockOrchestrators,
      enabled: ['claude-code', 'codex-cli', 'copilot-cli'],
    });
  });

  it('returns every enabled orchestrator', () => {
    const { result } = renderHook(() => useEffectiveOrchestrators());
    expect(result.current.effectiveOrchestrators.map((o) => o.id)).toEqual(['claude-code', 'codex-cli', 'copilot-cli']);
  });

  it('leaves out disabled orchestrators', () => {
    useOrchestratorStore.setState({ enabled: ['codex-cli'] });
    const { result } = renderHook(() => useEffectiveOrchestrators());
    expect(result.current.effectiveOrchestrators.map((o) => o.id)).toEqual(['codex-cli']);
  });
});
