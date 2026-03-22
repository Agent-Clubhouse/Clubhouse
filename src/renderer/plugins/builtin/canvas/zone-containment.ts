/**
 * Zone containment tracking — provides reactive hooks for determining
 * which zone (if any) a given view belongs to, and the theme override
 * that should apply.
 */

import { useMemo } from 'react';
import type { CanvasView, ZoneCanvasView } from './canvas-types';

export interface ZoneContainmentMap {
  /** viewId -> zoneId for all contained views */
  viewToZone: Map<string, string>;
  /** zoneId -> themeId */
  zoneThemes: Map<string, string>;
}

/** Build containment map from current views. Pure function. */
export function buildZoneContainmentMap(views: CanvasView[]): ZoneContainmentMap {
  const viewToZone = new Map<string, string>();
  const zoneThemes = new Map<string, string>();

  for (const view of views) {
    if (view.type !== 'zone') continue;
    const zone = view as ZoneCanvasView;
    zoneThemes.set(zone.id, zone.themeId);
    for (const containedId of zone.containedViewIds) {
      viewToZone.set(containedId, zone.id);
    }
  }

  return { viewToZone, zoneThemes };
}

/** Get the theme override for a view, or undefined if not in any zone. */
export function getViewThemeOverride(
  viewId: string,
  containmentMap: ZoneContainmentMap,
): string | undefined {
  const zoneId = containmentMap.viewToZone.get(viewId);
  if (!zoneId) return undefined;
  return containmentMap.zoneThemes.get(zoneId);
}

/** React hook: compute zone containment map from views. Memoized. */
export function useZoneContainment(views: CanvasView[]): ZoneContainmentMap {
  return useMemo(() => buildZoneContainmentMap(views), [views]);
}
