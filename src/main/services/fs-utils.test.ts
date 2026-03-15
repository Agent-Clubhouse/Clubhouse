import { describe, it, expect, vi } from 'vitest';
import { pathExists } from './fs-utils';
import { access } from 'fs/promises';

vi.mock('fs/promises');

describe('pathExists', () => {
  it('returns true when path exists', async () => {
    vi.mocked(access).mockResolvedValue(undefined);
    expect(await pathExists('/some/path')).toBe(true);
  });

  it('returns false when path does not exist', async () => {
    vi.mocked(access).mockRejectedValue(new Error('ENOENT'));
    expect(await pathExists('/missing/path')).toBe(false);
  });
});
