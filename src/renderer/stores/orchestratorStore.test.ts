import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOrchestratorStore } from './orchestratorStore';

// Uses the centralized window.clubhouse mock from test/setup-renderer.ts.
// Override specific methods with spies for assertion.

describe('orchestratorStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state
    useOrchestratorStore.setState({
      enabled: ['claude-code'],
      allOrchestrators: [],
      availability: {},
      hookServerEnabled: {},
    });
    // Set up spies on the centralized mock
    (window as any).clubhouse.app.getOrchestratorSettings = vi.fn();
    (window as any).clubhouse.app.saveOrchestratorSettings = vi.fn();
    (window as any).clubhouse.app.setOrchestratorHookServer = vi.fn();
    (window as any).clubhouse.agent.getOrchestrators = vi.fn();
    (window as any).clubhouse.agent.checkOrchestrator = vi.fn();
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
      (window as any).clubhouse.app.getOrchestratorSettings.mockResolvedValue({ enabled: ['claude-code', 'codex-cli'] });
      (window as any).clubhouse.agent.getOrchestrators.mockResolvedValue([
        { id: 'claude-code', displayName: 'Claude Code' },
        { id: 'codex-cli', displayName: 'Codex CLI', badge: 'Beta' },
      ]);

      await useOrchestratorStore.getState().loadSettings();

      const state = useOrchestratorStore.getState();
      expect(state.enabled).toEqual(['claude-code', 'codex-cli']);
      expect(state.allOrchestrators).toHaveLength(2);
    });

    it('falls back to claude-code when settings are null', async () => {
      (window as any).clubhouse.app.getOrchestratorSettings.mockResolvedValue(null);
      (window as any).clubhouse.agent.getOrchestrators.mockResolvedValue([]);

      await useOrchestratorStore.getState().loadSettings();

      expect(useOrchestratorStore.getState().enabled).toEqual(['claude-code']);
    });

    it('handles API errors gracefully', async () => {
      (window as any).clubhouse.app.getOrchestratorSettings.mockRejectedValue(new Error('IPC failed'));
      (window as any).clubhouse.agent.getOrchestrators.mockRejectedValue(new Error('IPC failed'));

      await useOrchestratorStore.getState().loadSettings();

      // Should keep defaults
      expect(useOrchestratorStore.getState().enabled).toEqual(['claude-code']);
    });

    it('handles non-array orchestrators response', async () => {
      (window as any).clubhouse.app.getOrchestratorSettings.mockResolvedValue({ enabled: ['claude-code'] });
      (window as any).clubhouse.agent.getOrchestrators.mockResolvedValue('not an array');

      await useOrchestratorStore.getState().loadSettings();

      expect(useOrchestratorStore.getState().allOrchestrators).toEqual([]);
    });
  });

  describe('setEnabled', () => {
    it('enables an orchestrator', async () => {
      (window as any).clubhouse.app.saveOrchestratorSettings.mockResolvedValue(undefined);

      await useOrchestratorStore.getState().setEnabled('codex-cli', true);

      expect(useOrchestratorStore.getState().enabled).toEqual(['claude-code', 'codex-cli']);
    });

    it('does not duplicate already enabled orchestrator', async () => {
      (window as any).clubhouse.app.saveOrchestratorSettings.mockResolvedValue(undefined);

      await useOrchestratorStore.getState().setEnabled('claude-code', true);

      expect(useOrchestratorStore.getState().enabled).toEqual(['claude-code']);
    });

    it('disables an orchestrator', async () => {
      useOrchestratorStore.setState({ enabled: ['claude-code', 'codex-cli'] });
      (window as any).clubhouse.app.saveOrchestratorSettings.mockResolvedValue(undefined);

      await useOrchestratorStore.getState().setEnabled('codex-cli', false);

      expect(useOrchestratorStore.getState().enabled).toEqual(['claude-code']);
    });

    it('prevents disabling the last orchestrator when it is installed', async () => {
      useOrchestratorStore.setState({
        enabled: ['claude-code'],
        availability: { 'claude-code': { available: true } },
      });

      await useOrchestratorStore.getState().setEnabled('claude-code', false);

      // Should still have claude-code
      expect(useOrchestratorStore.getState().enabled).toEqual(['claude-code']);
      expect((window as any).clubhouse.app.saveOrchestratorSettings).not.toHaveBeenCalled();
    });

    it('prevents disabling the last orchestrator when availability is unknown', async () => {
      useOrchestratorStore.setState({
        enabled: ['claude-code'],
        availability: {},
      });

      await useOrchestratorStore.getState().setEnabled('claude-code', false);

      expect(useOrchestratorStore.getState().enabled).toEqual(['claude-code']);
      expect((window as any).clubhouse.app.saveOrchestratorSettings).not.toHaveBeenCalled();
    });

    it('allows disabling the last orchestrator when it is not installed', async () => {
      useOrchestratorStore.setState({
        enabled: ['claude-code'],
        availability: { 'claude-code': { available: false, error: 'CLI not found' } },
      });
      (window as any).clubhouse.app.saveOrchestratorSettings.mockResolvedValue(undefined);

      await useOrchestratorStore.getState().setEnabled('claude-code', false);

      expect(useOrchestratorStore.getState().enabled).toEqual([]);
      expect((window as any).clubhouse.app.saveOrchestratorSettings).toHaveBeenCalledWith({ enabled: [] });
    });

    it('reverts on save error', async () => {
      useOrchestratorStore.setState({ enabled: ['claude-code'] });
      (window as any).clubhouse.app.saveOrchestratorSettings.mockRejectedValue(new Error('save failed'));

      await useOrchestratorStore.getState().setEnabled('codex-cli', true);

      // Should revert to original
      expect(useOrchestratorStore.getState().enabled).toEqual(['claude-code']);
    });

    it('persists new enabled list', async () => {
      (window as any).clubhouse.app.saveOrchestratorSettings.mockResolvedValue(undefined);

      await useOrchestratorStore.getState().setEnabled('codex-cli', true);

      expect((window as any).clubhouse.app.saveOrchestratorSettings).toHaveBeenCalledWith({
        enabled: ['claude-code', 'codex-cli'],
      });
    });
  });

  describe('hook server preferences', () => {
    it('loads persisted hook server prefs', async () => {
      (window as any).clubhouse.app.getOrchestratorSettings.mockResolvedValue({
        enabled: ['claude-code', 'copilot-cli'],
        hookServerEnabled: { 'copilot-cli': true },
      });
      (window as any).clubhouse.agent.getOrchestrators.mockResolvedValue([]);

      await useOrchestratorStore.getState().loadSettings();

      expect(useOrchestratorStore.getState().hookServerEnabled).toEqual({ 'copilot-cli': true });
    });

    it('isHookServerEnabled defaults claude-code ON and others OFF', () => {
      const { isHookServerEnabled } = useOrchestratorStore.getState();
      expect(isHookServerEnabled('claude-code')).toBe(true);
      expect(isHookServerEnabled('copilot-cli')).toBe(false);
      expect(isHookServerEnabled('codex-cli')).toBe(false);
    });

    it('isHookServerEnabled honours an explicit pref over the default', () => {
      useOrchestratorStore.setState({ hookServerEnabled: { 'claude-code': false, 'copilot-cli': true } });
      const { isHookServerEnabled } = useOrchestratorStore.getState();
      expect(isHookServerEnabled('claude-code')).toBe(false);
      expect(isHookServerEnabled('copilot-cli')).toBe(true);
    });

    it('setHookServerEnabled updates state and calls the IPC bridge', async () => {
      (window as any).clubhouse.app.setOrchestratorHookServer.mockResolvedValue(undefined);

      await useOrchestratorStore.getState().setHookServerEnabled('copilot-cli', true);

      expect(useOrchestratorStore.getState().hookServerEnabled).toEqual({ 'copilot-cli': true });
      expect((window as any).clubhouse.app.setOrchestratorHookServer).toHaveBeenCalledWith('copilot-cli', true);
    });

    it('setHookServerEnabled reverts on IPC error', async () => {
      useOrchestratorStore.setState({ hookServerEnabled: { 'copilot-cli': true } });
      (window as any).clubhouse.app.setOrchestratorHookServer.mockRejectedValue(new Error('boom'));

      await useOrchestratorStore.getState().setHookServerEnabled('copilot-cli', false);

      expect(useOrchestratorStore.getState().hookServerEnabled).toEqual({ 'copilot-cli': true });
    });
  });

  describe('getCapabilities', () => {
    it('returns capabilities for a known orchestrator', () => {
      const caps = { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true, structuredMode: false };
      useOrchestratorStore.setState({
        allOrchestrators: [
          { id: 'claude-code', displayName: 'Claude Code', capabilities: caps },
        ],
      });

      expect(useOrchestratorStore.getState().getCapabilities('claude-code')).toEqual(caps);
    });

    it('returns undefined for unknown orchestrator', () => {
      useOrchestratorStore.setState({
        allOrchestrators: [
          { id: 'claude-code', displayName: 'Claude Code', capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true, structuredMode: false } },
        ],
      });

      expect(useOrchestratorStore.getState().getCapabilities('nonexistent')).toBeUndefined();
    });
  });

  describe('checkAllAvailability', () => {
    it('checks each orchestrator and stores results', async () => {
      useOrchestratorStore.setState({
        allOrchestrators: [
          { id: 'claude-code', displayName: 'Claude Code' } as any,
          { id: 'codex-cli', displayName: 'Codex CLI' } as any,
        ],
      });

      (window as any).clubhouse.agent.checkOrchestrator.mockImplementation((_path: string, id: string) => {
        if (id === 'claude-code') return Promise.resolve({ available: true });
        return Promise.resolve({ available: false, error: 'Not installed' });
      });

      await useOrchestratorStore.getState().checkAllAvailability();

      const { availability } = useOrchestratorStore.getState();
      expect(availability['claude-code']).toEqual({ available: true });
      expect(availability['codex-cli']).toEqual({ available: false, error: 'Not installed' });
    });

    it('handles check failure for individual orchestrator', async () => {
      useOrchestratorStore.setState({
        allOrchestrators: [{ id: 'claude-code', displayName: 'Claude Code' } as any],
      });

      (window as any).clubhouse.agent.checkOrchestrator.mockRejectedValue(new Error('Check failed'));

      await useOrchestratorStore.getState().checkAllAvailability();

      const { availability } = useOrchestratorStore.getState();
      expect(availability['claude-code']).toEqual({ available: false, error: 'Check failed' });
    });
  });

  describe('enabled orchestrators (computed inline by consumers)', () => {
    it('can be computed by filtering allOrchestrators by enabled list', () => {
      useOrchestratorStore.setState({
        enabled: ['claude-code'],
        allOrchestrators: [
          { id: 'claude-code', displayName: 'Claude Code' } as any,
          { id: 'codex-cli', displayName: 'Codex CLI' } as any,
        ],
      });

      const { enabled, allOrchestrators } = useOrchestratorStore.getState();
      const result = allOrchestrators.filter((o) => enabled.includes(o.id));
      expect(result).toEqual([{ id: 'claude-code', displayName: 'Claude Code' }]);
    });

    it('returns empty when none enabled match', () => {
      useOrchestratorStore.setState({
        enabled: ['nonexistent'],
        allOrchestrators: [{ id: 'claude-code', displayName: 'Claude Code' } as any],
      });

      const { enabled, allOrchestrators } = useOrchestratorStore.getState();
      const result = allOrchestrators.filter((o) => enabled.includes(o.id));
      expect(result).toEqual([]);
    });
  });
});
