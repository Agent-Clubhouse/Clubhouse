import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { CanvasViewComponent } from './CanvasView';
import type { PluginCanvasView } from './canvas-types';
import type { PluginAPI } from '../../../../shared/plugin-types';
import { useRemoteProjectStore } from '../../../stores/remoteProjectStore';
import * as registry from '../../canvas-widget-registry';

// ── Fixtures ────────────────────────────────────────────────────────────

const noop = () => {};

function stubApi(projectId: string): PluginAPI {
  return {
    agents: {
      list: () => [],
      onAnyChange: () => ({ dispose: () => {} }),
      getDetailedStatus: () => null,
    },
    projects: { list: () => [] },
    context: { mode: 'project', projectId },
    widgets: {
      AgentAvatar: () => null,
      AgentTerminal: () => null,
      SleepingAgent: () => null,
    },
    settings: {
      get: () => undefined,
      getAll: () => ({}),
      set: () => {},
      onChange: () => ({ dispose: () => {} }),
    },
  } as unknown as PluginAPI;
}

function makePluginView(pluginId: string, widgetType: string): PluginCanvasView {
  return {
    id: 'cv_test_1',
    type: 'plugin',
    title: 'Test Widget',
    displayName: 'Test Widget',
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    zIndex: 0,
    metadata: {},
    pluginWidgetType: widgetType,
    pluginId,
  };
}

function renderPluginView(projectId: string, view: PluginCanvasView) {
  return render(
    <CanvasViewComponent
      view={view}
      api={stubApi(projectId)}
      zoom={1}
      isSelected={false}
      onClose={noop}
      onFocus={noop}
      onSelect={noop}
      onToggleSelect={noop}
      onCenterView={noop}
      onZoomView={noop}
      onDragStart={noop}
      onDragEnd={noop}
      onResizeEnd={noop}
      onUpdate={noop}
    />,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('CanvasView annex plugin widget gate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    registry._resetRegistryForTesting();
  });

  it('blocks non-annex-enabled plugin widget on remote project', () => {
    const satelliteId = 'sat-fp';
    const remoteProjectId = `remote||${satelliteId}||proj-1`;

    useRemoteProjectStore.setState({
      pluginMatchState: {
        [satelliteId]: [
          { id: 'browser', name: 'Browser', status: 'matched', annexEnabled: false, scope: 'project' },
        ],
      },
    });

    // Register a widget so it would normally render
    const TestComponent = () => <div data-testid="widget-content">Widget</div>;
    registry.registerCanvasWidgetType('browser', { id: 'webview', label: 'Browser' }, { id: 'webview', component: TestComponent });

    const view = makePluginView('browser', 'plugin:browser:webview');
    renderPluginView(remoteProjectId, view);

    expect(screen.queryByTestId('widget-content')).not.toBeInTheDocument();
    expect(screen.getByText(/Browser unavailable over Annex/)).toBeInTheDocument();
  });

  it('blocks plugin widget not found in match state on remote project', () => {
    const satelliteId = 'sat-fp';
    const remoteProjectId = `remote||${satelliteId}||proj-1`;

    useRemoteProjectStore.setState({
      pluginMatchState: { [satelliteId]: [] },
    });

    const TestComponent = () => <div data-testid="widget-content">Widget</div>;
    registry.registerCanvasWidgetType('unknown', { id: 'chart', label: 'Chart' }, { id: 'chart', component: TestComponent });

    const view = makePluginView('unknown', 'plugin:unknown:chart');
    renderPluginView(remoteProjectId, view);

    expect(screen.queryByTestId('widget-content')).not.toBeInTheDocument();
    expect(screen.getByText(/unknown unavailable over Annex/)).toBeInTheDocument();
  });

  it('allows annex-enabled plugin widget on remote project', () => {
    const satelliteId = 'sat-fp';
    const remoteProjectId = `remote||${satelliteId}||proj-1`;

    useRemoteProjectStore.setState({
      pluginMatchState: {
        [satelliteId]: [
          { id: 'my-plugin', name: 'My Plugin', status: 'matched', annexEnabled: true, scope: 'project' },
        ],
      },
    });

    const TestComponent = () => <div data-testid="widget-content">Widget</div>;
    registry.registerCanvasWidgetType('my-plugin', { id: 'chart', label: 'Chart' }, { id: 'chart', component: TestComponent });

    const view = makePluginView('my-plugin', 'plugin:my-plugin:chart');
    renderPluginView(remoteProjectId, view);

    expect(screen.getByTestId('widget-content')).toBeInTheDocument();
  });

  it('allows plugin widget on local (non-remote) project regardless', () => {
    const TestComponent = () => <div data-testid="widget-content">Widget</div>;
    registry.registerCanvasWidgetType('browser', { id: 'webview', label: 'Browser' }, { id: 'webview', component: TestComponent });

    const view = makePluginView('browser', 'plugin:browser:webview');
    renderPluginView('local-proj-1', view);

    expect(screen.getByTestId('widget-content')).toBeInTheDocument();
  });
});
