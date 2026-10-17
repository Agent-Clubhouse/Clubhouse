import { Z_INDEX } from '../../../zIndex';

/**
 * Canvas layers, named from zIndex.ts (#2020). The values match the raw
 * numbers they replace, so stacking does not change. World layers sit inside
 * the transformed canvas and must stay above any card's own zIndex counter.
 */
export const CANVAS_Z = {
  /** The minimap, under the pane overlays. */
  minimap: Z_INDEX.canvasOverlay - 9,
  /** Blueprint drop target over the board. */
  blueprintDrop: Z_INDEX.canvasOverlay - 2,
  /** Satellite pause overlay and off-screen attention arrows. */
  paneOverlay: Z_INDEX.canvasOverlay - 1,
  /** A zone's theme picker. */
  zonePopover: Z_INDEX.canvasDialog,
  /** Multi-drag count badge, in the world layer. */
  worldBadge: Z_INDEX.top - 3,
  /** Lasso rectangle and the wire being dragged, in the world layer. */
  worldTop: Z_INDEX.top - 2,
  /** Link and wire popovers on top of every card. */
  popover: Z_INDEX.top - 1,
} as const;
