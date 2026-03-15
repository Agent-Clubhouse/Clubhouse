import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('electron', () => {
  const _os = require('os');
  const _path = require('path');
  return {
    app: {
      getPath: (name: string) => _path.join(_os.tmpdir(), `clubhouse-test-${name}`),
    },
  };
});

const mockGetProvider = vi.fn();
vi.mock('../orchestrators', () => ({
  getProvider: (...args: unknown[]) => mockGetProvider(...args),
}));

const mockAppLog = vi.fn();
vi.mock('./log-service', () => ({
  appLog: (...args: unknown[]) => mockAppLog(...args),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

import * as fsp from 'fs/promises';
import {
  agentRegistry,
  getAgentProjectPath,
  getAgentOrchestrator,
  getAgentNonce,
  untrackAgent,
  resolveOrchestrator,
  readProjectOrchestrator,
  DEFAULT_ORCHESTRATOR,
} from './agent-registry';

describe('agent-registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clean up any leftover registrations
    untrackAgent('test-agent');
    untrackAgent('agent-1');
    untrackAgent('agent-2');
  });

  describe('AgentRegistry', () => {
    it('registers and retrieves agents', () => {
      agentRegistry.register('agent-1', {
        projectPath: '/project/a',
        orchestrator: 'claude-code',
        runtime: 'pty',
      });

      expect(getAgentProjectPath('agent-1')).toBe('/project/a');
      expect(getAgentOrchestrator('agent-1')).toBe('claude-code');
    });

    it('returns undefined for unregistered agents', () => {
      expect(getAgentProjectPath('nonexistent')).toBeUndefined();
      expect(getAgentOrchestrator('nonexistent')).toBeUndefined();
      expect(getAgentNonce('nonexistent')).toBeUndefined();
    });

    it('sets and retrieves nonce', () => {
      agentRegistry.register('agent-1', {
        projectPath: '/project/a',
        orchestrator: 'claude-code',
        runtime: 'pty',
      });

      expect(getAgentNonce('agent-1')).toBeUndefined();

      agentRegistry.setNonce('agent-1', 'nonce-123');
      expect(getAgentNonce('agent-1')).toBe('nonce-123');
    });

    it('ignores setNonce for unregistered agent', () => {
      agentRegistry.setNonce('nonexistent', 'nonce-123');
      expect(getAgentNonce('nonexistent')).toBeUndefined();
    });

    it('sets and retrieves runtime', () => {
      agentRegistry.register('agent-1', {
        projectPath: '/project/a',
        orchestrator: 'claude-code',
        runtime: 'pty',
      });

      expect(agentRegistry.get('agent-1')?.runtime).toBe('pty');

      agentRegistry.setRuntime('agent-1', 'headless');
      expect(agentRegistry.get('agent-1')?.runtime).toBe('headless');
    });

    it('ignores setRuntime for unregistered agent', () => {
      agentRegistry.setRuntime('nonexistent', 'structured');
      expect(agentRegistry.get('nonexistent')).toBeUndefined();
    });

    it('untracks agents', () => {
      agentRegistry.register('agent-1', {
        projectPath: '/project/a',
        orchestrator: 'claude-code',
        runtime: 'pty',
      });

      untrackAgent('agent-1');
      expect(getAgentProjectPath('agent-1')).toBeUndefined();
    });
  });

  describe('DEFAULT_ORCHESTRATOR', () => {
    it('is claude-code', () => {
      expect(DEFAULT_ORCHESTRATOR).toBe('claude-code');
    });
  });

  describe('readProjectOrchestrator', () => {
    it('reads orchestrator from settings file', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ orchestrator: 'copilot-cli' }));

      const result = await readProjectOrchestrator('/project');
      expect(result).toBe('copilot-cli');
      expect(fsp.readFile).toHaveBeenCalledWith(path.join('/project', '.clubhouse', 'settings.json'), 'utf-8');
    });

    it('returns undefined when settings file does not exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));

      const result = await readProjectOrchestrator('/project');
      expect(result).toBeUndefined();
    });
  });

  describe('resolveOrchestrator', () => {
    const mockProvider = {
      id: 'claude-code',
      displayName: 'Claude Code',
    };

    it('resolves agent-level orchestrator override', async () => {
      mockGetProvider.mockReturnValue(mockProvider);

      const result = await resolveOrchestrator('/project', 'claude-code');
      expect(result).toBe(mockProvider);
      expect(mockGetProvider).toHaveBeenCalledWith('claude-code');
    });

    it('falls back to project setting', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ orchestrator: 'copilot-cli' }));
      const copilotProvider = { id: 'copilot-cli', displayName: 'Copilot CLI' };
      mockGetProvider.mockReturnValue(copilotProvider);

      const result = await resolveOrchestrator('/project');
      expect(result).toBe(copilotProvider);
      expect(mockGetProvider).toHaveBeenCalledWith('copilot-cli');
    });

    it('falls back to default orchestrator', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      mockGetProvider.mockReturnValue(mockProvider);

      const result = await resolveOrchestrator('/project');
      expect(result).toBe(mockProvider);
      expect(mockGetProvider).toHaveBeenCalledWith('claude-code');
    });

    it('throws for unknown orchestrator', async () => {
      mockGetProvider.mockReturnValue(undefined);

      await expect(resolveOrchestrator('/project', 'unknown' as any)).rejects.toThrow('Unknown orchestrator: unknown');
      expect(mockAppLog).toHaveBeenCalledWith(
        'core:agent', 'error',
        expect.stringContaining('Unknown orchestrator'),
        expect.any(Object),
      );
    });
  });

  describe('no circular dependency', () => {
    it('does not import from hook-server or agent-system', async () => {
      // This test verifies the module can be imported independently.
      // If there were a circular dependency, the import above would fail
      // or produce incomplete module exports.
      expect(agentRegistry).toBeDefined();
      expect(getAgentProjectPath).toBeInstanceOf(Function);
      expect(resolveOrchestrator).toBeInstanceOf(Function);
    });
  });
});
