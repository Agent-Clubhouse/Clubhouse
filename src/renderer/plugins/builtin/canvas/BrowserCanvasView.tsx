import React, { useState, useCallback, useRef } from 'react';
import type { BrowserCanvasView as BrowserCanvasViewType, CanvasView } from './canvas-types';

interface BrowserCanvasViewProps {
  view: BrowserCanvasViewType;
  onUpdate: (updates: Partial<CanvasView>) => void;
}

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function BrowserCanvasView({ view, onUpdate }: BrowserCanvasViewProps) {
  const [addressBar, setAddressBar] = useState(view.url);
  const webviewRef = useRef<HTMLWebViewElement>(null);

  const handleNavigate = useCallback(() => {
    let url = addressBar.trim();
    if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
    }
    if (isAllowedUrl(url)) {
      onUpdate({ url, title: url, metadata: { url } } as Partial<BrowserCanvasViewType>);
    }
  }, [addressBar, onUpdate]);

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

  const showWebview = isAllowedUrl(view.url);

  return (
    <div className="flex flex-col h-full">
      {/* Address bar */}
      <div className="flex items-center gap-1 px-1.5 py-1 bg-ctp-surface0/50 border-b border-surface-0 flex-shrink-0">
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
          onBlur={handleNavigate}
          className="flex-1 min-w-0 px-2 py-0.5 rounded bg-ctp-surface0 text-[11px] text-ctp-text border border-surface-1 outline-none focus:border-ctp-accent"
          placeholder="https://..."
          data-testid="canvas-browser-address"
        />
      </div>

      {/* Webview content */}
      <div className="flex-1 min-h-0 bg-white">
        {showWebview ? (
          <webview
            ref={webviewRef as any}
            src={view.url}
            partition="persist:canvas-browser"
            className="w-full h-full"
            // Security: sandbox and context isolation
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
