import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.38.0'), isPackaged: true },
}));

vi.mock('./auto-update-service', () => ({
  getSettings: vi.fn(() => ({ previewChannel: false })),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import { app } from 'electron';
import * as autoUpdateService from './auto-update-service';
import { isPreviewEligible } from './preview-eligible';

describe('isPreviewEligible', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (app as any).isPackaged = true;
    vi.mocked(app.getVersion).mockReturnValue('0.38.0');
    vi.mocked(autoUpdateService.getSettings).mockReturnValue({
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
    vi.mocked(autoUpdateService.getSettings).mockReturnValue({
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
});
