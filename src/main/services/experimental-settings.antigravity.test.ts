import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-app' },
}));

const previewEligible = vi.hoisted(() => ({ value: true }));
vi.mock('./preview-eligible', () => ({ isPreviewEligible: () => previewEligible.value }));

const saved = vi.hoisted(() => ({ text: '{}' }));
vi.mock('fs', async () => {
  const { atomicFsPromises } = await import('../../../test/atomic-fs-mock');
  const writeFile = vi.fn(async () => {});
  return {
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => saved.text),
    promises: {
      ...atomicFsPromises(writeFile),
      writeFile,
    },
  };
});

import { resetAllSettingsStoresForTests } from './settings-store';
import { getSettings, getStoredSettings } from './experimental-settings';
import { ANTIGRAVITY_EXPERIMENTAL_FLAG } from '../../shared/providers/antigravity';

/**
 * The Antigravity provider registers only when this flag reads true from
 * getSettings() at startup (ipc/index.ts). The flag is preview-only.
 */
describe('the Antigravity experimental flag', () => {
  beforeEach(() => {
    resetAllSettingsStoresForTests();
  });

  it('is off when never saved', () => {
    saved.text = '{}';
    previewEligible.value = true;
    expect(getSettings()[ANTIGRAVITY_EXPERIMENTAL_FLAG]).toBeUndefined();
  });

  it('is on in a preview-eligible build when saved on', () => {
    saved.text = JSON.stringify({ [ANTIGRAVITY_EXPERIMENTAL_FLAG]: true });
    previewEligible.value = true;
    expect(getSettings()[ANTIGRAVITY_EXPERIMENTAL_FLAG]).toBe(true);
  });

  it('reads as off in a stable build even when saved on, and the saved value is kept', () => {
    saved.text = JSON.stringify({ [ANTIGRAVITY_EXPERIMENTAL_FLAG]: true });
    previewEligible.value = false;
    expect(getSettings()[ANTIGRAVITY_EXPERIMENTAL_FLAG]).toBeUndefined();
    expect(getStoredSettings()[ANTIGRAVITY_EXPERIMENTAL_FLAG]).toBe(true);
  });
});
