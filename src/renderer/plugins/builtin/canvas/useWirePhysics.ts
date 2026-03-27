/**
 * useWirePhysics — spring-physics hook that produces per-wire control point
 * offsets driven by view movement and ambient sway.
 *
 * Returns a Map of wireKey → { fromDx, fromDy, toDx, toDy } that can be
 * applied to bezier control points to create organic wire wiggle.
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import type { Edge } from './wire-utils';

// ── Spring constants ──────────────────────────────────────────────────

const STIFFNESS = 180;
const DAMPING = 12;
const MASS = 1;
const AMBIENT_AMP = 1.5;
const AMBIENT_FREQ = 0.3; // Hz
const MAX_OFFSET = 20;
const MAX_DT = 0.033; // clamp dt to ~30fps
const IDLE_THRESHOLD = 0.1;
/** Minimum visible change (px) before we push a new offsets map to React. */
const RENDER_THRESHOLD = 0.15;

export interface WireEndpointOffsets {
  fromDx: number;
  fromDy: number;
  toDx: number;
  toDy: number;
}

interface WireSpec {
  key: string;
  fromEdge: Edge;
  toEdge: Edge;
  fromViewId: string;
  toViewId: string;
}

interface EndpointSpring {
  displacementX: number;
  displacementY: number;
  velocityX: number;
  velocityY: number;
  prevX: number;
  prevY: number;
}

function perpDirection(edge: Edge): { x: number; y: number } {
  switch (edge) {
    case 'top':
    case 'bottom':
      return { x: 1, y: 0 };
    case 'left':
    case 'right':
      return { x: 0, y: 1 };
  }
}

function hashPhase(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return (hash & 0xffff) / 0xffff * Math.PI * 2;
}

function clamp(val: number, max: number): number {
  return Math.max(-max, Math.min(max, val));
}

export function useWirePhysics(
  wires: WireSpec[],
  viewPositions: Map<string, { x: number; y: number }> | undefined,
  enabled: boolean,
): Map<string, WireEndpointOffsets> {
  const [offsets, setOffsets] = useState<Map<string, WireEndpointOffsets>>(new Map());
  const prevOffsetsRef = useRef<Map<string, WireEndpointOffsets>>(new Map());
  const springsRef = useRef<Map<string, { from: EndpointSpring; to: EndpointSpring }>>(new Map());
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const viewPosRef = useRef(viewPositions);
  viewPosRef.current = viewPositions;

  // Track previous view positions to detect movement
  const prevViewPosRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  const wiresRef = useRef(wires);
  wiresRef.current = wires;

  const tick = useCallback((now: number) => {
    const currentWires = wiresRef.current;
    if (currentWires.length === 0) return;

    const t = now / 1000;
    const dt = lastTimeRef.current === 0
      ? 0.016
      : Math.min((now - lastTimeRef.current) / 1000, MAX_DT);
    lastTimeRef.current = now;

    const springs = springsRef.current;
    const currentViewPos = viewPosRef.current;
    const prevViewPos = prevViewPosRef.current;
    let anyActive = false;

    const newOffsets = new Map<string, WireEndpointOffsets>();

    for (const wire of currentWires) {
      // Ensure springs exist
      if (!springs.has(wire.key)) {
        const fromPos = currentViewPos?.get(wire.fromViewId) ?? { x: 0, y: 0 };
        const toPos = currentViewPos?.get(wire.toViewId) ?? { x: 0, y: 0 };
        springs.set(wire.key, {
          from: { displacementX: 0, displacementY: 0, velocityX: 0, velocityY: 0, prevX: fromPos.x, prevY: fromPos.y },
          to: { displacementX: 0, displacementY: 0, velocityX: 0, velocityY: 0, prevX: toPos.x, prevY: toPos.y },
        });
      }

      const spring = springs.get(wire.key)!;
      const phase = hashPhase(wire.key);

      // Process each endpoint (from and to)
      for (const [endpoint, edge, viewId] of [
        [spring.from, wire.fromEdge, wire.fromViewId],
        [spring.to, wire.toEdge, wire.toViewId],
      ] as [EndpointSpring, Edge, string][]) {
        // Detect view movement
        const currentPos = currentViewPos?.get(viewId);
        const prevPos = prevViewPos.get(viewId);
        if (currentPos && prevPos) {
          const moveDx = currentPos.x - prevPos.x;
          const moveDy = currentPos.y - prevPos.y;
          if (moveDx !== 0 || moveDy !== 0) {
            endpoint.displacementX -= moveDx * 0.3;
            endpoint.displacementY -= moveDy * 0.3;
          }
        }

        // Ambient sway (perpendicular to exit edge)
        const perp = perpDirection(edge);
        const sway = AMBIENT_AMP * Math.sin(t * 2 * Math.PI * AMBIENT_FREQ + phase);
        const ambientFx = perp.x * sway;
        const ambientFy = perp.y * sway;

        // Spring + damping
        const ax = (-STIFFNESS * endpoint.displacementX - DAMPING * endpoint.velocityX + ambientFx) / MASS;
        const ay = (-STIFFNESS * endpoint.displacementY - DAMPING * endpoint.velocityY + ambientFy) / MASS;
        endpoint.velocityX += ax * dt;
        endpoint.velocityY += ay * dt;
        endpoint.displacementX += endpoint.velocityX * dt;
        endpoint.displacementY += endpoint.velocityY * dt;

        // Clamp
        endpoint.displacementX = clamp(endpoint.displacementX, MAX_OFFSET);
        endpoint.displacementY = clamp(endpoint.displacementY, MAX_OFFSET);

        // Update previous position
        if (currentPos) {
          endpoint.prevX = currentPos.x;
          endpoint.prevY = currentPos.y;
        }

        // Check if active
        if (
          Math.abs(endpoint.displacementX) > IDLE_THRESHOLD ||
          Math.abs(endpoint.displacementY) > IDLE_THRESHOLD ||
          Math.abs(endpoint.velocityX) > IDLE_THRESHOLD ||
          Math.abs(endpoint.velocityY) > IDLE_THRESHOLD
        ) {
          anyActive = true;
        }
      }

      newOffsets.set(wire.key, {
        fromDx: spring.from.displacementX,
        fromDy: spring.from.displacementY,
        toDx: spring.to.displacementX,
        toDy: spring.to.displacementY,
      });
    }

    // Ambient sway naturally keeps the loop alive because sway amplitude
    // (1.5) exceeds IDLE_THRESHOLD (0.1). No need to force anyActive here —
    // letting it go false when displacement and velocity settle allows the
    // RAF loop to sleep when the canvas is truly idle.

    // Update tracked previous positions
    if (currentViewPos) {
      for (const [id, pos] of currentViewPos) {
        prevViewPos.set(id, { x: pos.x, y: pos.y });
      }
    }

    // Only push to React when offsets changed enough to be visible,
    // avoiding a new Map + re-render on every animation frame.
    const prev = prevOffsetsRef.current;
    let changed = newOffsets.size !== prev.size;
    if (!changed) {
      for (const [key, o] of newOffsets) {
        const p = prev.get(key);
        if (
          !p ||
          Math.abs(o.fromDx - p.fromDx) > RENDER_THRESHOLD ||
          Math.abs(o.fromDy - p.fromDy) > RENDER_THRESHOLD ||
          Math.abs(o.toDx - p.toDx) > RENDER_THRESHOLD ||
          Math.abs(o.toDy - p.toDy) > RENDER_THRESHOLD
        ) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      prevOffsetsRef.current = newOffsets;
      setOffsets(newOffsets);
    }

    if (anyActive) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, []);

  useEffect(() => {
    if (!enabled || wires.length === 0) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      lastTimeRef.current = 0;
      return;
    }

    lastTimeRef.current = 0;
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [enabled, wires.length > 0, tick]);

  // Clean up stale spring entries
  useEffect(() => {
    const wireKeys = new Set(wires.map((w) => w.key));
    const springs = springsRef.current;
    for (const key of springs.keys()) {
      if (!wireKeys.has(key)) springs.delete(key);
    }
  }, [wires]);

  return offsets;
}
