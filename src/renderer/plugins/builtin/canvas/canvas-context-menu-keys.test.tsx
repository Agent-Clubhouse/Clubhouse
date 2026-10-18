import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { CanvasContextMenu } from './CanvasContextMenu';
import * as widgetRegistry from '../../canvas-widget-registry';
import { usePluginStore } from '../../plugin-store';
import { useMcpSettingsStore } from '../../../stores/mcpSettingsStore';

vi.mock('../../canvas-widget-registry', () => ({
  getRegisteredWidgetTypes: vi.fn(),
  onRegistryChange: vi.fn(() => ({ dispose: vi.fn() })),
}));

// The context menu is portalled to <body> but React bubbles its key events
// through the canvas workspace, whose onKeyDown pans on the arrow keys
// (useViewportControls). The menu marks the keys it handles with
// preventDefault, and the workspace skips those, so moving the menu's
// highlight doesn't also pan the board.
describe('CanvasContextMenu arrow keys', () => {
  beforeEach(() => {
    vi.mocked(widgetRegistry.getRegisteredWidgetTypes).mockReturnValue([]);
    useMcpSettingsStore.setState({ enabled: true, loaded: true } as never);
    usePluginStore.setState({ plugins: {}, appEnabled: [] } as never);
  });

  it.each(['ArrowDown', 'ArrowUp', 'Home', 'End'])('reaches the workspace as already handled: %s', (key) => {
    const seen: boolean[] = [];
    render(
      <div onKeyDown={(e) => seen.push(e.defaultPrevented)}>
        <CanvasContextMenu x={10} y={10} onSelect={vi.fn()} onDismiss={vi.fn()} />
      </div>,
    );
    fireEvent.keyDown(screen.getByTestId('canvas-context-menu-agent'), { key });
    expect(seen).toEqual([true]);
  });
});
