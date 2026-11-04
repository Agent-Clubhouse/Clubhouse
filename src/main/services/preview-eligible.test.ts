import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.38.0'), isPackaged: true },
}));

vi.mock('./update-settings', () => ({
  getSettings: vi.fn(() => ({ previewChannel: false })),
}));

import { app } from 'electron';
import * as updateSettings from './update-settings';
import { isPreviewEligible } from './preview-eligible';

describe('isPreviewEligible', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (app as any).isPackaged = true;
    vi.mocked(app.getVersion).mockReturnValue('0.38.0');
    vi.mocked(updateSettings.getSettings).mockReturnValue({
      previewChannel: false,
      autoUpdate: true,
      lastCheck: null,
      dismissedVersion: null,
      lastSeenVersion: null,
    });
  });

  it('returns true for unpackaged (dev) builds', () => {
    (app as any).isPackaged = false;
    expect(isPreviewEligible()).toBe(true);
  });

  it('returns true for beta version', () => {
    vi.mocked(app.getVersion).mockReturnValue('0.38.0-beta.1');
    expect(isPreviewEligible()).toBe(true);
  });

  it('returns true for rc version', () => {
    vi.mocked(app.getVersion).mockReturnValue('0.38.0-rc.1');
    expect(isPreviewEligible()).toBe(true);
  });

  it('returns true for alpha version', () => {
    vi.mocked(app.getVersion).mockReturnValue('0.38.0-alpha.1');
    expect(isPreviewEligible()).toBe(true);
  });

  it('returns true for dev version', () => {
    vi.mocked(app.getVersion).mockReturnValue('0.38.0-dev');
    expect(isPreviewEligible()).toBe(true);
  });

  it('returns true for canary version', () => {
    vi.mocked(app.getVersion).mockReturnValue('0.38.0-canary.42');
    expect(isPreviewEligible()).toBe(true);
  });

  it('returns true when previewChannel is enabled', () => {
    vi.mocked(updateSettings.getSettings).mockReturnValue({
      previewChannel: true,
      autoUpdate: true,
      lastCheck: null,
      dismissedVersion: null,
      lastSeenVersion: null,
    });
    expect(isPreviewEligible()).toBe(true);
  });

  it('returns false for stable packaged build without preview channel', () => {
    expect(isPreviewEligible()).toBe(false);
  });

  it.each([
    ['0.42.0', false],
    ['0.42.0-beta.14', true],
    ['0.42.0-rc.1', true],
    ['0.42.0-alpha.1', true],
    ['0.42.0-dev.1', true],
    ['0.42.0-canary.1', true],
    // Not a preview version: the legacy rc form has no hyphen, and the unsigned CI artifact is its own suffix.
    ['0.42.0rc', false],
    ['0.0.0-integration.123.1', false],
  ])('a packaged %s with Preview off is eligible: %s', (version, eligible) => {
    vi.mocked(app.getVersion).mockReturnValue(version);
    expect(isPreviewEligible()).toBe(eligible);
  });

  it('a packaged stable version stays eligible with the explicit Preview opt-in', () => {
    vi.mocked(app.getVersion).mockReturnValue('0.42.0');
    vi.mocked(updateSettings.getSettings).mockReturnValue({
      previewChannel: true,
      autoUpdate: true,
      lastCheck: null,
      dismissedVersion: null,
      lastSeenVersion: null,
    });
    expect(isPreviewEligible()).toBe(true);
  });

  describe('the CLUBHOUSE_TEST_STABLE_BUILD seam', () => {
    const SEAM = 'CLUBHOUSE_TEST_STABLE_BUILD';
    const withPreview = (previewChannel: boolean) => vi.mocked(updateSettings.getSettings).mockReturnValue({
      previewChannel,
      autoUpdate: true,
      lastCheck: null,
      dismissedVersion: null,
      lastSeenVersion: null,
    });

    afterEach(() => vi.unstubAllEnvs());

    it('makes an unpackaged build follow the Preview opt-in', () => {
      (app as any).isPackaged = false;
      vi.stubEnv(SEAM, '1');
      withPreview(false);
      expect(isPreviewEligible()).toBe(false);
      withPreview(true);
      expect(isPreviewEligible()).toBe(true);
    });

    it.each(['0', 'true', ''])('leaves an unpackaged build eligible when set to %j', (value) => {
      (app as any).isPackaged = false;
      vi.stubEnv(SEAM, value);
      expect(isPreviewEligible()).toBe(true);
    });

    it.each([
      ['0.42.0', false],
      ['0.42.0', true],
      ['0.42.0-beta.14', false],
      ['0.42.0-beta.14', true],
    ])('a packaged %s with Preview %s answers the same with it set', (version, preview) => {
      vi.mocked(app.getVersion).mockReturnValue(version);
      withPreview(preview);
      vi.stubEnv(SEAM, undefined as unknown as string);
      const without = isPreviewEligible();
      vi.stubEnv(SEAM, '1');
      expect(isPreviewEligible()).toBe(without);
    });

    it('turns no packaged beta into a stable build', () => {
      vi.mocked(app.getVersion).mockReturnValue('0.42.0-beta.14');
      vi.stubEnv(SEAM, '1');
      expect(isPreviewEligible()).toBe(true);
    });

    it('is not read at all in a packaged build', () => {
      const env = new Proxy({ ...process.env }, {
        get(target, key) {
          if (key === SEAM) throw new Error('a packaged build read the seam');
          return target[key as string];
        },
      });
      vi.stubGlobal('process', { ...process, env });
      try {
        vi.mocked(app.getVersion).mockReturnValue('0.42.0');
        expect(isPreviewEligible()).toBe(false);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('is read in one place in the app, so nothing else can act on it', () => {
      const root = path.resolve(__dirname, '../..');
      const readers: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes(SEAM)) readers.push(path.relative(root, full));
        }
      };
      walk(root);
      expect(readers).toEqual([path.join('main', 'services', 'preview-eligible.ts')]);
    });
  });
});
