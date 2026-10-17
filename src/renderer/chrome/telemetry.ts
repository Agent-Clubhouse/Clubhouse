/**
 * Telemetry call sites owned by the chrome redesign (docs/chrome-redesign-spec.md §8,
 * telemetry spec §9.1), built on the renderer facade.
 *
 * - `clubhouse.view` stays the coarse enum from the telemetry spec; the chrome
 *   sets it from the active tab and pane (`viewForTab`).
 * - `clubhouse.ui.surface` says where in the chrome the user is. It rides on
 *   feature-usage events, long-frame metrics and render-error reports.
 * - `clubhouse.ui.action_failed` reports catch sites that would otherwise only
 *   toast or swallow.
 * - `clubhouse.ui.chrome` (`legacy` | `v2`) is a resource attribute set by main
 *   for the whole session, so it is not repeated here.
 *
 * Every function is a cheap no-op while telemetry is off.
 */
import { ATTR, setTelemetrySurface, setTelemetryView, tel, type TelemetryView } from '../telemetry';

export type ChromeSurface = Parameters<typeof ATTR.uiSurface>[0];
export type ChromeFeature = Parameters<typeof ATTR.uiFeature>[0];
export type ChromeAction = Parameters<typeof ATTR.uiAction>[0];

const BUILTIN_VIEWS: Record<string, TelemetryView> = {
  'plugin:terminal': 'terminal',
  'plugin:files': 'files',
  'plugin:git': 'git',
  'plugin:canvas': 'canvas',
  'plugin:app:canvas': 'canvas',
};

/** Map the active explorer tab to the bounded `clubhouse.view` value. */
export function viewForTab(explorerTab: string): TelemetryView {
  if (explorerTab === 'agents') return 'agent';
  if (explorerTab === 'settings') return 'settings';
  if (BUILTIN_VIEWS[explorerTab]) return BUILTIN_VIEWS[explorerTab];
  if (explorerTab.startsWith('plugin:')) return 'plugin';
  return 'other';
}

let currentSurface: ChromeSurface = 'sidebar_agents';

export function reportChromeView(explorerTab: string): void {
  setTelemetryView(viewForTab(explorerTab));
}

/** Also feeds long-frame metrics and render-error reports (spec §8). */
export function reportChromeSurface(surface: ChromeSurface): void {
  currentSurface = surface;
  setTelemetrySurface(surface);
}

export function getChromeSurface(): ChromeSurface {
  return currentSurface;
}

export function reportChromeFeature(feature: ChromeFeature): void {
  tel.event('clubhouse.ui.feature_used', [ATTR.uiFeature(feature), ATTR.uiSurface(currentSurface)]);
}

/** `clubhouse.ui.action_failed` plus the exception class and stack (never the message). */
export function reportChromeActionFailed(action: ChromeAction, error: unknown): void {
  tel.event('clubhouse.ui.action_failed', [ATTR.uiAction(action), ATTR.errorType('unknown')]);
  tel.exception(error, { handled: true, attrs: [ATTR.uiAction(action)] });
}
