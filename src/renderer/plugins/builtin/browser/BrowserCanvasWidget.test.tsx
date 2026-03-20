import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { BrowserCanvasWidget } from './BrowserCanvasWidget';
import { createMockAPI } from '../../testing';

// ── Mock mcpBindingStore ────────────────────────────────────────────────

const mockRegisterWebview = vi.fn();
const mockUnregisterWebview = vi.fn();

vi.mock('../../../stores/mcpBindingStore', () => ({
  useMcpBindingStore: vi.fn((selector: (s: any) => any) =>
    selector({ registerWebview: mockRegisterWebview, unregisterWebview: mockUnregisterWebview }),
  ),
}));

// ── Helpers ─────────────────────────────────────────────────────────────

function createWidgetAPI(settingsOverrides: Record<string, unknown> = {}) {
  return createMockAPI({
    context: { mode: 'project', projectId: 'proj-1', projectPath: '/project' },
    settings: {
      get: <T = unknown>(key: string): T | undefined => {
        const defaults: Record<string, unknown> = {
          allowLocalhost: false,
          allowFileProtocol: false,
          ...settingsOverrides,
        };
        return defaults[key] as T | undefined;
      },
      getAll: () => ({ allowLocalhost: false, allowFileProtocol: false, ...settingsOverrides }),
      set: vi.fn(),
      onChange: () => ({ dispose: () => {} }),
    },
  });
}

const defaultProps = {
  widgetId: 'widget-1',
  api: createWidgetAPI(),
  metadata: { url: 'https://example.com' },
  onUpdateMetadata: vi.fn(),
  size: { width: 800, height: 600 },
};

/**
 * Find the <webview> element (rendered as HTMLUnknownElement in jsdom)
 * and add mock methods to simulate Electron's webview API.
 */
function getWebviewElement(container: HTMLElement): HTMLElement & Record<string, any> {
  const wv = container.querySelector('webview') as HTMLElement & Record<string, any>;
  if (!wv) throw new Error('webview element not found');
  return wv;
}

function addWebviewMethods(wv: HTMLElement & Record<string, any>, wcId = 42) {
  wv.getWebContentsId = vi.fn(() => wcId);
  wv.goBack = vi.fn();
  wv.goForward = vi.fn();
  wv.reload = vi.fn();
  wv.isDevToolsOpened = vi.fn(() => false);
  wv.openDevTools = vi.fn();
  wv.closeDevTools = vi.fn();
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('BrowserCanvasWidget', () => {
  beforeEach(() => {
    mockRegisterWebview.mockClear();
    mockUnregisterWebview.mockClear();
  });

  describe('dom-ready registration', () => {
    it('does not crash when getWebContentsId throws before dom-ready', () => {
      // Default: the <webview> element has no getWebContentsId method,
      // which is equivalent to calling it before dom-ready (the try-catch
      // in the effect handles both the throw case and the missing method case).
      expect(() => {
        render(<BrowserCanvasWidget {...defaultProps} />);
      }).not.toThrow();
    });

    it('does not register webview before dom-ready fires', () => {
      render(<BrowserCanvasWidget {...defaultProps} />);
      // getWebContentsId doesn't exist on the jsdom element, so optional
      // chaining returns undefined — registration should not happen.
      expect(mockRegisterWebview).not.toHaveBeenCalled();
    });

    it('registers webview after dom-ready fires', () => {
      const { container } = render(<BrowserCanvasWidget {...defaultProps} />);
      const wv = getWebviewElement(container);
      // Simulate webview becoming ready: add the method, then dispatch dom-ready
      addWebviewMethods(wv, 42);
      act(() => { wv.dispatchEvent(new Event('dom-ready')); });
      expect(mockRegisterWebview).toHaveBeenCalledWith('widget-1', 42);
    });

    it('unregisters webview on unmount', () => {
      const { unmount } = render(<BrowserCanvasWidget {...defaultProps} />);
      unmount();
      expect(mockUnregisterWebview).toHaveBeenCalledWith('widget-1');
    });
  });

  describe('navigation handlers before dom-ready', () => {
    it('back button is a no-op before dom-ready', () => {
      const { container } = render(<BrowserCanvasWidget {...defaultProps} />);
      const wv = getWebviewElement(container);
      addWebviewMethods(wv);
      // Don't fire dom-ready — isDomReady is false
      fireEvent.click(screen.getByTitle('Back'));
      expect(wv.goBack).not.toHaveBeenCalled();
    });

    it('forward button is a no-op before dom-ready', () => {
      const { container } = render(<BrowserCanvasWidget {...defaultProps} />);
      const wv = getWebviewElement(container);
      addWebviewMethods(wv);
      fireEvent.click(screen.getByTitle('Forward'));
      expect(wv.goForward).not.toHaveBeenCalled();
    });

    it('reload button is a no-op before dom-ready', () => {
      const { container } = render(<BrowserCanvasWidget {...defaultProps} />);
      const wv = getWebviewElement(container);
      addWebviewMethods(wv);
      fireEvent.click(screen.getByTitle('Reload'));
      expect(wv.reload).not.toHaveBeenCalled();
    });

    it('devtools button is a no-op before dom-ready', () => {
      const { container } = render(<BrowserCanvasWidget {...defaultProps} />);
      const wv = getWebviewElement(container);
      addWebviewMethods(wv);
      fireEvent.click(screen.getByTitle('Toggle DevTools'));
      expect(wv.openDevTools).not.toHaveBeenCalled();
    });
  });

  describe('navigation handlers after dom-ready', () => {
    function renderAndReady() {
      const result = render(<BrowserCanvasWidget {...defaultProps} />);
      const wv = getWebviewElement(result.container);
      addWebviewMethods(wv, 42);
      act(() => { wv.dispatchEvent(new Event('dom-ready')); });
      return { ...result, wv };
    }

    it('back button calls goBack after dom-ready', () => {
      const { wv } = renderAndReady();
      fireEvent.click(screen.getByTitle('Back'));
      expect(wv.goBack).toHaveBeenCalled();
    });

    it('forward button calls goForward after dom-ready', () => {
      const { wv } = renderAndReady();
      fireEvent.click(screen.getByTitle('Forward'));
      expect(wv.goForward).toHaveBeenCalled();
    });

    it('reload button calls reload after dom-ready', () => {
      const { wv } = renderAndReady();
      fireEvent.click(screen.getByTitle('Reload'));
      expect(wv.reload).toHaveBeenCalled();
    });

    it('devtools button calls openDevTools after dom-ready', () => {
      const { wv } = renderAndReady();
      fireEvent.click(screen.getByTitle('Toggle DevTools'));
      expect(wv.openDevTools).toHaveBeenCalled();
    });
  });

  describe('address bar', () => {
    it('renders with the initial URL', () => {
      render(<BrowserCanvasWidget {...defaultProps} />);
      const input = screen.getByTestId('canvas-browser-address') as HTMLInputElement;
      expect(input.value).toBe('https://example.com');
    });

    it('shows empty state when no URL provided', () => {
      render(<BrowserCanvasWidget {...defaultProps} metadata={{}} />);
      expect(screen.getByText('Enter a URL above to browse')).toBeInTheDocument();
    });
  });
});
