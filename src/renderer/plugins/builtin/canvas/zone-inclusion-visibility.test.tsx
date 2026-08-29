/**
 * Regression tests for #1543 — a widget that gets included in a zone by dragging
 * the zone over it rendered invisible until it was clicked.
 *
 * Zones deliberately do not swallow existing widgets when created, so the
 * supported way to put an older widget into a zone is to drag/resize the zone
 * over it. The zone then outranks that widget on the shared zIndex counter, and
 * its opaque background painted over the widget until a click bumped the widget
 * to the front. These tests drive that exact path — gesture → store → render —
 * and assert the widget is painted above the zone background straight away.
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { CanvasWorkspace } from './CanvasWorkspace';
import { createCanvasStore } from './canvas-store';
import type { CanvasView, Viewport, ZoneCanvasView, Position } from './canvas-types';
import type { PluginAPI } from '../../../../shared/plugin-types';

const defaultViewport: Viewport = { panX: 0, panY: 0, zoom: 1 };

function stubApi(): PluginAPI {
  return {
    agents: {
      list: () => [],
      onAnyChange: () => ({ dispose: () => {} }),
      getDetailedStatus: () => null,
    },
    projects: { list: () => [] },
    context: { mode: 'project', projectId: 'p1' },
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

function renderWorkspace(views: CanvasView[], overrides: Partial<React.ComponentProps<typeof CanvasWorkspace>> = {}) {
  const props = {
    views,
    viewport: defaultViewport,
    zoomedViewId: null,
    selectedViewId: null,
    selectedViewIds: [] as string[],
    wireDefinitions: [],
    onAddWireDefinition: vi.fn(),
    onRemoveWireDefinition: vi.fn(),
    onUpdateWireDefinition: vi.fn(),
    api: stubApi(),
    onViewportChange: vi.fn(),
    onAddView: vi.fn(),
    onAddPluginView: vi.fn(),
    onRemoveView: vi.fn(),
    onMoveView: vi.fn(),
    onMoveViews: vi.fn(),
    onResizeView: vi.fn(),
    onFocusView: vi.fn(),
    onUpdateView: vi.fn(),
    onZoomView: vi.fn(),
    onSelectView: vi.fn(),
    onToggleSelectView: vi.fn(),
    onSetSelectedViewIds: vi.fn(),
    onClearSelection: vi.fn(),
    onRemoveZone: vi.fn(),
    onUpdateZoneTheme: vi.fn(),
    minimapAutoHide: false,
    onMinimapAutoHideChange: vi.fn(),
    elkAlgorithm: 'layered' as const,
    elkDirection: 'RIGHT' as const,
    layoutCenterId: null,
    onElkAlgorithmChange: vi.fn(),
    onElkDirectionChange: vi.fn(),
    onSetLayoutCenterId: vi.fn(),
    ...overrides,
  };
  return render(<CanvasWorkspace {...props} />);
}

/** Effective stacking value of a rendered element ('auto' → 0). */
function zOf(el: HTMLElement): number {
  const raw = el.style.zIndex;
  return raw === '' || raw === 'auto' ? 0 : Number(raw);
}

/**
 * Card first, then zone — so the zone outranks the card on the shared zIndex
 * counter, which is what made the card disappear once it was included.
 */
function seedCardThenZone() {
  const store = createCanvasStore();
  const cardId = store.getState().addView('agent', { x: 900, y: 900 });
  const zoneId = store.getState().addView('zone', { x: 0, y: 0 });
  return { store, cardId, zoneId };
}

function getZone(store: ReturnType<typeof createCanvasStore>, zoneId: string): ZoneCanvasView {
  return store.getState().views.find((v) => v.id === zoneId) as ZoneCanvasView;
}

function getView(store: ReturnType<typeof createCanvasStore>, viewId: string): CanvasView {
  return store.getState().views.find((v) => v.id === viewId)!;
}

describe('zone inclusion by drag — widget visibility (#1543)', () => {
  it('sets up the ordering that used to hide the widget: zone outranks the older card', () => {
    const { store, cardId, zoneId } = seedCardThenZone();

    expect(getView(store, cardId).zIndex).toBeLessThan(getZone(store, zoneId).zIndex);
    // Creating a zone must not swallow the pre-existing card...
    expect(getZone(store, zoneId).containedViewIds).toEqual([]);
  });

  it('includes the card when the zone is dragged over it', () => {
    const { store, cardId, zoneId } = seedCardThenZone();

    // Drag the zone so it covers >50% of the card.
    store.getState().moveViews(new Map<string, Position>([[zoneId, { x: 800, y: 760 }]]));

    expect(getZone(store, zoneId).containedViewIds).toContain(cardId);
  });

  it('paints the newly included card above the zone background', () => {
    const { store, cardId, zoneId } = seedCardThenZone();
    store.getState().moveViews(new Map<string, Position>([[zoneId, { x: 800, y: 760 }]]));
    expect(getZone(store, zoneId).containedViewIds).toContain(cardId);

    const { getByTestId } = renderWorkspace(store.getState().views);

    const background = getByTestId(`zone-background-${zoneId}`);
    const card = getByTestId(`canvas-view-${cardId}`);

    // The card is not focused — it must still be visible on top of the zone.
    expect(zOf(background)).toBeLessThan(zOf(card));
  });

  it('keeps the card above the zone through the full drag gesture', () => {
    const { store, cardId, zoneId } = seedCardThenZone();

    const onMoveViews = vi.fn((positions: Map<string, Position>) => {
      store.getState().moveViews(positions);
    });
    const { getByTestId, rerender } = renderWorkspace(store.getState().views, { onMoveViews });

    // Grab the zone by its card's drag handle and drag it over the widget.
    const handle = getByTestId(`zone-drag-handle-${zoneId}`);
    fireEvent.mouseDown(handle, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 800, clientY: 760 });
    fireEvent.mouseUp(window, { clientX: 800, clientY: 760 });

    expect(onMoveViews).toHaveBeenCalled();
    expect(getZone(store, zoneId).containedViewIds).toContain(cardId);

    rerender(<div />);
    const { getByTestId: get2 } = renderWorkspace(store.getState().views);
    expect(zOf(get2(`zone-background-${zoneId}`))).toBeLessThan(zOf(get2(`canvas-view-${cardId}`)));
  });

  it('keeps every widget above the zone background regardless of creation order', () => {
    const { store, cardId, zoneId } = seedCardThenZone();
    // A widget created after the zone (higher zIndex) must stay above it too.
    const laterCardId = store.getState().addView('agent', { x: 1000, y: 950 });
    store.getState().moveViews(new Map<string, Position>([[zoneId, { x: 800, y: 760 }]]));

    const { getByTestId } = renderWorkspace(store.getState().views);
    const bgZ = zOf(getByTestId(`zone-background-${zoneId}`));

    expect(bgZ).toBeLessThan(zOf(getByTestId(`canvas-view-${cardId}`)));
    expect(bgZ).toBeLessThan(zOf(getByTestId(`canvas-view-${laterCardId}`)));
  });
});
