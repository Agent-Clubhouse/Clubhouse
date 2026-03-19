import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSerialize = vi.fn().mockReturnValue('');
const mockDispose = vi.fn();
const mockWrite = vi.fn();
const mockResize = vi.fn();
const mockLoadAddon = vi.fn();

vi.mock('@xterm/headless', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    write: mockWrite,
    resize: mockResize,
    loadAddon: mockLoadAddon,
    dispose: mockDispose,
  })),
}));

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: vi.fn().mockImplementation(() => ({
    serialize: mockSerialize,
    dispose: mockDispose,
  })),
}));

import { feedData, resize, serialize, dispose, disposeAll } from './pty-headless-terminal';

describe('pty-headless-terminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clean up any sessions from previous tests
    disposeAll();
  });

  describe('feedData', () => {
    it('creates a headless terminal on first data feed', () => {
      feedData('agent-1', 'hello');
      expect(mockWrite).toHaveBeenCalledWith('hello');
    });

    it('reuses existing terminal on subsequent feeds', () => {
      feedData('agent-1', 'a');
      feedData('agent-1', 'b');
      expect(mockWrite).toHaveBeenCalledTimes(2);
    });
  });

  describe('resize', () => {
    it('resizes existing terminal', () => {
      feedData('agent-r', 'data');
      resize('agent-r', 100, 50);
      expect(mockResize).toHaveBeenCalledWith(100, 50);
    });

    it('does nothing for unknown agent', () => {
      resize('unknown', 100, 50);
      expect(mockResize).not.toHaveBeenCalled();
    });
  });

  describe('serialize', () => {
    it('returns serialized content for existing terminal', () => {
      feedData('agent-s', 'data');
      mockSerialize.mockReturnValue('serialized content');
      const result = serialize('agent-s');
      expect(result).toBe('serialized content');
    });

    it('returns empty string for unknown agent', () => {
      expect(serialize('unknown')).toBe('');
    });
  });

  describe('dispose', () => {
    it('disposes terminal and removes session', () => {
      feedData('agent-d', 'data');
      dispose('agent-d');
      expect(mockDispose).toHaveBeenCalled();
      // After dispose, serialize should return empty
      expect(serialize('agent-d')).toBe('');
    });

    it('does nothing for unknown agent', () => {
      dispose('unknown');
      expect(mockDispose).not.toHaveBeenCalled();
    });
  });
});
