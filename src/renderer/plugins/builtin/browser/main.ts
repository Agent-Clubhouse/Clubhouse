import React, { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import { browserState } from './state';
import type { HistoryEntry } from './state';
import { validateUrl, normalizeAddress } from './url-validation';
import type { ProtocolSettings } from './url-validation';
import { BrowserCanvasWidget } from './BrowserCanvasWidget';

export function activate(ctx: PluginContext, api: PluginAPI): void {
  // Register commands
  ctx.subscriptions.push(
    api.commands.register('reload', () => {
      browserState.dispatchCommand('reload');
    }),
  );
  ctx.subscriptions.push(
    api.commands.register('devtools', () => {
      browserState.dispatchCommand('devtools');
    }),
  );

  // Register canvas widget
  ctx.subscriptions.push(
    api.canvas.registerWidgetType({
      id: 'webview',
      component: BrowserCanvasWidget,
      generateDisplayName: (metadata) => {
        if (metadata.url && typeof metadata.url === 'string') {
          try {
            const parsed = new URL(metadata.url);
            return parsed.hostname || 'Browser';
          } catch {
            return 'Browser';
          }
        }
        return 'Browser';
      },
    }),
  );
}

export function deactivate(): void {
  browserState.reset();
}

// ── Hooks ──────────────────────────────────────────────────────────────

function useBrowserState() {
  const subscribe = useCallback((cb: () => void) => browserState.subscribe(cb), []);
  const getCurrentUrl = useCallback(() => browserState.currentUrl, []);
  const getCurrentTitle = useCallback(() => browserState.currentTitle, []);
  const getHistory = useCallback(() => browserState.history, []);
  const currentUrl = useSyncExternalStore(subscribe, getCurrentUrl);
  const currentTitle = useSyncExternalStore(subscribe, getCurrentTitle);
  const history = useSyncExternalStore(subscribe, getHistory);
  return { currentUrl, currentTitle, history };
}

function useProtocolSettings(api: PluginAPI): ProtocolSettings {
  const [settings, setSettings] = useState<ProtocolSettings>({
    allowLocalhost: api.settings.get<boolean>('allowLocalhost') ?? false,
    allowFileProtocol: api.settings.get<boolean>('allowFileProtocol') ?? false,
  });

  useEffect(() => {
    const sub = api.settings.onChange((key: string) => {
      if (key === 'allowLocalhost' || key === 'allowFileProtocol') {
        setSettings({
          allowLocalhost: api.settings.get<boolean>('allowLocalhost') ?? false,
          allowFileProtocol: api.settings.get<boolean>('allowFileProtocol') ?? false,
        });
      }
    });
    return () => sub.dispose();
  }, [api]);

  return settings;
}

// ── Sidebar Panel ──────────────────────────────────────────────────────

export function SidebarPanel({ api }: { api: PluginAPI }) {
  const { history } = useBrowserState();
  const protocolSettings = useProtocolSettings(api);

  const handleHistoryClick = useCallback((url: string) => {
    browserState.setCurrentPage(url, '');
  }, []);

  return React.createElement('div', { className: 'flex flex-col h-full bg-ctp-mantle', 'data-testid': 'browser-sidebar-panel' },
    // Protocol status section
    React.createElement('div', {
      className: 'px-3 py-2 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider border-b border-ctp-surface0',
    }, 'Protocols'),
    React.createElement('div', { className: 'px-3 py-2 space-y-1.5 border-b border-ctp-surface0' },
      React.createElement('div', { className: 'flex items-center gap-2 text-xs' },
        React.createElement('span', { className: 'w-2 h-2 rounded-full bg-ctp-green flex-shrink-0' }),
        React.createElement('span', { className: 'text-ctp-subtext1' }, 'HTTPS'),
      ),
      React.createElement('div', { className: 'flex items-center gap-2 text-xs' },
        React.createElement('span', {
          className: `w-2 h-2 rounded-full flex-shrink-0 ${protocolSettings.allowLocalhost ? 'bg-ctp-green' : 'bg-ctp-overlay0 opacity-40'}`,
        }),
        React.createElement('span', {
          className: protocolSettings.allowLocalhost ? 'text-ctp-subtext1' : 'text-ctp-overlay0',
        }, 'Localhost'),
      ),
      React.createElement('div', { className: 'flex items-center gap-2 text-xs' },
        React.createElement('span', {
          className: `w-2 h-2 rounded-full flex-shrink-0 ${protocolSettings.allowFileProtocol ? 'bg-ctp-green' : 'bg-ctp-overlay0 opacity-40'}`,
        }),
        React.createElement('span', {
          className: protocolSettings.allowFileProtocol ? 'text-ctp-subtext1' : 'text-ctp-overlay0',
        }, 'File'),
      ),
    ),

    // History section
    React.createElement('div', {
      className: 'px-3 py-2 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider',
    }, 'History'),
    React.createElement('div', { className: 'flex-1 overflow-y-auto py-1' },
      history.length === 0
        ? React.createElement('div', { className: 'px-3 py-2 text-xs text-ctp-overlay0 italic' }, 'No pages visited yet')
        : history.map((entry: HistoryEntry, index: number) =>
            React.createElement('button', {
              key: `${entry.url}-${index}`,
              className: 'w-full text-left px-3 py-2 text-sm cursor-pointer transition-colors text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text',
              onClick: () => handleHistoryClick(entry.url),
              title: entry.url,
            },
              React.createElement('div', { className: 'truncate text-[11px]' }, entry.title || entry.url),
              React.createElement('div', { className: 'truncate text-[9px] text-ctp-overlay0' }, entry.url),
            ),
          ),
    ),
  );
}

// ── Main Panel ─────────────────────────────────────────────────────────

export function MainPanel({ api }: { api: PluginAPI }) {
  const { currentUrl } = useBrowserState();
  const protocolSettings = useProtocolSettings(api);
  const [addressBar, setAddressBar] = useState('');
  const [error, setError] = useState<string | null>(null);
  const webviewRef = useRef<HTMLWebViewElement>(null);
  const [navigatedUrl, setNavigatedUrl] = useState('');
  const [pageTitle, setPageTitle] = useState('');

  // Dynamic title
  useEffect(() => {
    if (pageTitle) {
      api.window.setTitle(`Browser \u2014 ${pageTitle}`);
    } else if (navigatedUrl) {
      api.window.setTitle(`Browser \u2014 ${navigatedUrl}`);
    } else {
      api.window.setTitle('Browser');
    }
    return () => api.window.resetTitle();
  }, [api, pageTitle, navigatedUrl]);

  // Listen for external navigation requests (from sidebar history clicks)
  useEffect(() => {
    const unsub = browserState.subscribe(() => {
      const url = browserState.currentUrl;
      if (url && url !== navigatedUrl) {
        navigateTo(url);
      }
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigatedUrl, protocolSettings]);

  // Listen for commands
  useEffect(() => {
    const unsub = browserState.onCommand((cmd) => {
      const wv = webviewRef.current as any;
      if (!wv) return;
      switch (cmd) {
        case 'reload':
          if (wv.reload) wv.reload();
          break;
        case 'devtools':
          if (wv.isDevToolsOpened?.()) {
            wv.closeDevTools?.();
          } else {
            wv.openDevTools?.();
          }
          break;
        case 'back':
          if (wv.goBack) wv.goBack();
          break;
        case 'forward':
          if (wv.goForward) wv.goForward();
          break;
      }
    });
    return unsub;
  }, []);

  // Listen for webview page title changes
  useEffect(() => {
    const wv = webviewRef.current as any;
    if (!wv) return;
    const handleTitleUpdate = (e: any) => {
      const title = e.title || '';
      setPageTitle(title);
      browserState.setCurrentPage(navigatedUrl, title);
    };
    wv.addEventListener?.('page-title-updated', handleTitleUpdate);
    return () => {
      wv.removeEventListener?.('page-title-updated', handleTitleUpdate);
    };
  }, [navigatedUrl]);

  const navigateTo = useCallback((rawUrl: string) => {
    const url = normalizeAddress(rawUrl);
    if (!url) return;

    const result = validateUrl(url, protocolSettings);
    if (!result.valid) {
      setError(result.error || 'Invalid URL.');
      return;
    }

    setError(null);
    setAddressBar(url);
    setNavigatedUrl(url);
    browserState.setCurrentPage(url, '');
  }, [protocolSettings]);

  const handleNavigate = useCallback(() => {
    navigateTo(addressBar);
  }, [addressBar, navigateTo]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNavigate();
    }
  }, [handleNavigate]);

  const handleBack = useCallback(() => {
    const wv = webviewRef.current as any;
    if (wv?.goBack) wv.goBack();
  }, []);

  const handleForward = useCallback(() => {
    const wv = webviewRef.current as any;
    if (wv?.goForward) wv.goForward();
  }, []);

  const handleReload = useCallback(() => {
    const wv = webviewRef.current as any;
    if (wv?.reload) wv.reload();
  }, []);

  const handleDevTools = useCallback(() => {
    const wv = webviewRef.current as any;
    if (!wv) return;
    if (wv.isDevToolsOpened?.()) {
      wv.closeDevTools?.();
    } else {
      wv.openDevTools?.();
    }
  }, []);

  return React.createElement('div', {
    className: 'flex flex-col h-full bg-ctp-base',
    'data-testid': 'browser-main-panel',
  },
    // Header bar with navigation
    React.createElement('div', {
      className: 'flex items-center gap-1 px-2 py-1.5 border-b border-ctp-surface0 bg-ctp-mantle flex-shrink-0',
    },
      // Back button
      React.createElement('button', {
        className: 'w-6 h-6 flex items-center justify-center rounded text-xs text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text transition-colors',
        onClick: handleBack,
        title: 'Back',
        'data-testid': 'browser-back-btn',
      }, '\u2190'),
      // Forward button
      React.createElement('button', {
        className: 'w-6 h-6 flex items-center justify-center rounded text-xs text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text transition-colors',
        onClick: handleForward,
        title: 'Forward',
        'data-testid': 'browser-forward-btn',
      }, '\u2192'),
      // Reload button
      React.createElement('button', {
        className: 'w-6 h-6 flex items-center justify-center rounded text-xs text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text transition-colors',
        onClick: handleReload,
        title: 'Reload',
        'data-testid': 'browser-reload-btn',
      }, '\u21BB'),
      // Address bar
      React.createElement('input', {
        type: 'text',
        value: addressBar,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setAddressBar(e.target.value),
        onKeyDown: handleKeyDown,
        className: 'flex-1 min-w-0 px-2 py-0.5 rounded bg-ctp-surface0 text-xs text-ctp-text border border-surface-1 outline-none focus:border-ctp-accent',
        placeholder: 'Enter URL (https://example.com, localhost:3000, file:///path)...',
        'data-testid': 'browser-address-bar',
      }),
      // DevTools button
      React.createElement('button', {
        className: 'flex items-center gap-1 px-2 py-0.5 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
        onClick: handleDevTools,
        title: 'Toggle DevTools',
        'data-testid': 'browser-devtools-btn',
      },
        React.createElement('svg', {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
          React.createElement('circle', { cx: 12, cy: 12, r: 3 }),
          React.createElement('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z' }),
        ),
        'DevTools',
      ),
    ),

    // Error banner
    error && React.createElement('div', {
      className: 'px-3 py-2 bg-ctp-red/10 border-b border-ctp-red/20 text-xs text-ctp-red flex-shrink-0',
      'data-testid': 'browser-error-banner',
    }, error),

    // Webview content
    React.createElement('div', { className: 'flex-1 min-h-0 bg-white' },
      navigatedUrl
        ? React.createElement('webview' as any, {
            ref: webviewRef,
            src: navigatedUrl,
            partition: 'persist:plugin-browser',
            className: 'w-full h-full',
            nodeintegration: 'false',
            sandbox: 'true',
            contextIsolation: 'true',
          })
        : React.createElement('div', {
            className: 'flex flex-col items-center justify-center h-full text-ctp-overlay0 gap-3',
          },
            React.createElement('svg', {
              width: 48,
              height: 48,
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.5,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              className: 'text-ctp-surface2',
            },
              React.createElement('circle', { cx: 12, cy: 12, r: 10 }),
              React.createElement('line', { x1: 2, y1: 12, x2: 22, y2: 12 }),
              React.createElement('path', { d: 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z' }),
            ),
            React.createElement('div', { className: 'text-xs' }, 'Enter a URL above to browse'),
          ),
    ),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel, SidebarPanel };
void _;
