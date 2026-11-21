import { describe, expect, it, vi } from 'vitest';
import { NoticeDirectoryFlusher, noticeDirectorySyncUnsupported } from './durability';

describe('notice directory durability observation', () => {
  it('records only an actually observed directory sync and closes the handle', async () => {
    const sync = vi.fn(async () => {}); const close = vi.fn(async () => {});
    const flusher = new NoticeDirectoryFlusher('darwin', async () => ({ sync, close }));
    expect(flusher.observation).toBe('not-observed');
    await flusher.flush('/synthetic');
    expect(flusher.observation).toBe('directory-synced');
    expect(sync).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
  });
  it.each(['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'])('reports file-sync-only for known Windows directory result %s', async (code) => {
    const flusher = new NoticeDirectoryFlusher('win32', async () => { throw Object.assign(new Error('synthetic'), { code }); });
    await flusher.flush('/synthetic');
    expect(flusher.observation).toBe('file-sync-only');
    expect(noticeDirectorySyncUnsupported('darwin', { code })).toBe(false);
  });
  it.each(['EIO', 'ENOSPC', 'EACCES', 'ENOENT'])('propagates actual IO/space/access errors %s on Windows', async (code) => {
    const error = Object.assign(new Error('synthetic'), { code });
    const flusher = new NoticeDirectoryFlusher('win32', async () => { throw error; });
    await expect(flusher.flush('/synthetic')).rejects.toBe(error);
    expect(flusher.observation).toBe('not-observed');
  });
  it('does not retroactively promote a weaker earlier observation after later successful flushes', async () => {
    let call = 0;
    const flusher = new NoticeDirectoryFlusher('win32', async () => {
      if (++call === 1) throw Object.assign(new Error('synthetic'), { code: 'EINVAL' });
      return { sync: async () => {}, close: async () => {} };
    });
    await flusher.flush('/first'); await flusher.flush('/second');
    expect(flusher.observation).toBe('file-sync-only');
    expect(noticeDirectorySyncUnsupported('win32', undefined)).toBe(false);
  });
  it('propagates sync and close failures rather than manufacturing a successful store commit', async () => {
    const close = vi.fn(async () => {});
    const error = Object.assign(new Error('synthetic'), { code: 'EIO' });
    const flusher = new NoticeDirectoryFlusher('darwin', async () => ({ sync: async () => { throw error; }, close }));
    await expect(flusher.flush('/synthetic')).rejects.toBe(error);
    expect(close).toHaveBeenCalledTimes(1);
    const closeFailure = new NoticeDirectoryFlusher('darwin', async () => ({ sync: async () => {}, close: async () => { throw error; } }));
    await expect(closeFailure.flush('/synthetic')).rejects.toBe(error);
  });
});
