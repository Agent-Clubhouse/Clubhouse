import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./services/log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('./ipc/settings-handlers', () => ({
  securitySettings: { getSettings: vi.fn(() => ({ allowLocalFileWebviews: false })) },
}));

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
}));

import { shell } from 'electron';
import { securitySettings } from './ipc/settings-handlers';
import { appLog } from './services/log-service';
import { applyWindowSecurityGuards } from './window-security-guards';

type Listener = (...args: unknown[]) => unknown;
type WindowOpenHandler = (details: { url: string }) => unknown;

function createMockWindow() {
  const listeners: Record<string, Listener> = {};
  let windowOpenHandler: WindowOpenHandler | null = null;
  return {
    webContents: {
      on: vi.fn((event: string, handler: Listener) => {
        listeners[event] = handler;
      }),
      setWindowOpenHandler: vi.fn((handler: WindowOpenHandler) => {
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

const ENTRY = 'file:///Applications/Clubhouse.app/Contents/Resources/app.asar/.webpack/renderer/main_window/index.html';

describe('applyWindowSecurityGuards', () => {
  let mockWin: ReturnType<typeof createMockWindow>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWin = createMockWindow();
    applyWindowSecurityGuards(mockWin as any, ENTRY);
  });

  it('registers all three guards', () => {
    expect(mockWin.webContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function));
    expect(mockWin.webContents.on).toHaveBeenCalledWith('will-redirect', expect.any(Function));
    expect(mockWin.webContents.on).toHaveBeenCalledWith('will-attach-webview', expect.any(Function));
    expect(mockWin.webContents.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function));
  });

  describe('will-navigate (#3881)', () => {
    function navigate(url: string) {
      const event = { preventDefault: vi.fn() };
      mockWin._trigger('will-navigate', event, url);
      return event;
    }

    it('lets the app page navigate to itself', () => {
      expect(navigate(`${ENTRY}?popout=1#/agents`).preventDefault).not.toHaveBeenCalled();
      expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it.each([
      'file:///Users/someone/Downloads/dropped.html',
      'file:///Users/someone/Desktop/photo.png',
      'data:text/html,<script>window.clubhouse</script>',
      'javascript:alert(1)',
    ])('blocks %s without opening it anywhere', (url) => {
      expect(navigate(url).preventDefault).toHaveBeenCalled();
      expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it.each(['https://example.com/docs', 'http://example.com/', 'http://localhost:3000', 'http://127.0.0.1:8080/', 'mailto:someone@example.com'])('blocks %s in the app window and opens it externally', (url) => {
      expect(navigate(url).preventDefault).toHaveBeenCalled();
      expect(shell.openExternal).toHaveBeenCalledWith(url);
    });

    it('does not log local file paths', () => {
      navigate('file:///Users/someone/secret/plan.html');
      expect(JSON.stringify(vi.mocked(appLog).mock.calls)).not.toContain('secret');
    });
  });

  describe('will-redirect (#3881)', () => {
    it('blocks a redirect away from the app page and does not open it', () => {
      const event = { preventDefault: vi.fn() };
      mockWin._trigger('will-redirect', event, 'https://evil.example/');
      expect(event.preventDefault).toHaveBeenCalled();
      expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it('allows a redirect to the app page', () => {
      const event = { preventDefault: vi.fn() };
      mockWin._trigger('will-redirect', event, ENTRY);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('setWindowOpenHandler', () => {
    it('denies web links as windows and opens them externally', () => {
      const result = mockWin._triggerWindowOpen({ url: 'https://example.com/page' });
      expect(result).toEqual({ action: 'deny' });
      expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/page');
    });

    it.each([
      'file:///app/index.html',
      'file:///tmp/plugins/untrusted/page.html',
      'javascript:alert(1)',
      'about:blank',
    ])('does not give renderer-created %s a privileged preload or open it', (url) => {
      expect(mockWin._triggerWindowOpen({ url })).toEqual({ action: 'deny' });
      expect(shell.openExternal).not.toHaveBeenCalled();
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

    it('allows file: URLs when local file webviews are enabled', () => {
      const event = { preventDefault: vi.fn() };
      const webPreferences: Record<string, unknown> = {};
      vi.mocked(securitySettings.getSettings).mockReturnValue({ allowLocalFileWebviews: true });
      mockWin._trigger('will-attach-webview', event, webPreferences, { src: 'file:///tmp/test.html' });
      expect(event.preventDefault).not.toHaveBeenCalled();
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
