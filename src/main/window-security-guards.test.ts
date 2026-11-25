import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./navigation-guard', () => ({
  isAllowedNavigation: vi.fn((url: string) => {
    return url.startsWith('file://') || url.includes('localhost') || url.includes('127.0.0.1');
  }),
}));

vi.mock('./services/log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('./browser-file-access', () => ({
  BROWSER_FILE_SETTING_LOCATION: 'Settings > Plugins > Browser > Allow file:// URLs',
  isBrowserFileAccessAllowed: vi.fn(() => false),
}));

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
}));

import { isBrowserFileAccessAllowed } from './browser-file-access';
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

const BROWSER = 'persist:plugin-browser';

describe('applyWindowSecurityGuards', () => {
  let mockWin: ReturnType<typeof createMockWindow>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isBrowserFileAccessAllowed).mockReturnValue(false);
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

    it.each([
      'file:///app/index.html',
      'file:///tmp/plugins/untrusted/page.html',
      'http://localhost:3000/page',
      'http://127.0.0.1:8080/page',
      'about:blank',
    ])('does not give renderer-created %s a privileged preload', (url) => {
      expect(mockWin._triggerWindowOpen({ url })).toEqual({ action: 'deny' });
    });
  });

  describe('will-attach-webview', () => {
    it('blocks javascript: URLs', () => {
      const event = { preventDefault: vi.fn() };
      const webPreferences: Record<string, unknown> = {};
      mockWin._trigger('will-attach-webview', event, webPreferences, { partition: BROWSER, src: 'javascript:alert(1)' });
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('blocks data: URLs', () => {
      const event = { preventDefault: vi.fn() };
      const webPreferences: Record<string, unknown> = {};
      mockWin._trigger('will-attach-webview', event, webPreferences, { partition: BROWSER, src: 'data:text/html,<h1>hi</h1>' });
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('allows file: URLs when local file webviews are enabled', () => {
      const event = { preventDefault: vi.fn() };
      const webPreferences: Record<string, unknown> = {};
      vi.mocked(isBrowserFileAccessAllowed).mockReturnValue(true);
      mockWin._trigger('will-attach-webview', event, webPreferences, { partition: BROWSER, src: 'file:///tmp/test.html' });
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('allows http: URLs', () => {
      const event = { preventDefault: vi.fn() };
      const webPreferences: Record<string, unknown> = {};
      mockWin._trigger('will-attach-webview', event, webPreferences, { partition: BROWSER, src: 'https://example.com' });
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('enforces secure webPreferences', () => {
      const event = { preventDefault: vi.fn() };
      const webPreferences: Record<string, unknown> = { nodeIntegration: true };
      mockWin._trigger('will-attach-webview', event, webPreferences, { partition: BROWSER, src: 'https://example.com' });
      expect(webPreferences.nodeIntegration).toBe(false);
      expect(webPreferences.contextIsolation).toBe(true);
      expect(webPreferences.nodeIntegrationInSubFrames).toBe(false);
    });
  });

  describe('will-attach-webview hardening (#3869)', () => {
    it('overrides unsafe webPreferences and strips any preload', () => {
      const event = { preventDefault: vi.fn() };
      const webPreferences: Record<string, unknown> = {
        nodeIntegration: true,
        nodeIntegrationInSubFrames: true,
        nodeIntegrationInWorker: true,
        contextIsolation: false,
        sandbox: false,
        webSecurity: false,
        allowRunningInsecureContent: true,
        preload: '/tmp/evil-preload.js',
        preloadURL: 'file:///tmp/evil-preload.js',
      };
      mockWin._trigger('will-attach-webview', event, webPreferences, { partition: BROWSER, src: 'https://example.com' });
      expect(webPreferences).toEqual({
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
      });
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('hardens preferences even when the webview is then blocked', () => {
      const event = { preventDefault: vi.fn() };
      const webPreferences: Record<string, unknown> = { sandbox: false, preload: '/tmp/p.js' };
      mockWin._trigger('will-attach-webview', event, webPreferences, { partition: BROWSER, src: 'chrome://settings' });
      expect(event.preventDefault).toHaveBeenCalled();
      expect(webPreferences.sandbox).toBe(true);
      expect(webPreferences).not.toHaveProperty('preload');
    });

    it('blocks file: URLs by default and names the real setting', () => {
      const event = { preventDefault: vi.fn() };
      mockWin._trigger('will-attach-webview', event, {}, { partition: BROWSER, src: 'file:///tmp/test.html' });
      expect(event.preventDefault).toHaveBeenCalled();
      const message = vi.mocked(appLog).mock.calls.map((c) => String(c[2])).join('\n');
      expect(message).toContain('Settings > Plugins > Browser > Allow file:// URLs');
      expect(message).not.toContain('Settings > Security');
    });

    it('logs only the protocol and host of a blocked URL, never its path or query', () => {
      mockWin._trigger('will-attach-webview', { preventDefault: vi.fn() }, {}, { partition: BROWSER, src: 'file:///Users/someone/secret/plan.html?token=abc' });
      mockWin._trigger('will-attach-webview', { preventDefault: vi.fn() }, {}, { partition: BROWSER, src: 'chrome://settings/passwords?q=bank' });
      const logged = JSON.stringify(vi.mocked(appLog).mock.calls);
      expect(logged).not.toContain('secret');
      expect(logged).not.toContain('token');
      expect(logged).not.toContain('bank');
      expect(logged).toContain('"protocol":"file:"');
      expect(logged).toContain('"host":"settings"');
    });

    it.each(['about:blank', 'about:blank#top'])('allows %s as a first page', (src) => {
      const event = { preventDefault: vi.fn() };
      mockWin._trigger('will-attach-webview', event, {}, { partition: BROWSER, src });
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('blocks other about: pages as a first page', () => {
      const event = { preventDefault: vi.fn() };
      mockWin._trigger('will-attach-webview', event, {}, { partition: BROWSER, src: 'about:srcdoc' });
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('forces webviewTag off so a guest cannot nest its own unguarded webview', () => {
      const webPreferences: Record<string, unknown> = { webviewTag: true };
      mockWin._trigger('will-attach-webview', { preventDefault: vi.fn() }, webPreferences, { partition: BROWSER, src: 'https://example.com' });
      expect(webPreferences.webviewTag).toBe(false);
    });

    it.each([undefined, '', 'persist:other', 'default'])('refuses a webview outside the Browser session (partition %s)', (partition) => {
      const event = { preventDefault: vi.fn() };
      const params: Record<string, unknown> = { src: 'https://example.com' };
      if (partition !== undefined) params.partition = partition;
      mockWin._trigger('will-attach-webview', event, {}, params);
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('registers a guest guard on did-attach-webview', () => {
      expect(mockWin.webContents.on).toHaveBeenCalledWith('did-attach-webview', expect.any(Function));
    });
  });

  describe('webview guest guards (#3869)', () => {
    function attachGuest() {
      const guest = createMockWindow().webContents as ReturnType<typeof createMockWindow>['webContents'] & {
        _listeners?: Record<string, Listener>;
      };
      const listeners: Record<string, Listener> = {};
      let openHandler: WindowOpenHandler | null = null;
      guest.on = vi.fn((event: string, handler: Listener) => { listeners[event] = handler; }) as never;
      guest.setWindowOpenHandler = vi.fn((handler: WindowOpenHandler) => { openHandler = handler; }) as never;
      (guest as unknown as { stop: () => void }).stop = vi.fn();
      mockWin._trigger('did-attach-webview', {}, guest);
      return {
        guest,
        fire(name: string, details: { url: string; isMainFrame?: boolean }) {
          const event = { preventDefault: vi.fn(), ...details };
          listeners[name]?.(event, details.url, false, details.isMainFrame ?? true);
          return event;
        },
        open(url: string) {
          return openHandler?.({ url });
        },
      };
    }

    it('hooks will-navigate, will-frame-navigate, will-redirect and the window-open handler', () => {
      const { guest } = attachGuest();
      expect(guest.on).toHaveBeenCalledWith('will-navigate', expect.any(Function));
      expect(guest.on).toHaveBeenCalledWith('will-frame-navigate', expect.any(Function));
      expect(guest.on).toHaveBeenCalledWith('will-redirect', expect.any(Function));
      expect(guest.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function));
    });

    it.each(['https://example.com/next', 'http://localhost:3000/', 'http://example.com/', 'blob:https://example.com/7d1c'])('allows navigation to %s', (url) => {
      const { fire } = attachGuest();
      expect(fire('will-navigate', { url }).preventDefault).not.toHaveBeenCalled();
      expect(fire('will-redirect', { url }).preventDefault).not.toHaveBeenCalled();
    });

    it.each([
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'clubhouse-plugin://browser/main.js',
      'not a url',
    ])('blocks main-frame navigation and redirects to %s', (url) => {
      const { fire } = attachGuest();
      expect(fire('will-navigate', { url }).preventDefault).toHaveBeenCalled();
      expect(fire('will-redirect', { url }).preventDefault).toHaveBeenCalled();
    });

    it('blocks file: navigation and redirects by default', () => {
      const { fire } = attachGuest();
      expect(fire('will-navigate', { url: 'file:///etc/hosts' }).preventDefault).toHaveBeenCalled();
      expect(fire('will-redirect', { url: 'file:///etc/hosts' }).preventDefault).toHaveBeenCalled();
      expect(fire('will-frame-navigate', { url: 'file:///etc/hosts', isMainFrame: false }).preventDefault).toHaveBeenCalled();
    });

    it('allows file: navigation when the Browser setting is on', () => {
      vi.mocked(isBrowserFileAccessAllowed).mockReturnValue(true);
      const { fire } = attachGuest();
      expect(fire('will-navigate', { url: 'file:///tmp/page.html' }).preventDefault).not.toHaveBeenCalled();
      expect(fire('will-frame-navigate', { url: 'file:///tmp/frame.html', isMainFrame: false }).preventDefault).not.toHaveBeenCalled();
    });

    it('allows ordinary subframe schemes but still blocks privileged ones', () => {
      const { fire } = attachGuest();
      for (const url of ['about:srcdoc', 'data:text/html,x', 'blob:https://example.com/1', 'https://ads.example/']) {
        expect(fire('will-frame-navigate', { url, isMainFrame: false }).preventDefault).not.toHaveBeenCalled();
      }
      expect(fire('will-frame-navigate', { url: 'chrome://settings', isMainFrame: false }).preventDefault).toHaveBeenCalled();
      expect(fire('will-frame-navigate', { url: 'javascript:alert(1)', isMainFrame: false }).preventDefault).toHaveBeenCalled();
    });

    it('leaves main-frame checks on will-frame-navigate to will-navigate', () => {
      const { fire } = attachGuest();
      expect(fire('will-frame-navigate', { url: 'chrome://settings', isMainFrame: true }).preventDefault).not.toHaveBeenCalled();
      expect(fire('will-navigate', { url: 'chrome://settings' }).preventDefault).toHaveBeenCalled();
    });

    describe('did-start-navigation backstop for programmatic loads', () => {
      function start(fire: ReturnType<typeof attachGuest>['fire'], details: { url: string; isMainFrame?: boolean; isSameDocument?: boolean }) {
        return fire('did-start-navigation', { isMainFrame: true, isSameDocument: false, ...details } as { url: string; isMainFrame?: boolean });
      }

      it('registers the backstop', () => {
        const { guest } = attachGuest();
        expect(guest.on).toHaveBeenCalledWith('did-start-navigation', expect.any(Function));
      });

      it('stops a main-frame file:// load when the setting is off everywhere', () => {
        const { guest, fire } = attachGuest();
        start(fire, { url: 'file:///etc/hosts' });
        expect((guest as unknown as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalledTimes(1);
      });

      it('lets a main-frame file:// load through when the setting is on', () => {
        vi.mocked(isBrowserFileAccessAllowed).mockReturnValue(true);
        const { guest, fire } = attachGuest();
        start(fire, { url: 'file:///tmp/page.html' });
        expect((guest as unknown as { stop: ReturnType<typeof vi.fn> }).stop).not.toHaveBeenCalled();
      });

      it('stops a main-frame load with a disallowed scheme', () => {
        const { guest, fire } = attachGuest();
        start(fire, { url: 'chrome://settings' });
        expect((guest as unknown as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalledTimes(1);
      });

      it.each([
        { url: 'https://example.com/' },
        { url: 'about:blank' },
        { url: 'file:///etc/hosts', isMainFrame: false },
        { url: 'file:///tmp/page.html#section', isSameDocument: true },
      ])('leaves $url alone (main frame: $isMainFrame, same document: $isSameDocument)', (details) => {
        const { guest, fire } = attachGuest();
        start(fire, details);
        expect((guest as unknown as { stop: ReturnType<typeof vi.fn> }).stop).not.toHaveBeenCalled();
      });
    });

    it.each(['https://example.com/popup', 'file:///tmp/x.html', 'about:blank', 'javascript:alert(1)'])('denies popups to %s', (url) => {
      const { open } = attachGuest();
      expect(open(url)).toEqual({ action: 'deny' });
    });
  });
});
