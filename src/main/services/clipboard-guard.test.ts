import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReadImage = vi.fn();
const mockRead = vi.fn();
vi.mock('electron', () => ({
  clipboard: { read: (...args: unknown[]) => mockRead(...args) },
  nativeImage: { createFromBuffer: (...args: unknown[]) => mockReadImage(...args) },
}));

import { readImageSafe, notifyResume, _resetForTest, WAKE_COOLDOWN_MS } from './clipboard-guard';

describe('clipboard-guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTest();
    mockRead.mockResolvedValue([{ types: ['image/png'], getType: async () => new Blob(['png']) }]);
  });

  it('returns image data on successful read', async () => {
    const fakePng = Buffer.from('fake-png-data');
    mockReadImage.mockReturnValue({
      isEmpty: () => false,
      toPNG: () => fakePng,
    });

    const result = await readImageSafe();
    expect(result).toEqual({
      base64: fakePng.toString('base64'),
      mimeType: 'image/png',
    });
  });

  it('returns null when clipboard has no image', async () => {
    mockRead.mockResolvedValue([{ types: ['text/plain'] }]);

    const result = await readImageSafe();
    expect(result).toBeNull();
    expect(mockReadImage).not.toHaveBeenCalled();
  });

  it('prefers PNG across items and normalizes a JPEG-only clipboard to PNG', async () => {
    const jpeg = { types: ['image/jpeg'], getType: vi.fn(async () => new Blob(['jpeg'])) };
    const png = { types: ['image/png'], getType: vi.fn(async () => new Blob(['png'])) };
    mockReadImage.mockReturnValue({ isEmpty: () => false, toPNG: () => Buffer.from('normalized') });
    mockRead.mockResolvedValue([jpeg, png]);
    await readImageSafe();
    expect(png.getType).toHaveBeenCalledWith('image/png');
    expect(jpeg.getType).not.toHaveBeenCalled();
    mockRead.mockResolvedValue([jpeg]);
    expect(await readImageSafe()).toEqual({ base64: Buffer.from('normalized').toString('base64'), mimeType: 'image/png' });
    expect(jpeg.getType).toHaveBeenCalledWith('image/jpeg');
  });

  it('returns null on asynchronous pasteboard or payload rejection', async () => {
    mockRead.mockRejectedValue(new Error('pasteboard unavailable'));
    expect(await readImageSafe()).toBeNull();
    mockRead.mockResolvedValue([{ types: ['image/png'], getType: async () => { throw new Error('unavailable'); } }]);
    expect(await readImageSafe()).toBeNull();
  });

  it('returns null when native image decoding throws', async () => {
    mockReadImage.mockImplementation(() => {
      throw new Error('pasteboard error');
    });

    const result = await readImageSafe();
    expect(result).toBeNull();
  });

  it('returns null when image object is malformed', async () => {
    mockReadImage.mockReturnValue({
      isEmpty: () => false,
      toPNG: () => { throw new Error('encode failed'); },
    });

    const result = await readImageSafe();
    expect(result).toBeNull();
  });

  describe('wake cooldown', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns null immediately during wake cooldown', async () => {
      notifyResume();

      const result = await readImageSafe();

      expect(result).toBeNull();
      expect(mockRead).not.toHaveBeenCalled();
    });

    it('resumes normal operation after cooldown expires', async () => {
      const fakePng = Buffer.from('after-wake');
      mockReadImage.mockReturnValue({
        isEmpty: () => false,
        toPNG: () => fakePng,
      });

      notifyResume();
      vi.advanceTimersByTime(WAKE_COOLDOWN_MS + 1);

      const result = await readImageSafe();
      expect(result).toEqual({
        base64: fakePng.toString('base64'),
        mimeType: 'image/png',
      });
      expect(mockReadImage).toHaveBeenCalledOnce();
    });

    it('still in cooldown before window expires', async () => {
      notifyResume();
      vi.advanceTimersByTime(WAKE_COOLDOWN_MS - 1);

      const result = await readImageSafe();
      expect(result).toBeNull();
      expect(mockRead).not.toHaveBeenCalled();
    });

    it('second wake resets the cooldown timer', async () => {
      notifyResume();
      vi.advanceTimersByTime(3000);

      // Second wake resets — cooldown starts fresh
      notifyResume();
      vi.advanceTimersByTime(3000);

      // 3s after second wake — still in cooldown (5s window)
      const result = await readImageSafe();
      expect(result).toBeNull();
      expect(mockRead).not.toHaveBeenCalled();
    });

    it('works normally when no wake has occurred', async () => {
      mockReadImage.mockReturnValue({ isEmpty: () => true });

      const result = await readImageSafe();
      expect(result).toBeNull();
      expect(mockReadImage).toHaveBeenCalledOnce();
    });
  });
});
