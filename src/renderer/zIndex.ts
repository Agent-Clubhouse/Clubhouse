/**
 * Named z-index scale — use these instead of ad-hoc numeric values.
 *
 * Tailwind utilities are also available (e.g. z-modal, z-toast) via @theme in index.css.
 * Use the CSS custom property form (style={{ zIndex: 'var(--z-top)' }}) or these constants
 * for inline styles where Tailwind classes aren't available.
 */
export const Z_INDEX = {
  raised: 10,            // Local absolute elements (drag handles, status badges)
  dropdownBackdrop: 40,  // Transparent backdrop for dismissing open dropdowns
  dropdown: 50,          // Dropdown menus, context menus, search results
  modal: 200,            // Modals and dialogs (full-screen fixed overlays)
  toast: 300,            // Toast notifications — must render above modals
  canvasOverlay: 9999,   // Canvas-specific overlays and critical app states
  canvasDialog: 10000,   // Canvas-specific dialogs (zone delete, plugin)
  top: 100000,           // Absolute top layer (blueprint/wire dialogs)
} as const;

export type ZIndexKey = keyof typeof Z_INDEX;
