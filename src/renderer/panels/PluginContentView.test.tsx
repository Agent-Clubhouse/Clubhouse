import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { PluginErrorBoundary } from './PluginContentView';
import { usePluginStore } from '../plugins/plugin-store';

// Mock renderer-logger
vi.mock('../plugins/renderer-logger', () => ({
  rendererLog: vi.fn(),
}));

// Mock window.clubhouse.log for any transitive dependencies
Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      log: { write: vi.fn() },
    },
  },
  writable: true,
});

function ThrowingComponent({ message }: { message: string }) {
  throw new Error(message);
}

function GoodComponent() {
  return <div>Plugin works</div>;
}

describe('PluginErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    usePluginStore.setState({
      plugins: {
        'test-plugin': {
          manifest: {
            id: 'test-plugin',
            name: 'Test Plugin',
            version: '1.0.0',
            engine: { api: 0.5 },
            scope: 'project',
          },
          status: 'activated',
          source: 'community',
          pluginPath: '/plugins/test-plugin',
        },
      },
    });
  });

  it('renders children when no error', () => {
    render(
      <PluginErrorBoundary pluginId="test-plugin">
        <GoodComponent />
      </PluginErrorBoundary>
    );
    expect(screen.getByText('Plugin works')).toBeDefined();
  });

  it('shows fallback UI when child throws', () => {
    render(
      <PluginErrorBoundary pluginId="test-plugin">
        <ThrowingComponent message="render crash" />
      </PluginErrorBoundary>
    );
    expect(screen.getByText('Plugin Error')).toBeDefined();
    expect(screen.getByText(/encountered an error while rendering/)).toBeDefined();
    expect(screen.getByText('render crash')).toBeDefined();
  });

  it('shows expandable stack trace in fallback UI', () => {
    render(
      <PluginErrorBoundary pluginId="test-plugin">
        <ThrowingComponent message="crash with stack" />
      </PluginErrorBoundary>
    );
    expect(screen.getByText('Stack trace')).toBeDefined();
  });

  it('stores render error in plugin store', () => {
    render(
      <PluginErrorBoundary pluginId="test-plugin">
        <ThrowingComponent message="store this error" />
      </PluginErrorBoundary>
    );
    const entry = usePluginStore.getState().plugins['test-plugin'];
    expect(entry.status).toBe('errored');
    expect(entry.error).toContain('Render error: store this error');
  });
});
