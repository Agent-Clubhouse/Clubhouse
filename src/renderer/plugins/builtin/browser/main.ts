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

/** Which kinds of address the browser opens, as one sentence ("Opens https and localhost addresses."). */
export function protocolSummary(settings: ProtocolSettings): string {
  const kinds = ['https'];
  if (settings.allowLocalhost) kinds.push('localhost');
  if (settings.allowFileProtocol) kinds.push('file');
  const list = kinds.length === 1 ? kinds[0] : `${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}`;
  return `Opens ${list} addresses.`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const GlobeIcon = (size: number, className = '') => React.createElement('svg', {
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className,
},
  React.createElement('circle', { cx: 12, cy: 12, r: 10 }),
  React.createElement('line', { x1: 2, y1: 12, x2: 22, y2: 12 }),
  React.createElement('path', { d: 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z' }),
);

export function SidebarPanel({ api }: { api: PluginAPI }) {
  const { history, currentUrl } = useBrowserState();
  const protocolSettings = useProtocolSettings(api);

  const handleHistoryClick = useCallback((url: string) => {
    browserState.setCurrentPage(url, '');
  }, []);

  return React.createElement('div', { className: 'flex flex-col h-full bg-ctp-mantle', 'data-testid': 'browser-sidebar-panel' },
    React.createElement('div', {
      className: 'h-7 flex-shrink-0 flex items-center px-3.5 text-xs font-semibold text-ctp-overlay1',
    }, 'History'),
    React.createElement('div', { className: 'flex-1 overflow-y-auto pb-1' },
      history.length === 0
        ? React.createElement('div', { className: 'px-3.5 py-1 text-xs text-ctp-overlay1' }, 'Pages you open show up here.')
        : history.map((entry: HistoryEntry, index: number) => {
            const current = entry.url === currentUrl;
            return React.createElement('button', {
              key: `${entry.url}-${index}`,
              type: 'button',
              className: `mx-1.5 h-7 w-[calc(100%-12px)] flex items-center gap-2 px-2.5 rounded-md text-left text-[13px] cursor-pointer transition-colors focus-ring ${
                current ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text'
              }`,
              onClick: () => handleHistoryClick(entry.url),
              title: entry.url,
            },
              GlobeIcon(14, 'text-ctp-overlay1 flex-shrink-0'),
              React.createElement('span', { className: 'truncate flex-shrink' }, entry.title || hostOf(entry.url)),
              entry.title
                ? React.createElement('span', { className: 'text-xs text-ctp-overlay1 truncate min-w-0 flex-shrink-[2]' }, hostOf(entry.url))
                : null,
            );
          }),
    ),
    // What the browser may open, as one line instead of a block in the list
    React.createElement('div', {
      className: 'flex-shrink-0 px-3.5 py-2.5 border-t border-surface-0 text-xs text-ctp-overlay1',
      'data-testid': 'browser-protocols',
    }, protocolSummary(protocolSettings)),
  );
}

// ── Main Panel ─────────────────────────────────────────────────────────

export function MainPanel({ api }: { api: PluginAPI }) {
  const protocolSettings = useProtocolSettings(api);
  const [addressBar, setAddressBar] = useState('');
  const [error, setError] = useState<string | null>(null);
  const webviewRef = useRef<HTMLWebViewElement>(null);
  const [navigatedUrl, setNavigatedUrl] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  // Ref tracks current navigated URL to break browserState subscription recursion.
  // Without this, navigateTo → setCurrentPage → subscriber → navigateTo loops infinitely
  // because the subscriber closure captures a stale navigatedUrl.
  const navigatedUrlRef = useRef('');

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
    navigatedUrlRef.current = url; // Update ref BEFORE setCurrentPage to prevent recursion
    browserState.setCurrentPage(url, '');
  }, [protocolSettings]);

  // Listen for external navigation requests (from sidebar history clicks)
  useEffect(() => {
    const unsub = browserState.subscribe(() => {
      const url = browserState.currentUrl;
      if (url && url !== navigatedUrlRef.current) {
        navigateTo(url);
      }
    });
    return unsub;
  }, [navigateTo]);

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
    // Toolbar: navigation, the address and DevTools in one 32px row
    React.createElement('div', {
      className: 'h-8 flex items-center gap-0.5 px-2 border-b border-surface-0 flex-shrink-0',
    },
      navButton('Back', 'browser-back-btn', handleBack, React.createElement('polyline', { points: '15 18 9 12 15 6' })),
      navButton('Forward', 'browser-forward-btn', handleForward, React.createElement('polyline', { points: '9 18 15 12 9 6' })),
      navButton('Reload', 'browser-reload-btn', handleReload,
        React.createElement('polyline', { points: '23 4 23 10 17 10' }),
        React.createElement('path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' }),
      ),
      // Address bar
      React.createElement('input', {
        type: 'text',
        value: addressBar,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setAddressBar(e.target.value),
        onKeyDown: handleKeyDown,
        className: 'flex-1 min-w-0 h-7 mx-1.5 px-2.5 rounded-md bg-surface-0 text-xs text-ctp-text placeholder:text-ctp-overlay1 focus-ring',
        placeholder: 'Enter an address',
        'aria-label': 'Address',
        'data-testid': 'browser-address-bar',
      }),
      React.createElement('button', {
        type: 'button',
        className: 'h-7 flex items-center px-2.5 text-xs text-ctp-subtext1 hover:text-ctp-text hover:bg-surface-0 rounded-md transition-colors focus-ring',
        onClick: handleDevTools,
        title: 'Toggle DevTools',
        'data-testid': 'browser-devtools-btn',
      }, 'DevTools'),
    ),

    // Error banner
    error && React.createElement('div', {
      className: 'px-3.5 py-2 border-b border-surface-0 text-xs text-ctp-red flex-shrink-0',
      role: 'alert',
      'data-testid': 'browser-error-banner',
    }, error),

    // Webview content. Pages get a white canvas, as in any browser; the empty
    // state sits on the theme.
    navigatedUrl
      ? React.createElement('div', { className: 'flex-1 min-h-0 bg-white' },
          React.createElement('webview' as any, {
            ref: webviewRef,
            src: navigatedUrl,
            partition: 'persist:plugin-browser',
            className: 'w-full h-full',
            nodeintegration: 'false',
            sandbox: 'true',
            contextIsolation: 'true',
          }),
        )
      : React.createElement('div', {
          className: 'flex-1 min-h-0 flex justify-center pt-[22vh] px-4',
          'data-testid': 'browser-empty-state',
        },
          React.createElement('div', { className: 'w-[380px] max-w-full flex flex-col gap-2' },
            React.createElement('div', { className: 'text-[13px] text-ctp-text' }, 'Open a page'),
            React.createElement('div', { className: 'text-xs text-ctp-overlay1 leading-relaxed' }, emptyHint(protocolSettings)),
          ),
        ),
  );
}

/** The empty state's hint: which addresses work, and that the rest are off in Settings. */
export function emptyHint(settings: ProtocolSettings): string {
  const works = settings.allowLocalhost ? 'localhost:3000 and https:// addresses work.' : 'https:// addresses work.';
  const off = [!settings.allowLocalhost && 'Localhost', !settings.allowFileProtocol && 'File'].filter(Boolean) as string[];
  const offLine = off.length === 0 ? '' : off.length === 1
    ? ` ${off[0]} addresses are off in Settings.`
    : ` ${off[0]} and ${off[1].toLowerCase()} addresses are off in Settings.`;
  return `Type an address above. ${works}${offLine}`;
}

function navButton(label: string, testId: string, onClick: () => void, ...icon: React.ReactElement[]) {
  return React.createElement('button', {
    type: 'button',
    className: 'w-7 h-7 flex items-center justify-center rounded-md text-ctp-overlay1 hover:bg-surface-0 hover:text-ctp-text transition-colors focus-ring',
    onClick,
    title: label,
    'aria-label': label,
    'data-testid': testId,
  },
    React.createElement('svg', {
      width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    }, ...icon),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel, SidebarPanel };
void _;
