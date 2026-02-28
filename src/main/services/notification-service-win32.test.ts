import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Windows-specific notification tests.
 *
 * These tests mock process.platform as 'win32' and use vi.resetModules()
 * to get a fresh module load with the Windows code path active.
 */

const { mockShow, mockClose, mockOn, mockIsSupported, mockGetPath, mockCreateFromPath, mockIsEmpty } = vi.hoisted(
  () => {
    return {
      mockShow: vi.fn(),
      mockClose: vi.fn(),
      mockOn: vi.fn(),
      mockIsSupported: vi.fn().mockReturnValue(true),
      mockGetPath: vi.fn().mockReturnValue('C:\\Program Files\\Clubhouse\\Clubhouse.exe'),
      mockCreateFromPath: vi.fn(),
      mockIsEmpty: vi.fn().mockReturnValue(false),
    };
  },
);

vi.mock('electron', () => {
  const instances: Array<{ opts: Record<string, unknown> }> = [];
  return {
    app: {
      getPath: mockGetPath,
    },
    nativeImage: {
      createFromPath: mockCreateFromPath,
    },
    Notification: class MockNotification {
      opts: Record<string, unknown>;
      show = mockShow;
      close = mockClose;
      on = mockOn;
      static isSupported = mockIsSupported;
      constructor(opts: Record<string, unknown>) {
        this.opts = opts;
        instances.push(this);
      }
    },
    BrowserWindow: {
      getAllWindows: vi.fn().mockReturnValue([]),
    },
    __instances: instances,
  };
});

vi.mock('./settings-store', () => ({
  createSettingsStore: vi.fn().mockReturnValue({
    get: vi.fn().mockReturnValue({}),
    save: vi.fn(),
  }),
}));

describe('notification-service (win32)', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.useFakeTimers();
    mockShow.mockClear();
    mockClose.mockClear();
    mockOn.mockClear();
    mockIsSupported.mockClear();
    mockIsSupported.mockReturnValue(true);
    mockGetPath.mockClear();
    mockGetPath.mockReturnValue('C:\\Program Files\\Clubhouse\\Clubhouse.exe');
    mockCreateFromPath.mockClear();
    mockIsEmpty.mockClear();
    mockIsEmpty.mockReturnValue(false);

    // Return a mock NativeImage that is not empty
    const fakeIcon = { isEmpty: mockIsEmpty, _isFakeIcon: true };
    mockCreateFromPath.mockReturnValue(fakeIcon);

    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('includes icon in Notification constructor on Windows', async () => {
    // Reset modules to get a fresh import with win32 platform
    vi.resetModules();
    const { sendNotification } = await import('./notification-service');
    const electron = await import('electron');
    const instances = (electron as unknown as { __instances: Array<{ opts: Record<string, unknown> }> }).__instances;
    instances.length = 0;

    sendNotification('Agent done', 'Your agent finished', false);

    expect(mockCreateFromPath).toHaveBeenCalledWith('C:\\Program Files\\Clubhouse\\Clubhouse.exe');
    expect(instances).toHaveLength(1);
    expect(instances[0].opts).toHaveProperty('icon');
    expect(instances[0].opts.icon).toHaveProperty('_isFakeIcon', true);
  });

  it('omits icon when nativeImage returns empty image', async () => {
    mockIsEmpty.mockReturnValue(true);
    mockCreateFromPath.mockReturnValue({ isEmpty: mockIsEmpty });

    vi.resetModules();
    const { sendNotification } = await import('./notification-service');
    const electron = await import('electron');
    const instances = (electron as unknown as { __instances: Array<{ opts: Record<string, unknown> }> }).__instances;
    instances.length = 0;

    sendNotification('Agent done', 'Your agent finished', false);

    expect(instances).toHaveLength(1);
    expect(instances[0].opts).not.toHaveProperty('icon');
  });

  it('omits icon gracefully when createFromPath throws', async () => {
    mockCreateFromPath.mockImplementation(() => {
      throw new Error('icon not found');
    });

    vi.resetModules();
    const { sendNotification } = await import('./notification-service');
    const electron = await import('electron');
    const instances = (electron as unknown as { __instances: Array<{ opts: Record<string, unknown> }> }).__instances;
    instances.length = 0;

    sendNotification('Agent done', 'Your agent finished', false);

    expect(instances).toHaveLength(1);
    expect(instances[0].opts).not.toHaveProperty('icon');
  });

  it('caches the icon after first resolution', async () => {
    vi.resetModules();
    const { sendNotification } = await import('./notification-service');
    const electron = await import('electron');
    const instances = (electron as unknown as { __instances: Array<{ opts: Record<string, unknown> }> }).__instances;
    instances.length = 0;

    sendNotification('First', 'Body', false);
    sendNotification('Second', 'Body', false);

    // createFromPath should only be called once (cached after first call)
    expect(mockCreateFromPath).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(2);
    // Both notifications should have the icon
    expect(instances[0].opts).toHaveProperty('icon');
    expect(instances[1].opts).toHaveProperty('icon');
  });
});
