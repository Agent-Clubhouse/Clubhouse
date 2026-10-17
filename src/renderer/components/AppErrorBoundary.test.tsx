import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from './AppErrorBoundary';
import { _resetRendererTelemetryForTests, _setStateForTests, flushTelemetry, initRendererTelemetry } from '../telemetry/facade';

vi.mock('../plugins/renderer-logger', () => ({ rendererLog: vi.fn() }));

const emit = vi.fn();

function Boom(): JSX.Element {
  throw new TypeError('render exploded with /Users/someone/secret');
}

beforeEach(() => {
  emit.mockClear();
  initRendererTelemetry({ emit, rendererReady: vi.fn(), getState: async () => ({ enabled: true, level: 'standard' }), onStateChanged: () => () => {} });
  _setStateForTests({ enabled: true, level: 'errors' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  _resetRendererTelemetryForTests();
  vi.restoreAllMocks();
});

describe('AppErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(<AppErrorBoundary><span>fine</span></AppErrorBoundary>);
    expect(screen.getByText('fine')).toBeTruthy();
  });

  it('shows a reload fallback and reports the error class, not the message', () => {
    render(<AppErrorBoundary><Boom /></AppErrorBoundary>);
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload window' })).toBeTruthy();
    flushTelemetry();
    const items = emit.mock.calls[0][0].items;
    expect(items[0]).toMatchObject({ t: 'exception', errorType: 'TypeError', handled: true });
    expect(items[0].attrs).toContainEqual({ key: 'clubhouse.error.boundary', kind: 'enum', value: 'app' });
    expect(JSON.stringify(items)).not.toContain('render exploded');
  });
});
