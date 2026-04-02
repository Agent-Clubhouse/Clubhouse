import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReadImage = vi.fn();
vi.mock('electron', () => ({
  clipboard: { readImage: (...args: unknown[]) => mockReadImage(...args) },
}));

import { readImageSafe, notifyResume, _resetForTest, WAKE_COOLDOWN_MS } from './clipboard-guard';

describe('clipboard-guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTest();
  });

  it('returns image data on successful read', () => {
    const fakePng = Buffer.from('fake-png-data');
    mockReadImage.mockReturnValue({
      isEmpty: () => false,
      toPNG: () => fakePng,
    });

    const result = readImageSafe();
    expect(result).toEqual({
      base64: fakePng.toString('base64'),
      mimeType: 'image/png',
    });
  });

  it('returns null when clipboard has no image', () => {
    mockReadImage.mockReturnValue({ isEmpty: () => true });

    const result = readImageSafe();
    expect(result).toBeNull();
  });

  it('returns null when clipboard.readImage throws', () => {
    mockReadImage.mockImplementation(() => {
      throw new Error('pasteboard error');
    });

    const result = readImageSafe();
    expect(result).toBeNull();
  });

  it('returns null when image object is malformed', () => {
    mockReadImage.mockReturnValue({
      isEmpty: () => false,
      toPNG: () => { throw new Error('encode failed'); },
    });

    const result = readImageSafe();
    expect(result).toBeNull();
  });

  describe('wake cooldown', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns null immediately during wake cooldown', () => {
      notifyResume();

      const result = readImageSafe();

      expect(result).toBeNull();
      expect(mockReadImage).not.toHaveBeenCalled();
    });

    it('resumes normal operation after cooldown expires', () => {
      const fakePng = Buffer.from('after-wake');
      mockReadImage.mockReturnValue({
        isEmpty: () => false,
        toPNG: () => fakePng,
      });

      notifyResume();
      vi.advanceTimersByTime(WAKE_COOLDOWN_MS + 1);

      const result = readImageSafe();
      expect(result).toEqual({
        base64: fakePng.toString('base64'),
        mimeType: 'image/png',
      });
      expect(mockReadImage).toHaveBeenCalledOnce();
    });

    it('still in cooldown before window expires', () => {
      notifyResume();
      vi.advanceTimersByTime(WAKE_COOLDOWN_MS - 1);

      const result = readImageSafe();
      expect(result).toBeNull();
      expect(mockReadImage).not.toHaveBeenCalled();
    });

    it('second wake resets the cooldown timer', () => {
      notifyResume();
      vi.advanceTimersByTime(3000);

      // Second wake resets — cooldown starts fresh
      notifyResume();
      vi.advanceTimersByTime(3000);

      // 3s after second wake — still in cooldown (5s window)
      const result = readImageSafe();
      expect(result).toBeNull();
      expect(mockReadImage).not.toHaveBeenCalled();
    });

    it('works normally when no wake has occurred', () => {
      mockReadImage.mockReturnValue({ isEmpty: () => true });

      const result = readImageSafe();
      expect(result).toBeNull();
      expect(mockReadImage).toHaveBeenCalledOnce();
    });
  });
});
