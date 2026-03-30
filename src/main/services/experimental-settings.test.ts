import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-app' },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  promises: {
    writeFile: vi.fn(async () => {}),
  },
}));

import * as fs from 'fs';
import { resetAllSettingsStoresForTests } from './settings-store';
import { getSettings, cleanupStaleFlags } from './experimental-settings';

describe('experimental-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSettingsStoresForTests();
  });

  describe('cleanupStaleFlags', () => {
    it('removes stale annex flag from persisted settings', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ annex: true, sessions: true }),
      );
      await cleanupStaleFlags();
      expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalledTimes(1);
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.annex).toBeUndefined();
      expect(written.sessions).toBe(true);
    });

    it('removes stale annex flag even when set to false', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ annex: false, themeGradients: true }),
      );
      await cleanupStaleFlags();
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.annex).toBeUndefined();
      expect(written.themeGradients).toBe(true);
    });

    it('does not save when no stale flags are present', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ sessions: true, themeGradients: false }),
      );
      await cleanupStaleFlags();
      expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
    });

    it('does not save when settings are empty', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      await cleanupStaleFlags();
      expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
    });
  });
});
