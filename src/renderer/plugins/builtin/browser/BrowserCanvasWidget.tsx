// Canvas widget for browser — registered as plugin:browser:webview.
// Provides a standalone embedded browser delivered through the v0.8
// widget API so 1p widgets go through the same registration/validation path as 3p.

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { CanvasWidgetComponentProps } from '../../../../shared/plugin-types';
import { validateUrl, normalizeAddress } from './url-validation';
import type { ProtocolSettings } from './url-validation';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

export function BrowserCanvasWidget({ widgetId, api, metadata, onUpdateMetadata, size: _size }: CanvasWidgetComponentProps) {
  const isAppMode = api.context.mode === 'app';
  const projects = useMemo(() => api.projects.list(), [api]);

  const url = metadata.url as string | undefined;
  const projectId = (metadata.projectId as string) || (isAppMode ? undefined : api.context.projectId);

  const [addressBar, setAddressBar] = useState(url || '');
  const [error, setError] = useState<string | null>(null);
  const webviewRef = useRef<HTMLWebViewElement>(null);

  const registerWebview = useMcpBindingStore((s) => s.registerWebview);
  const unregisterWebview = useMcpBindingStore((s) => s.unregisterWebview);
  const isDomReady = useRef(false);

  const protocolSettings: ProtocolSettings = {
    allowLocalhost: api.settings.get<boolean>('allowLocalhost') ?? false,
    allowFileProtocol: api.settings.get<boolean>('allowFileProtocol') ?? false,
  };

  // Compute whether the webview element is rendered (must be before the
  // registration effect so it can be used as a dependency).
  const isWebviewRendered = !!(url && validateUrl(url, protocolSettings).valid);

  // Register the webview with the MCP bridge when it becomes ready.
  // `isWebviewRendered` is a dependency so the effect re-runs when the
  // <webview> element appears (e.g. user enters a URL after widget mount).
  useEffect(() => {
    const wv = webviewRef.current as any;
    if (!wv) return;

    isDomReady.current = false;

    const handleDomReady = () => {
      isDomReady.current = true;
      const wcId = wv.getWebContentsId?.();
      if (wcId != null) {
        registerWebview(widgetId, wcId);
      }
    };

    wv.addEventListener('dom-ready', handleDomReady);

    // If the webview is already ready (dom-ready fired before this effect
    // ran), register immediately so we don't silently miss it.
    try {
      const existingWcId = wv.getWebContentsId?.();
      if (existingWcId != null) {
        isDomReady.current = true;
        registerWebview(widgetId, existingWcId);
      }
    } catch {
      // getWebContentsId throws if dom-ready hasn't fired yet — the
      // listener above will handle registration once it does.
    }

    return () => {
      wv.removeEventListener('dom-ready', handleDomReady);
      isDomReady.current = false;
      unregisterWebview(widgetId);
    };
  }, [widgetId, isWebviewRendered, registerWebview, unregisterWebview]);

  // Sync address bar when metadata URL changes externally
  useEffect(() => {
    if (url) {
      setAddressBar(url);
    }
  }, [url]);

  const navigateTo = useCallback((rawUrl: string) => {
    const normalized = normalizeAddress(rawUrl);
    if (!normalized) return;

    const result = validateUrl(normalized, protocolSettings);
    if (!result.valid) {
      setError(result.error || 'Invalid URL.');
      return;
    }

    setError(null);
    setAddressBar(normalized);
    onUpdateMetadata({ url: normalized, projectId: projectId ?? null });
  }, [protocolSettings, onUpdateMetadata, projectId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      navigateTo(addressBar);
    }
  }, [addressBar, navigateTo]);

  const handleBack = useCallback(() => {
    const wv = webviewRef.current as any;
    if (wv?.goBack && isDomReady.current) wv.goBack();
  }, []);

  const handleForward = useCallback(() => {
    const wv = webviewRef.current as any;
    if (wv?.goForward && isDomReady.current) wv.goForward();
  }, []);

  const handleReload = useCallback(() => {
    const wv = webviewRef.current as any;
    if (wv?.reload && isDomReady.current) wv.reload();
  }, []);

  const handleDevTools = useCallback(() => {
    const wv = webviewRef.current as any;
    if (!wv || !isDomReady.current) return;
    if (wv.isDevToolsOpened?.()) {
      wv.closeDevTools?.();
    } else {
      wv.openDevTools?.();
    }
  }, []);

  const handleSelectProject = useCallback((pid: string) => {
    onUpdateMetadata({ projectId: pid, url: null });
  }, [onUpdateMetadata]);

  const handleBackToProjects = useCallback(() => {
    onUpdateMetadata({ projectId: null, url: null });
  }, [onUpdateMetadata]);

  // Step 1: Project picker (app mode only, no project selected)
  if (isAppMode && !projectId) {
    return (
      <div className="flex flex-col h-full p-2">
        <div className="text-xs font-medium text-ctp-subtext1 uppercase tracking-wider mb-2">
          Select a project
        </div>
        {projects.length === 0 ? (
          <div className="text-xs text-ctp-overlay0 italic">No projects open</div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-1">
            {projects.map((p) => {
              const color = projectColor(p.name);
              const initials = p.name.slice(0, 2).toUpperCase();
              return (
                <button
                  key={p.id}
                  className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg bg-surface-0 hover:bg-surface-1 text-left transition-colors"
                  onClick={() => handleSelectProject(p.id)}
                >
                  <div
                    className="w-6 h-6 rounded-md flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0"
                    style={{ backgroundColor: color }}
                  >
                    {initials}
                  </div>
                  <span className="text-[11px] text-ctp-text truncate">{p.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // Step 2: Browser view
  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center gap-1 px-1.5 py-1 bg-ctp-surface0/50 border-b border-surface-0 text-[10px] text-ctp-subtext0 flex-shrink-0">
        {isAppMode && (
          <button
            className="hover:text-ctp-text transition-colors mr-1"
            onClick={handleBackToProjects}
            title="Back to projects"
          >
            &larr;
          </button>
        )}
        <button
          className="w-5 h-5 flex items-center justify-center rounded text-[10px] text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text"
          onClick={handleBack}
          title="Back"
        >
          &larr;
        </button>
        <button
          className="w-5 h-5 flex items-center justify-center rounded text-[10px] text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text"
          onClick={handleForward}
          title="Forward"
        >
          &rarr;
        </button>
        <button
          className="w-5 h-5 flex items-center justify-center rounded text-[10px] text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text"
          onClick={handleReload}
          title="Reload"
        >
          &#8635;
        </button>
        <input
          type="text"
          value={addressBar}
          onChange={(e) => setAddressBar(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 min-w-0 px-2 py-0.5 rounded bg-ctp-surface0 text-[11px] text-ctp-text border border-surface-1 outline-none focus:border-ctp-accent"
          placeholder="Enter URL..."
          data-testid="canvas-browser-address"
        />
        <button
          className="w-5 h-5 flex items-center justify-center rounded text-[10px] text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text"
          onClick={handleDevTools}
          title="Toggle DevTools"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-2 py-1.5 bg-ctp-red/10 border-b border-ctp-red/20 text-[10px] text-ctp-red flex-shrink-0">
          {error}
        </div>
      )}

      {/* Webview content */}
      <div className="flex-1 min-h-0 bg-white">
        {isWebviewRendered ? (
          <webview
            ref={webviewRef as any}
            src={url}
            partition="persist:plugin-browser"
            className="w-full h-full"
            {...{
              nodeintegration: 'false',
              sandbox: 'true',
              contextIsolation: 'true',
            } as any}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-xs text-ctp-overlay0">
            Enter a URL above to browse
          </div>
        )}
      </div>
    </div>
  );
}
