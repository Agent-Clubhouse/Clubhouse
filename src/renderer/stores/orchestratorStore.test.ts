import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOrchestratorStore } from './orchestratorStore';

// Mock window.clubhouse API
const mockGetOrchestratorSettings = vi.fn();
const mockSaveOrchestratorSettings = vi.fn();
const mockGetOrchestrators = vi.fn();
const mockCheckOrchestrator = vi.fn();

Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      app: {
        getOrchestratorSettings: mockGetOrchestratorSettings,
        saveOrchestratorSettings: mockSaveOrchestratorSettings,
      },
      agent: {
        getOrchestrators: mockGetOrchestrators,
        checkOrchestrator: mockCheckOrchestrator,
      },
    },
  },
  writable: true,
});

describe('orchestratorStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state
    useOrchestratorStore.setState({
      enabled: ['claude-code'],
      allOrchestrators: [],
      availability: {},
    });
  });

  describe('initial state', () => {
    it('defaults to claude-code enabled', () => {
      const { enabled } = useOrchestratorStore.getState();
      expect(enabled).toEqual(['claude-code']);
    });

    it('starts with empty orchestrator list', () => {
      const { allOrchestrators } = useOrchestratorStore.getState();
      expect(allOrchestrators).toEqual([]);
    });
  });

  describe('loadSettings', () => {
    it('loads enabled list and orchestrators', async () => {
      mockGetOrchestratorSettings.mockResolvedValue({ enabled: ['claude-code', 'opencode'] });
      mockGetOrchestrators.mockResolvedValue([
        { id: 'claude-code', displayName: 'Claude Code' },
        { id: 'opencode', displayName: 'OpenCode', badge: 'Beta' },
      ]);

      await useOrchestratorStore.getState().loadSettings();

      const state = useOrchestratorStore.getState();
      expect(state.enabled).toEqual(['claude-code', 'opencode']);
      expect(state.allOrchestrators).toHaveLength(2);
    });

    it('falls back to claude-code when settings are null', async () => {
      mockGetOrchestratorSettings.mockResolvedValue(null);
      mockGetOrchestrators.mockResolvedValue([]);

      await useOrchestratorStore.getState().loadSettings();

      expect(useOrchestratorStore.getState().enabled).toEqual(['claude-code']);
    });

    it('handles API errors gracefully', async () => {
      mockGetOrchestratorSettings.mockRejectedValue(new Error('IPC failed'));
      mockGetOrchestrators.mockRejectedValue(new Error('IPC failed'));

      await useOrchestratorStore.getState().loadSettings();

      // Should keep defaults
      expect(useOrchestratorStore.getState().enabled).toEqual(['claude-code']);
    });

    it('handles non-array orchestrators response', async () => {
      mockGetOrchestratorSettings.mockResolvedValue({ enabled: ['claude-code'] });
      mockGetOrchestrators.mockResolvedValue('not an array');

      await useOrchestratorStore.getState().loadSettings();

      expect(useOrchestratorStore.getState().allOrchestrators).toEqual([]);
    });
  });

  describe('setEnabled', () => {
    it('enables an orchestrator', async () => {
      mockSaveOrchestratorSettings.mockResolvedValue(undefined);

      await useOrchestratorStore.getState().setEnabled('opencode', true);

      expect(useOrchestratorStore.getState().enabled).toEqual(['claude-code', 'opencode']);
    });

    it('does not duplicate already enabled orchestrator', async () => {
      mockSaveOrchestratorSettings.mockResolvedValue(undefined);

      await useOrchestratorStore.getState().setEnabled('claude-code', true);

      expect(useOrchestratorStore.getState().enabled).toEqual(['claude-code']);
    });

    it('disables an orchestrator', async () => {
      useOrchestratorStore.setState({ enabled: ['claude-code', 'opencode'] });
      mockSaveOrchestratorSettings.mockResolvedValue(undefined);

      await useOrchestratorStore.getState().setEnabled('opencode', false);

      expect(useOrchestratorStore.getState().enabled).toEqual(['claude-code']);
    });

    it('prevents disabling the last orchestrator', async () => {
      useOrchestratorStore.setState({ enabled: ['claude-code'] });

      await useOrchestratorStore.getState().setEnabled('claude-code', false);

      // Should still have claude-code
      expect(useOrchestratorStore.getState().enabled).toEqual(['claude-code']);
      expect(mockSaveOrchestratorSettings).not.toHaveBeenCalled();
    });

    it('reverts on save error', async () => {
      useOrchestratorStore.setState({ enabled: ['claude-code'] });
      mockSaveOrchestratorSettings.mockRejectedValue(new Error('save failed'));

      await useOrchestratorStore.getState().setEnabled('opencode', true);

      // Should revert to original
      expect(useOrchestratorStore.getState().enabled).toEqual(['claude-code']);
    });

    it('persists new enabled list', async () => {
      mockSaveOrchestratorSettings.mockResolvedValue(undefined);

      await useOrchestratorStore.getState().setEnabled('opencode', true);

      expect(mockSaveOrchestratorSettings).toHaveBeenCalledWith({
        enabled: ['claude-code', 'opencode'],
      });
    });
  });

  describe('checkAllAvailability', () => {
    it('checks each orchestrator and stores results', async () => {
      useOrchestratorStore.setState({
        allOrchestrators: [
          { id: 'claude-code', displayName: 'Claude Code' },
          { id: 'opencode', displayName: 'OpenCode' },
        ],
      });

      mockCheckOrchestrator.mockImplementation((_path: string, id: string) => {
        if (id === 'claude-code') return Promise.resolve({ available: true });
        return Promise.resolve({ available: false, error: 'Not installed' });
      });

      await useOrchestratorStore.getState().checkAllAvailability();

      const { availability } = useOrchestratorStore.getState();
      expect(availability['claude-code']).toEqual({ available: true });
      expect(availability['opencode']).toEqual({ available: false, error: 'Not installed' });
    });

    it('handles check failure for individual orchestrator', async () => {
      useOrchestratorStore.setState({
        allOrchestrators: [{ id: 'claude-code', displayName: 'Claude Code' }],
      });

      mockCheckOrchestrator.mockRejectedValue(new Error('Check failed'));

      await useOrchestratorStore.getState().checkAllAvailability();

      const { availability } = useOrchestratorStore.getState();
      expect(availability['claude-code']).toEqual({ available: false, error: 'Check failed' });
    });
  });

  describe('getEnabledOrchestrators', () => {
    it('filters allOrchestrators by enabled list', () => {
      useOrchestratorStore.setState({
        enabled: ['claude-code'],
        allOrchestrators: [
          { id: 'claude-code', displayName: 'Claude Code' },
          { id: 'opencode', displayName: 'OpenCode' },
        ],
      });

      const result = useOrchestratorStore.getState().getEnabledOrchestrators();
      expect(result).toEqual([{ id: 'claude-code', displayName: 'Claude Code' }]);
    });

    it('returns empty when none enabled match', () => {
      useOrchestratorStore.setState({
        enabled: ['nonexistent'],
        allOrchestrators: [{ id: 'claude-code', displayName: 'Claude Code' }],
      });

      const result = useOrchestratorStore.getState().getEnabledOrchestrators();
      expect(result).toEqual([]);
    });
  });
});
