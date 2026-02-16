import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron BrowserWindow
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock the orchestrator shared module
vi.mock('../../orchestrators/shared', () => ({
  findBinaryInPath: vi.fn(() => '/usr/local/bin/claude'),
  homePath: vi.fn((...segments: string[]) => `/home/test/${segments.join('/')}`),
}));

// Mock the tts-service
vi.mock('./tts-service', () => ({
  synthesize: vi.fn(async () => Buffer.alloc(0)),
  agentSpeakerId: vi.fn((id: string) => {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 109;
  }),
}));

import { startSession, endSession } from './voice-session';

describe('voice-session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clean up any active session
    endSession();
  });

  describe('startSession', () => {
    it('returns an object with a sessionId', () => {
      const result = startSession('/project/path', 'agent-1');
      expect(result).toHaveProperty('sessionId');
      expect(typeof result.sessionId).toBe('string');
    });

    it('sessionId starts with "voice-"', () => {
      const result = startSession('/project/path', 'agent-1');
      expect(result.sessionId).toMatch(/^voice-/);
    });

    it('different calls produce different sessionIds', async () => {
      const r1 = startSession('/project/path', 'agent-1');
      endSession();
      // Ensure timestamp advances
      await new Promise((resolve) => setTimeout(resolve, 5));
      const r2 = startSession('/project/path', 'agent-1');
      expect(r1.sessionId).not.toBe(r2.sessionId);
    });

    it('accepts optional model parameter', () => {
      expect(() => startSession('/project/path', 'agent-1', 'sonnet')).not.toThrow();
    });
  });

  describe('endSession', () => {
    it('does not throw when no session is active', () => {
      expect(() => endSession()).not.toThrow();
    });

    it('does not throw when called twice', () => {
      startSession('/project/path', 'agent-1');
      endSession();
      expect(() => endSession()).not.toThrow();
    });
  });
});
