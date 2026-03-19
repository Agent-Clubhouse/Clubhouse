import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MainPanel, SidebarPanel, activate, deactivate } from './main';
import { browserState } from './state';
import { createMockAPI, createMockContext } from '../../testing';

// ── Helpers ─────────────────────────────────────────────────────────────

function createBrowserAPI(settingsOverrides: Record<string, unknown> = {}) {
  return createMockAPI({
    context: {
      mode: 'project',
      projectId: 'proj-1',
      projectPath: '/project',
    },
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
    window: {
      setTitle: vi.fn(),
      resetTitle: vi.fn(),
      getTitle: () => '',
    },
  });
}

// ── MainPanel component tests ───────────────────────────────────────────

describe('Browser MainPanel', () => {
  beforeEach(() => {
    browserState.reset();
  });

  it('renders address bar', () => {
    const api = createBrowserAPI();
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('browser-address-bar')).toBeInTheDocument();
  });

  it('renders navigation buttons', () => {
    const api = createBrowserAPI();
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('browser-back-btn')).toBeInTheDocument();
    expect(screen.getByTestId('browser-forward-btn')).toBeInTheDocument();
    expect(screen.getByTestId('browser-reload-btn')).toBeInTheDocument();
  });

  it('renders devtools button', () => {
    const api = createBrowserAPI();
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('browser-devtools-btn')).toBeInTheDocument();
  });

  it('shows empty state when no URL entered', () => {
    const api = createBrowserAPI();
    render(<MainPanel api={api} />);
    expect(screen.getByText('Enter a URL above to browse')).toBeInTheDocument();
  });

  it('shows error when navigating to blocked localhost', () => {
    const api = createBrowserAPI({ allowLocalhost: false });
    render(<MainPanel api={api} />);

    const addressBar = screen.getByTestId('browser-address-bar');
    fireEvent.change(addressBar, { target: { value: 'http://localhost:3000' } });
    fireEvent.keyDown(addressBar, { key: 'Enter' });

    expect(screen.getByTestId('browser-error-banner')).toBeInTheDocument();
    expect(screen.getByTestId('browser-error-banner').textContent).toContain('Allow localhost');
  });

  it('shows error when navigating to blocked file:// URL', () => {
    const api = createBrowserAPI({ allowFileProtocol: false });
    render(<MainPanel api={api} />);

    const addressBar = screen.getByTestId('browser-address-bar');
    fireEvent.change(addressBar, { target: { value: 'file:///tmp/test.html' } });
    fireEvent.keyDown(addressBar, { key: 'Enter' });

    expect(screen.getByTestId('browser-error-banner')).toBeInTheDocument();
    expect(screen.getByTestId('browser-error-banner').textContent).toContain('Allow file://');
  });

  it('does not show error for valid HTTPS URL', () => {
    const api = createBrowserAPI();
    render(<MainPanel api={api} />);

    const addressBar = screen.getByTestId('browser-address-bar');
    fireEvent.change(addressBar, { target: { value: 'https://example.com' } });
    fireEvent.keyDown(addressBar, { key: 'Enter' });

    expect(screen.queryByTestId('browser-error-banner')).not.toBeInTheDocument();
  });

  it('normalizes bare domain to https://', () => {
    const api = createBrowserAPI();
    render(<MainPanel api={api} />);

    const addressBar = screen.getByTestId('browser-address-bar') as HTMLInputElement;
    fireEvent.change(addressBar, { target: { value: 'example.com' } });
    fireEvent.keyDown(addressBar, { key: 'Enter' });

    // Address bar should now show normalized URL
    expect(addressBar.value).toBe('https://example.com');
  });

  it('updates browserState on navigation', () => {
    const api = createBrowserAPI();
    render(<MainPanel api={api} />);

    const addressBar = screen.getByTestId('browser-address-bar');
    fireEvent.change(addressBar, { target: { value: 'https://example.com' } });
    fireEvent.keyDown(addressBar, { key: 'Enter' });

    expect(browserState.currentUrl).toBe('https://example.com');
  });

  it('sets window title on navigation', () => {
    const api = createBrowserAPI();
    render(<MainPanel api={api} />);

    const addressBar = screen.getByTestId('browser-address-bar');
    fireEvent.change(addressBar, { target: { value: 'https://example.com' } });
    fireEvent.keyDown(addressBar, { key: 'Enter' });

    expect(api.window.setTitle).toHaveBeenCalled();
  });

  it('shows error for non-localhost HTTP', () => {
    const api = createBrowserAPI({ allowLocalhost: true });
    render(<MainPanel api={api} />);

    const addressBar = screen.getByTestId('browser-address-bar');
    fireEvent.change(addressBar, { target: { value: 'http://example.com' } });
    fireEvent.keyDown(addressBar, { key: 'Enter' });

    expect(screen.getByTestId('browser-error-banner')).toBeInTheDocument();
    expect(screen.getByTestId('browser-error-banner').textContent).toContain('HTTPS');
  });

  it('clears error on successful navigation', () => {
    const api = createBrowserAPI();
    render(<MainPanel api={api} />);

    const addressBar = screen.getByTestId('browser-address-bar');

    // First navigate to blocked URL
    fireEvent.change(addressBar, { target: { value: 'http://example.com' } });
    fireEvent.keyDown(addressBar, { key: 'Enter' });
    expect(screen.getByTestId('browser-error-banner')).toBeInTheDocument();

    // Then navigate to valid URL
    fireEvent.change(addressBar, { target: { value: 'https://example.com' } });
    fireEvent.keyDown(addressBar, { key: 'Enter' });
    expect(screen.queryByTestId('browser-error-banner')).not.toBeInTheDocument();
  });

  it('does not navigate on non-Enter key', () => {
    const api = createBrowserAPI();
    render(<MainPanel api={api} />);

    const addressBar = screen.getByTestId('browser-address-bar');
    fireEvent.change(addressBar, { target: { value: 'https://example.com' } });
    fireEvent.keyDown(addressBar, { key: 'a' });

    expect(browserState.currentUrl).toBe('');
  });
});

// ── SidebarPanel component tests ────────────────────────────────────────

describe('Browser SidebarPanel', () => {
  beforeEach(() => {
    browserState.reset();
  });

  it('renders "Protocols" header', () => {
    const api = createBrowserAPI();
    render(<SidebarPanel api={api} />);
    expect(screen.getByText('Protocols')).toBeInTheDocument();
  });

  it('renders "History" header', () => {
    const api = createBrowserAPI();
    render(<SidebarPanel api={api} />);
    expect(screen.getByText('History')).toBeInTheDocument();
  });

  it('shows "No pages visited yet" when history is empty', () => {
    const api = createBrowserAPI();
    render(<SidebarPanel api={api} />);
    expect(screen.getByText('No pages visited yet')).toBeInTheDocument();
  });

  it('shows HTTPS protocol as always enabled', () => {
    const api = createBrowserAPI();
    render(<SidebarPanel api={api} />);
    expect(screen.getByText('HTTPS')).toBeInTheDocument();
  });

  it('shows Localhost protocol status', () => {
    const api = createBrowserAPI();
    render(<SidebarPanel api={api} />);
    expect(screen.getByText('Localhost')).toBeInTheDocument();
  });

  it('shows File protocol status', () => {
    const api = createBrowserAPI();
    render(<SidebarPanel api={api} />);
    expect(screen.getByText('File')).toBeInTheDocument();
  });

  it('shows history entries when pages visited', () => {
    browserState.setCurrentPage('https://example.com', 'Example');
    browserState.setCurrentPage('https://other.com', 'Other Site');

    const api = createBrowserAPI();
    render(<SidebarPanel api={api} />);

    expect(screen.getByText('Other Site')).toBeInTheDocument();
    expect(screen.getByText('Example')).toBeInTheDocument();
  });

  it('clicking history entry updates browserState', () => {
    browserState.setCurrentPage('https://example.com', 'Example');
    browserState.setCurrentPage('https://other.com', 'Other');

    const api = createBrowserAPI();
    render(<SidebarPanel api={api} />);

    fireEvent.click(screen.getByText('Example'));
    expect(browserState.currentUrl).toBe('https://example.com');
  });
});

// ── Cross-panel integration ─────────────────────────────────────────────

describe('Browser cross-panel integration', () => {
  beforeEach(() => {
    browserState.reset();
  });

  it('deactivate resets browserState used by both panels', () => {
    browserState.setCurrentPage('https://test.com', 'Test');
    expect(browserState.currentUrl).not.toBe('');
    expect(browserState.history.length).toBeGreaterThan(0);

    deactivate();

    expect(browserState.currentUrl).toBe('');
    expect(browserState.history).toEqual([]);
  });
});

// ── activate/deactivate ─────────────────────────────────────────────────

describe('Browser activate/deactivate', () => {
  beforeEach(() => {
    browserState.reset();
  });

  it('activate registers commands and canvas widget', () => {
    const ctx = createMockContext({ pluginId: 'browser' });
    const api = createMockAPI();
    const registerSpy = vi.spyOn(api.commands, 'register');
    const canvasRegisterSpy = vi.spyOn(api.canvas, 'registerWidgetType');

    activate(ctx, api);

    expect(registerSpy).toHaveBeenCalledWith('reload', expect.any(Function));
    expect(registerSpy).toHaveBeenCalledWith('devtools', expect.any(Function));
    expect(canvasRegisterSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'webview' }));
    expect(ctx.subscriptions).toHaveLength(3);
  });

  it('deactivate does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });

  it('deactivate resets browserState', () => {
    browserState.setCurrentPage('https://example.com', 'Example');
    deactivate();
    expect(browserState.currentUrl).toBe('');
    expect(browserState.history).toEqual([]);
  });
});
