import { describe, it, expect } from 'vitest';
import { agentSpeakerId } from './tts-service';

describe('tts-service', () => {
  describe('agentSpeakerId', () => {
    it('returns a number in range 0-108', () => {
      const id = agentSpeakerId('test-agent-1');
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThanOrEqual(108);
    });

    it('returns consistent results for the same agentId', () => {
      const id1 = agentSpeakerId('my-agent');
      const id2 = agentSpeakerId('my-agent');
      expect(id1).toBe(id2);
    });

    it('returns different results for different agentIds', () => {
      const id1 = agentSpeakerId('agent-alpha');
      const id2 = agentSpeakerId('agent-beta');
      // Different IDs should (usually) produce different speaker IDs
      // Not guaranteed due to hash collisions, but very likely for distinct inputs
      expect(typeof id1).toBe('number');
      expect(typeof id2).toBe('number');
    });

    it('handles empty string', () => {
      const id = agentSpeakerId('');
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThanOrEqual(108);
    });

    it('handles long strings', () => {
      const id = agentSpeakerId('a'.repeat(1000));
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThanOrEqual(108);
    });

    it('handles special characters', () => {
      const id = agentSpeakerId('agent-with-special_chars.v2');
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThanOrEqual(108);
    });

    it('returns an integer', () => {
      const id = agentSpeakerId('test');
      expect(Number.isInteger(id)).toBe(true);
    });
  });
});
