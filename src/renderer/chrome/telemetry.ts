/**
 * Telemetry call sites owned by the chrome redesign (docs/chrome-redesign-spec.md §8,
 * telemetry spec §9.1).
 *
 * These are deliberately thin stubs. The renderer telemetry facade ships in
 * telemetry Phase 3; once it is on main, each function below forwards to it and
 * the matching attribute values are added to src/shared/telemetry/attributes.ts
 * in the same PR. Until then they record nothing, so call sites can land now
 * without inventing a second pipeline.
 */

/** Bounded set of chrome surfaces (`c.ui.surface`). Plugin-owned lists all report `sidebar_list`. */
export type ChromeSurface =
  | 'sidebar_agents'
  | 'sidebar_list'
  | 'sidebar_settings'
  | 'start_page'
  | 'first_run'
  | 'host_menu'
  | 'more_menu'
  | 'hover_card'
  | 'row_menu';

/** Feature-usage events raised by the new chrome. */
export type ChromeFeature =
  | 'sidebar_toggle'
  | 'sidebar_resize'
  | 'tab_select'
  | 'project_select'
  | 'app_item_open';

export function reportChromeSurface(_surface: ChromeSurface): void {
  // Stub: forwards to the renderer facade once telemetry Phase 3 lands.
}

export function reportChromeFeature(_feature: ChromeFeature): void {
  // Stub: forwards to the renderer facade once telemetry Phase 3 lands.
}

/** `c.ui.action_failed` for catch sites in the new chrome. */
export function reportChromeActionFailed(_action: string, _error: unknown): void {
  // Stub: forwards to the renderer facade once telemetry Phase 3 lands.
}
