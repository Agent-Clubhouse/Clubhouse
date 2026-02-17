import { describe, it, expect } from 'vitest';
import {
  getOrchestratorColor,
  getModelColor,
  getOrchestratorLabel,
  formatModelLabel,
  ORCHESTRATOR_COLORS,
  DEFAULT_ORCH_COLOR,
} from './orchestrator-colors';

describe('orchestrator-colors', () => {
  describe('getOrchestratorColor', () => {
    it('returns orange for claude-code', () => {
      expect(getOrchestratorColor('claude-code')).toEqual(ORCHESTRATOR_COLORS['claude-code']);
    });

    it('returns blue for copilot-cli', () => {
      expect(getOrchestratorColor('copilot-cli')).toEqual(ORCHESTRATOR_COLORS['copilot-cli']);
    });

    it('returns default grey for unknown orchestrator', () => {
      expect(getOrchestratorColor('unknown')).toEqual(DEFAULT_ORCH_COLOR);
    });
  });

  describe('getModelColor', () => {
    it('returns a color object with bg and text', () => {
      const color = getModelColor('sonnet');
      expect(color).toHaveProperty('bg');
      expect(color).toHaveProperty('text');
    });

    it('returns consistent colors for the same model', () => {
      const color1 = getModelColor('opus');
      const color2 = getModelColor('opus');
      expect(color1).toBe(color2);
    });

    it('returns different colors for different models', () => {
      // Different strings should generally hash to different palette entries
      const color1 = getModelColor('sonnet');
      const color2 = getModelColor('opus');
      // They could theoretically collide, but these two don't
      expect(color1).not.toBe(color2);
    });
  });

  describe('getOrchestratorLabel', () => {
    it('returns shortName from orchestrator info when available', () => {
      const orchestrators = [
        { id: 'claude-code', shortName: 'CC', displayName: 'Claude Code' },
        { id: 'copilot-cli', shortName: 'GHCP', displayName: 'GitHub Copilot CLI' },
      ];
      expect(getOrchestratorLabel('claude-code', orchestrators)).toBe('CC');
      expect(getOrchestratorLabel('copilot-cli', orchestrators)).toBe('GHCP');
    });

    it('falls back to displayName when shortName is missing', () => {
      const orchestrators = [
        { id: 'custom-orch', displayName: 'Custom Orchestrator' },
      ];
      expect(getOrchestratorLabel('custom-orch', orchestrators)).toBe('Custom Orchestrator');
    });

    it('uses static short names when orchestrator list is not provided', () => {
      expect(getOrchestratorLabel('claude-code')).toBe('CC');
      expect(getOrchestratorLabel('copilot-cli')).toBe('GHCP');
      expect(getOrchestratorLabel('opencode')).toBe('OC');
    });

    it('uses static short names when orchestrator list is empty', () => {
      expect(getOrchestratorLabel('claude-code', [])).toBe('CC');
    });

    it('falls back to raw ID for unknown orchestrators with no list', () => {
      expect(getOrchestratorLabel('unknown-provider')).toBe('unknown-provider');
    });

    it('falls back to raw ID for unknown orchestrators not in list', () => {
      const orchestrators = [
        { id: 'claude-code', shortName: 'CC', displayName: 'Claude Code' },
      ];
      expect(getOrchestratorLabel('unknown-provider', orchestrators)).toBe('unknown-provider');
    });
  });

  describe('formatModelLabel', () => {
    it('capitalizes first letter of model name', () => {
      expect(formatModelLabel('sonnet')).toBe('Sonnet');
      expect(formatModelLabel('opus')).toBe('Opus');
      expect(formatModelLabel('haiku')).toBe('Haiku');
    });

    it('preserves already-capitalized names', () => {
      expect(formatModelLabel('Sonnet')).toBe('Sonnet');
    });

    it('returns "Default" for undefined model', () => {
      expect(formatModelLabel(undefined)).toBe('Default');
    });

    it('returns "Default" for "default" model', () => {
      expect(formatModelLabel('default')).toBe('Default');
    });

    it('handles multi-word model names', () => {
      expect(formatModelLabel('claude-3.5-sonnet')).toBe('Claude-3.5-sonnet');
    });

    it('handles single character model names', () => {
      expect(formatModelLabel('x')).toBe('X');
    });
  });
});
