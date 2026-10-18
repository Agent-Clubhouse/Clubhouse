import { describe, it, expect, vi } from 'vitest';
import { queueAgentCard, takeAgentCards, subscribeAgentCards, placeAgentCard, canvasOfView, type PendingAgentCard } from './agent-card-queue';
import type { CanvasView } from './canvas-types';

const card = (over: Partial<PendingAgentCard> = {}): PendingAgentCard => ({
  canvasId: 'c1',
  parentViewId: 'parent',
  fallback: { position: { x: 0, y: 0 }, size: { width: 400, height: 300 } },
  agentId: 'agent-1',
  ...over,
});

const view = (id: string, x: number, y: number, width = 400, height = 300) =>
  ({ id, type: 'agent', position: { x, y }, size: { width, height } }) as unknown as CanvasView;

describe('agent card queue', () => {
  it('hands back only the cards for the active canvas, once', () => {
    const owner = {};
    queueAgentCard(owner, card({ agentId: 'a' }));
    queueAgentCard(owner, card({ agentId: 'b', canvasId: 'c2' }));
    expect(takeAgentCards(owner, 'c1', ['c1', 'c2']).map((c) => c.agentId)).toEqual(['a']);
    expect(takeAgentCards(owner, 'c1', ['c1', 'c2'])).toEqual([]);
    // The other canvas's card waits until that canvas is active.
    expect(takeAgentCards(owner, 'c2', ['c1', 'c2']).map((c) => c.agentId)).toEqual(['b']);
  });

  it('drops cards for a canvas that was deleted', () => {
    const owner = {};
    queueAgentCard(owner, card({ canvasId: 'gone' }));
    expect(takeAgentCards(owner, 'c1', ['c1'])).toEqual([]);
    expect(takeAgentCards(owner, 'gone', ['gone'])).toEqual([]);
  });

  it('keeps queues apart per store', () => {
    const a = {};
    const b = {};
    queueAgentCard(a, card());
    expect(takeAgentCards(b, 'c1', ['c1'])).toEqual([]);
    expect(takeAgentCards(a, 'c1', ['c1'])).toHaveLength(1);
  });

  it('tells subscribers when a card is queued, until they unsubscribe', () => {
    const owner = {};
    const fn = vi.fn();
    const off = subscribeAgentCards(owner, fn);
    queueAgentCard(owner, card());
    off();
    queueAgentCard(owner, card());
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('placeAgentCard', () => {
  it('places next to where the parent is now, not where it was when New agent was chosen', () => {
    const placed = placeAgentCard(card(), [view('parent', 1000, 600)]);
    expect(placed.position.x).toBeGreaterThanOrEqual(1400);
    expect(placed.position.y).toBeGreaterThanOrEqual(500);
    expect(placed.position.y).toBeLessThanOrEqual(700);
  });

  it('takes the parent size as it is now', () => {
    const placed = placeAgentCard(card(), [view('parent', 0, 0, 640, 520)]);
    expect(placed.size).toEqual({ width: 640, height: 520 });
  });

  it('falls back to the parent bounds from when New agent was chosen if the parent is gone', () => {
    const placed = placeAgentCard(card({ fallback: { position: { x: 200, y: 200 }, size: { width: 400, height: 300 } } }), []);
    expect(placed.size).toEqual({ width: 400, height: 300 });
    expect(placed.position.x).toBeGreaterThanOrEqual(600);
  });

  it('does not land on top of another card', () => {
    const views = [view('parent', 0, 0), view('neighbour', 440, 0)];
    const placed = placeAgentCard(card(), views);
    const overlaps = views.some((v) =>
      placed.position.x < v.position.x + v.size.width && placed.position.x + 400 > v.position.x
      && placed.position.y < v.position.y + v.size.height && placed.position.y + 300 > v.position.y);
    expect(overlaps).toBe(false);
  });
});

describe('canvasOfView', () => {
  const canvases = [
    { id: 'c1', views: [view('a', 0, 0)] },
    { id: 'c2', views: [view('parent', 0, 0)] },
  ];

  it('finds the canvas the card is on, even when another canvas is active', () => {
    expect(canvasOfView(canvases, 'parent', 'c1')).toBe('c2');
  });

  it('falls back when no canvas has the card', () => {
    expect(canvasOfView(canvases, 'gone', 'c1')).toBe('c1');
  });
});
