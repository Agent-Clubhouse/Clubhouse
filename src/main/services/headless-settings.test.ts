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
import { getSpawnMode, setProjectSpawnMode, getSettings, saveSettings } from './headless-settings';

describe('headless-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSettingsStoresForTests();
  });

  // ============================================================
  // getSpawnMode
  // ============================================================
  describe('getSpawnMode', () => {
    it('returns interactive when global disabled and no project override', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: false }));
      expect(getSpawnMode('/some/project')).toBe('interactive');
    });

    it('returns headless when global enabled and no project override', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: true }));
      expect(getSpawnMode('/some/project')).toBe('headless');
    });

    it('returns project override when present, regardless of global', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: false,
        projectOverrides: { '/my/project': 'headless' },
      }));
      expect(getSpawnMode('/my/project')).toBe('headless');
    });

    it('project override interactive overrides global enabled', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: true,
        projectOverrides: { '/my/project': 'interactive' },
      }));
      expect(getSpawnMode('/my/project')).toBe('interactive');
    });

    it('falls back to global when project has no override', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: true,
        projectOverrides: { '/other/project': 'interactive' },
      }));
      expect(getSpawnMode('/my/project')).toBe('headless');
    });

    it('handles undefined projectPath by using global default', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: true }));
      expect(getSpawnMode()).toBe('headless');
      expect(getSpawnMode(undefined)).toBe('headless');
    });

    it('handles old-format settings (no projectOverrides) gracefully', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: true }));
      expect(getSpawnMode('/any/project')).toBe('headless');
    });

    it('handles empty projectOverrides object', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: false,
        projectOverrides: {},
      }));
      expect(getSpawnMode('/project')).toBe('interactive');
    });

    it('returns headless when settings file does not exist (default)', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(getSpawnMode('/project')).toBe('headless');
    });

    it('handles multiple project overrides independently', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: false,
        projectOverrides: {
          '/project-a': 'headless',
          '/project-b': 'interactive',
          '/project-c': 'headless',
        },
      }));
      expect(getSpawnMode('/project-a')).toBe('headless');
      expect(getSpawnMode('/project-b')).toBe('interactive');
      expect(getSpawnMode('/project-c')).toBe('headless');
      expect(getSpawnMode('/project-d')).toBe('interactive'); // no override → global (enabled: false)
    });

    it('returns defaultMode when set', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ defaultMode: 'structured' }));
      expect(getSpawnMode('/project')).toBe('structured');
    });

    it('defaultMode takes precedence over legacy enabled', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: true,
        defaultMode: 'structured',
      }));
      expect(getSpawnMode('/project')).toBe('structured');
    });

    it('project override structured overrides global headless', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaultMode: 'headless',
        projectOverrides: { '/my/project': 'structured' },
      }));
      expect(getSpawnMode('/my/project')).toBe('structured');
    });

    it('handles mixed modes across projects', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaultMode: 'interactive',
        projectOverrides: {
          '/project-a': 'headless',
          '/project-b': 'structured',
        },
      }));
      expect(getSpawnMode('/project-a')).toBe('headless');
      expect(getSpawnMode('/project-b')).toBe('structured');
      expect(getSpawnMode('/project-c')).toBe('interactive'); // global default
    });
  });

  // ============================================================
  // setProjectSpawnMode
  // ============================================================
  describe('setProjectSpawnMode', () => {
    it('saves project override while preserving existing settings', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: true,
        projectOverrides: { '/existing': 'interactive' },
      }));

      await setProjectSpawnMode('/new-project', 'headless');

      expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.enabled).toBe(true);
      expect(written.projectOverrides).toEqual({
        '/existing': 'interactive',
        '/new-project': 'headless',
      });
    });

    it('overwrites existing override for same project', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: false,
        projectOverrides: { '/project': 'headless' },
      }));

      await setProjectSpawnMode('/project', 'interactive');

      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.projectOverrides['/project']).toBe('interactive');
    });

    it('creates projectOverrides when old-format settings had none', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: true }));

      await setProjectSpawnMode('/project', 'interactive');

      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.projectOverrides).toEqual({ '/project': 'interactive' });
    });
  });

  // ============================================================
  // getSettings backward compat
  // ============================================================
  describe('getSettings backward compat', () => {
    it('loads old format with only enabled field', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: true }));
      const settings = getSettings();
      expect(settings.enabled).toBe(true);
      expect(settings.projectOverrides).toBeUndefined();
    });

    it('loads new format with projectOverrides', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: false,
        projectOverrides: { '/p': 'headless' },
      }));
      const settings = getSettings();
      expect(settings.enabled).toBe(false);
      expect(settings.projectOverrides).toEqual({ '/p': 'headless' });
    });

    it('returns defaults when file does not exist', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const settings = getSettings();
      expect(settings.enabled).toBe(true);
    });

    it('returns defaults when file contains invalid JSON', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not json');
      const settings = getSettings();
      expect(settings.enabled).toBe(true);
    });
  });

  // ============================================================
  // saveSettings
  // ============================================================
  describe('saveSettings', () => {
    it('writes settings as JSON to correct path', async () => {
      await saveSettings({ enabled: true, projectOverrides: { '/p': 'headless' } });

      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('headless-settings.json'),
        expect.any(String),
        'utf-8'
      );
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.enabled).toBe(true);
      expect(written.projectOverrides).toEqual({ '/p': 'headless' });
    });
  });
});
