import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PendingWidgetPlaceholder, PENDING_WIDGET_TIMEOUT_MS } from './PendingWidgetPlaceholder';
import { usePluginStore } from '../../plugin-store';

const retryPluginActivation = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../plugin-loader', () => ({ retryPluginActivation }));

function registerPlugin(status: 'registered' | 'errored', error?: string): void {
  usePluginStore.setState({
    plugins: {
      'demo-plugin': {
        manifest: {
          id: 'demo-plugin',
          name: 'Demo',
          version: '1.0.0',
          engine: { api: 0.5 },
          scope: 'project',
          permissions: [],
        },
        source: 'builtin',
        pluginPath: '',
        status,
        error,
      },
    },
  } as Partial<ReturnType<typeof usePluginStore.getState>> as never);
}

describe('PendingWidgetPlaceholder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    retryPluginActivation.mockReturnValue(true);
    registerPlugin('registered');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the loading spinner before the timeout elapses', () => {
    render(<PendingWidgetPlaceholder pluginId="demo-plugin" label="Group Project" />);

    expect(screen.getByTestId('widget-loading')).toBeTruthy();

    act(() => { vi.advanceTimersByTime(PENDING_WIDGET_TIMEOUT_MS - 1); });

    expect(screen.getByTestId('widget-loading')).toBeTruthy();
    expect(screen.queryByTestId('widget-load-failed')).toBeNull();
  });

  it('surfaces a failure state with a retry button once the timeout elapses', () => {
    render(<PendingWidgetPlaceholder pluginId="demo-plugin" label="Group Project" />);

    act(() => { vi.advanceTimersByTime(PENDING_WIDGET_TIMEOUT_MS); });

    expect(screen.queryByTestId('widget-loading')).toBeNull();
    expect(screen.getByTestId('widget-load-failed')).toBeTruthy();
    expect(screen.getByTestId('widget-load-retry')).toBeTruthy();
  });

  it('honours a custom timeout', () => {
    render(<PendingWidgetPlaceholder pluginId="demo-plugin" timeoutMs={50} />);

    act(() => { vi.advanceTimersByTime(50); });

    expect(screen.getByTestId('widget-load-failed')).toBeTruthy();
  });

  it('shows the failure state immediately when the plugin is errored', () => {
    registerPlugin('errored', 'Activation failed: activate() timed out after 20000ms');

    render(<PendingWidgetPlaceholder pluginId="demo-plugin" label="Group Project" />);

    expect(screen.getByTestId('widget-load-failed')).toBeTruthy();
    expect(screen.getByText(/timed out after 20000ms/)).toBeTruthy();
  });

  it('re-dispatches activation and restarts the spinner when Retry is clicked', () => {
    render(<PendingWidgetPlaceholder pluginId="demo-plugin" timeoutMs={50} />);
    act(() => { vi.advanceTimersByTime(50); });

    fireEvent.click(screen.getByTestId('widget-load-retry'));

    expect(retryPluginActivation).toHaveBeenCalledWith('demo-plugin');
    // Back to loading, with a fresh timeout window.
    expect(screen.getByTestId('widget-loading')).toBeTruthy();

    act(() => { vi.advanceTimersByTime(50); });
    expect(screen.getByTestId('widget-load-failed')).toBeTruthy();
  });

  it('explains when a retry cannot be dispatched', () => {
    retryPluginActivation.mockReturnValue(false);
    render(<PendingWidgetPlaceholder pluginId="demo-plugin" timeoutMs={50} />);
    act(() => { vi.advanceTimersByTime(50); });

    fireEvent.click(screen.getByTestId('widget-load-retry'));

    expect(screen.getByTestId('widget-retry-unavailable')).toBeTruthy();
    // Stays on the failure state rather than pretending to reload.
    expect(screen.getByTestId('widget-load-failed')).toBeTruthy();
  });
});
