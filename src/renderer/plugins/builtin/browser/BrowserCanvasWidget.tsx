// Canvas widget for browser — registered as plugin:browser:webview.
// Provides a standalone embedded browser delivered through the v0.8
// widget API so 1p widgets go through the same registration/validation path as 3p.

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { CanvasWidgetComponentProps } from '../../../../shared/plugin-types';
import { validateUrl, normalizeAddress } from './url-validation';
import type { ProtocolSettings } from './url-validation';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import { useRemoteProject } from '../../../hooks/useRemoteProject';
import { AnnexUnsupportedPlaceholder } from '../../../features/annex/AnnexUnsupportedPlaceholder';
import { EmptyState } from '../../../components/EmptyState';
import { Button } from '../../../components/Button';
import { Tooltip } from '../../../components/Tooltip';
import { WidgetPicker, projectRows } from '../canvas/WidgetPicker';

export function BrowserCanvasWidget({ widgetId, api, metadata, onUpdateMetadata, size: _size }: CanvasWidgetComponentProps) {
  const isAppMode = api.context.mode === 'app';
  const projects = useMemo(() => api.projects.list(), [api]);

  const projectId = (metadata.projectId as string) || (isAppMode ? undefined : api.context.projectId);
  const remote = useRemoteProject(projectId);

  // Browser webviews cannot be rendered over annex connections
  if (remote.isRemote) {
    const url = metadata.url as string | undefined;
    return (
      <AnnexUnsupportedPlaceholder
        widgetType="Browser"
        reason={url ? `Viewing ${url} on the satellite.` : 'Browser webviews cannot be streamed over Annex.'}
      />
    );
  }

  const url = metadata.url as string | undefined;

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
      <WidgetPicker
        searchPlaceholder="Find a project"
        emptyText="No projects open"
        sections={[{ id: 'projects', rows: projectRows(projects, handleSelectProject) }]}
      />
    );
  }

  // Step 2: Browser view
  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="h-[30px] flex items-center gap-1 px-1 border-b border-surface-0 flex-shrink-0">
        {isAppMode && <ToolbarButton label="Back to projects" d="M15 6l-6 6 6 6M21 6v12" onClick={handleBackToProjects} />}
        <ToolbarButton label="Back" d="M19 12H5M11 6l-6 6 6 6" onClick={handleBack} />
        <ToolbarButton label="Forward" d="M5 12h14M13 6l6 6-6 6" onClick={handleForward} />
        <ToolbarButton label="Reload" d="M23 4v6h-6M20.49 15a9 9 0 1 1-2.12-9.36L23 10" onClick={handleReload} />
        <input
          type="text"
          value={addressBar}
          onChange={(e) => setAddressBar(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Address"
          className="flex-1 min-w-0 h-7 px-2 rounded-md bg-ctp-base text-xs text-ctp-text border border-surface-1 placeholder:text-ctp-overlay1 focus-ring"
          placeholder="Enter a URL"
          data-testid="canvas-browser-address"
        />
        <ToolbarButton
          label="Toggle DevTools"
          d="M16 18l6-6-6-6M8 6l-6 6 6 6"
          onClick={handleDevTools}
        />
      </div>

      {error && (
        <div className="px-3 py-1.5 border-b border-surface-0 text-xs text-ctp-error flex-shrink-0" role="alert">
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
          <EmptyState title="Enter a URL above to browse" compact />
        )}
      </div>
    </div>
  );
}

/** A 28px icon button with a tooltip and an accessible name. */
function ToolbarButton({ label, d, onClick }: { label: string; d: string; onClick: () => void }) {
  return (
    <Tooltip content={label}>
      <Button
        kind="quiet"
        aria-label={label}
        onClick={onClick}
        icon={(
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={d} />
          </svg>
        )}
      />
    </Tooltip>
  );
}
