import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';

vi.mock('electron', () => ({ default: '/fake/electron' }));
vi.mock('fs', () => ({ existsSync: vi.fn() }));

import globalSetup from '../e2e/global-setup';

describe('E2E global setup', () => {
  it('prepares Electron even when there are no fixture folders', async () => {
    vi.mocked(fs.existsSync).mockImplementation((file) => file === '/fake/electron');
    await globalSetup();
    expect(fs.existsSync).toHaveBeenNthCalledWith(1, '/fake/electron');
    expect(fs.existsSync).toHaveBeenCalledTimes(2);
  });

  it('fails setup before any test runs when the executable is missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await expect(globalSetup()).rejects.toThrow('Electron preparation did not produce an executable');
    expect(fs.existsSync).toHaveBeenCalledOnce();
  });
});
