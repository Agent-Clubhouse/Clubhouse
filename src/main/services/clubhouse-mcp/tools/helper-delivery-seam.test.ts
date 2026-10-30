import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ app: { isPackaged: false } }));
vi.mock('electron', () => electron);
vi.mock('./helper-delivery', () => ({ deliverHelperUpdate: vi.fn() }));

import { deliverHelperUpdate } from './helper-delivery';
import { HELPER_SEAM_GLOBAL, installHelperDeliverySeam } from './helper-delivery-seam';

const seam = () => (globalThis as Record<string, unknown>)[HELPER_SEAM_GLOBAL];

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HELPER_SEAM_GLOBAL];
  delete process.env.CLUBHOUSE_TEST_HELPER_SEAM;
  electron.app.isPackaged = false;
});

describe('installHelperDeliverySeam', () => {
  it('exposes the real helper delivery when unpackaged and asked for', () => {
    process.env.CLUBHOUSE_TEST_HELPER_SEAM = '1';
    installHelperDeliverySeam();
    expect(seam()).toBe(deliverHelperUpdate);
  });

  it('does nothing in a packaged build, even when asked', () => {
    process.env.CLUBHOUSE_TEST_HELPER_SEAM = '1';
    electron.app.isPackaged = true;
    installHelperDeliverySeam();
    expect(seam()).toBeUndefined();
  });

  it('does nothing unless asked', () => {
    installHelperDeliverySeam();
    expect(seam()).toBeUndefined();
  });
});
