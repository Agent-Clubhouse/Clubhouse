import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { CanvasContextMenu } from './CanvasContextMenu';
import * as widgetRegistry from '../../canvas-widget-registry';
import type { RegisteredCanvasWidget } from '../../canvas-widget-registry';

// ── Mock the canvas-widget-registry ──────────────────────────────────

vi.mock('../../canvas-widget-registry', () => ({
  getRegisteredWidgetTypes: vi.fn(),
  onRegistryChange: vi.fn(() => ({ dispose: vi.fn() })),
}));

const TEST_SVG_ICON = '<svg width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';

function makeWidget(overrides: Partial<RegisteredCanvasWidget> & { qualifiedType: string }): RegisteredCanvasWidget {
  return {
    pluginId: 'test-plugin',
    declaration: {
      id: 'test-widget',
      label: 'Test Widget',
      icon: TEST_SVG_ICON,
    },
    descriptor: {
      id: 'test-widget',
      component: () => null,
    },
    ...overrides,
  };
}

describe('CanvasContextMenu plugin widget icons', () => {
  const onSelect = vi.fn();
  const onDismiss = vi.fn();

  beforeEach(() => {
    onSelect.mockReset();
    onDismiss.mockReset();
    vi.mocked(widgetRegistry.getRegisteredWidgetTypes).mockReturnValue([]);
  });

  it('renders built-in item SVG icons as HTML elements, not plain text', () => {
    render(<CanvasContextMenu x={100} y={100} onSelect={onSelect} onDismiss={onDismiss} />);

    const builtinTypes = ['agent', 'browser', 'anchor'];
    for (const type of builtinTypes) {
      const button = screen.getByTestId(`canvas-context-menu-${type}`);
      const svgElement = button.querySelector('svg');
      expect(svgElement, `${type} should render an SVG icon`).not.toBeNull();
      expect(svgElement!.getAttribute('width')).toBe('18');
      expect(button.textContent).not.toContain('<svg');
    }
  });

  it('renders promoted plugin widget SVG icon as HTML, not raw text', () => {
    // plugin:files:file-viewer and plugin:terminal:shell are "promoted" widgets
    vi.mocked(widgetRegistry.getRegisteredWidgetTypes).mockReturnValue([
      makeWidget({
        qualifiedType: 'plugin:terminal:shell',
        pluginId: 'terminal',
        declaration: { id: 'shell', label: 'Terminal', icon: TEST_SVG_ICON },
      }),
    ]);

    render(<CanvasContextMenu x={100} y={100} onSelect={onSelect} onDismiss={onDismiss} />);

    const button = screen.getByTestId('canvas-context-menu-plugin:terminal:shell');
    // The SVG should be rendered as actual HTML, not as escaped text
    const svgElement = button.querySelector('svg');
    expect(svgElement).not.toBeNull();
    expect(svgElement!.getAttribute('width')).toBe('18');
    // Ensure the raw SVG string is NOT visible as text
    expect(button.textContent).not.toContain('<svg');
    expect(button.textContent).not.toContain('</svg>');
  });

  it('renders other (3rd-party) plugin widget SVG icon as HTML, not raw text', () => {
    vi.mocked(widgetRegistry.getRegisteredWidgetTypes).mockReturnValue([
      makeWidget({
        qualifiedType: 'plugin:my-plugin:chart',
        pluginId: 'my-plugin',
        declaration: { id: 'chart', label: 'Chart', icon: TEST_SVG_ICON },
      }),
    ]);

    render(<CanvasContextMenu x={100} y={100} onSelect={onSelect} onDismiss={onDismiss} />);

    const button = screen.getByTestId('canvas-context-menu-plugin:my-plugin:chart');
    const svgElement = button.querySelector('svg');
    expect(svgElement).not.toBeNull();
    expect(button.textContent).not.toContain('<svg');
  });

  it('falls back to "+" when no icon is provided', () => {
    vi.mocked(widgetRegistry.getRegisteredWidgetTypes).mockReturnValue([
      makeWidget({
        qualifiedType: 'plugin:my-plugin:no-icon',
        pluginId: 'my-plugin',
        declaration: { id: 'no-icon', label: 'No Icon Widget' },
      }),
    ]);

    render(<CanvasContextMenu x={100} y={100} onSelect={onSelect} onDismiss={onDismiss} />);

    const button = screen.getByTestId('canvas-context-menu-plugin:my-plugin:no-icon');
    expect(button.textContent).toContain('+');
    expect(button.querySelector('svg')).toBeNull();
  });
});
