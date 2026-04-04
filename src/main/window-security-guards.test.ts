import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./navigation-guard', () => ({
  isAllowedNavigation: vi.fn((url: string) => {
    return url.startsWith('file://') || url.includes('localhost') || url.includes('127.0.0.1');
  }),
}));

vi.mock('./services/log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('./ipc/settings-handlers', () => ({
  securitySettings: { get: () => ({ allowLocalFileWebviews: false }) },
}));

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
}));

import { applyWindowSecurityGuards } from './window-security-guards';
import { appLog } from './services/log-service';

function createMockWindow() {
  const listeners: Record<string, Function> = {};
  let windowOpenHandler: Function | null = null;
  return {
    webContents: {
      on: vi.fn((event: string, handler: Function) => {
        listeners[event] = handler;
      }),
      setWindowOpenHandler: vi.fn((handler: Function) => {
        windowOpenHandler = handler;
      }),
    },
    _trigger(event: string, ...args: unknown[]) {
      return listeners[event]?.(...args);
    },
    _triggerWindowOpen(details: { url: string }) {
      return windowOpenHandler?.(details);
    },
  };
}

describe('applyWindowSecurityGuards', () => {
  let mockWin: ReturnType<typeof createMockWindow>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWin = createMockWindow();
    applyWindowSecurityGuards(mockWin as any);
  });

  it('registers all three guards', () => {
    expect(mockWin.webContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function));
    expect(mockWin.webContents.on).toHaveBeenCalledWith('will-attach-webview', expect.any(Function));
    expect(mockWin.webContents.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function));
  });

  describe('will-navigate', () => {
    it('blocks external URLs', () => {
      const event = { preventDefault: vi.fn() };
      mockWin._trigger('will-navigate', event, 'https://evil.com');
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('allows localhost URLs', () => {
      const event = { preventDefault: vi.fn() };
      mockWin._trigger('will-navigate', event, 'http://localhost:3000');
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('setWindowOpenHandler', () => {
    it('denies external URLs', () => {
      const result = mockWin._triggerWindowOpen({ url: 'https://evil.com' });
      expect(result).toEqual({ action: 'deny' });
    });
  });

  describe('will-attach-webview', () => {
    it('blocks javascript: URLs', () => {
      const event = { preventDefault: vi.fn() };
      const webPreferences: Record<string, unknown> = {};
      mockWin._trigger('will-attach-webview', event, webPreferences, { src: 'javascript:alert(1)' });
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('blocks data: URLs', () => {
      const event = { preventDefault: vi.fn() };
      const webPreferences: Record<string, unknown> = {};
      mockWin._trigger('will-attach-webview', event, webPreferences, { src: 'data:text/html,<h1>hi</h1>' });
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('allows http: URLs', () => {
      const event = { preventDefault: vi.fn() };
      const webPreferences: Record<string, unknown> = {};
      mockWin._trigger('will-attach-webview', event, webPreferences, { src: 'https://example.com' });
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('enforces secure webPreferences', () => {
      const event = { preventDefault: vi.fn() };
      const webPreferences: Record<string, unknown> = { nodeIntegration: true };
      mockWin._trigger('will-attach-webview', event, webPreferences, { src: 'https://example.com' });
      expect(webPreferences.nodeIntegration).toBe(false);
      expect(webPreferences.contextIsolation).toBe(true);
      expect(webPreferences.nodeIntegrationInSubFrames).toBe(false);
    });
  });
});
