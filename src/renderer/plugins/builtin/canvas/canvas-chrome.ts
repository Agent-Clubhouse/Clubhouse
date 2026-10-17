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
  /** Wire dialogs, which open over the wire popover. */
  dialog: Z_INDEX.top,
} as const;

/**
 * Button classes matching the shared Button kinds (#2014): 28px, radius 6,
 * 12px text. Swap for <Button kind=…> once components/Button.tsx lands.
 */
const BUTTON_BASE = 'inline-flex flex-shrink-0 items-center justify-center gap-1.5 h-7 px-2.5 rounded-md border text-xs font-medium whitespace-nowrap transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
export const BUTTON = {
  primary: `${BUTTON_BASE} bg-ctp-accent border-ctp-accent text-ctp-crust enabled:hover:bg-ctp-accent/90`,
  ghost: `${BUTTON_BASE} bg-transparent border-surface-1 text-ctp-subtext1 enabled:hover:bg-surface-0 enabled:hover:text-ctp-text`,
  quiet: `${BUTTON_BASE} bg-transparent border-transparent text-ctp-subtext1 enabled:hover:bg-surface-0 enabled:hover:text-ctp-text`,
  danger: `${BUTTON_BASE} bg-transparent border-surface-1 text-ctp-red enabled:hover:bg-surface-0`,
} as const;
