import { describe, it, expect, beforeEach, vi } from 'vitest';

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
});
