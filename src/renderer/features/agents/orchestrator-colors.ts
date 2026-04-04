/**
 * Color mappings for orchestrator and model badges.
 * Uses CSS custom properties (--ctp-badge-*) for theme compatibility.
 */

export const ORCHESTRATOR_COLORS: Record<string, { bg: string; text: string }> = {
  'claude-code': { bg: 'rgb(var(--ctp-badge-orange) / 0.2)', text: 'rgb(var(--ctp-badge-orange))' },
  'copilot-cli': { bg: 'rgb(var(--ctp-badge-blue) / 0.2)', text: 'rgb(var(--ctp-badge-blue))' },
};
export const DEFAULT_ORCH_COLOR = { bg: 'rgb(var(--ctp-badge-grey) / 0.2)', text: 'rgb(var(--ctp-badge-grey))' };

const MODEL_PALETTE = [
  { bg: 'rgb(var(--ctp-badge-purple) / 0.2)', text: 'rgb(var(--ctp-badge-purple))' },
  { bg: 'rgb(var(--ctp-badge-teal) / 0.2)',   text: 'rgb(var(--ctp-badge-teal))' },
  { bg: 'rgb(var(--ctp-badge-pink) / 0.2)',   text: 'rgb(var(--ctp-badge-pink))' },
  { bg: 'rgb(var(--ctp-badge-green) / 0.2)',  text: 'rgb(var(--ctp-badge-green))' },
  { bg: 'rgb(var(--ctp-badge-amber) / 0.2)',  text: 'rgb(var(--ctp-badge-amber))' },
  { bg: 'rgb(var(--ctp-badge-indigo) / 0.2)', text: 'rgb(var(--ctp-badge-indigo))' },
  { bg: 'rgb(var(--ctp-badge-sky) / 0.2)',    text: 'rgb(var(--ctp-badge-sky))' },
];

const modelColorCache = new Map<string, { bg: string; text: string }>();

export function getModelColor(model: string): { bg: string; text: string } {
  let color = modelColorCache.get(model);
  if (!color) {
    let hash = 0;
    for (let i = 0; i < model.length; i++) hash = (hash * 31 + model.charCodeAt(i)) | 0;
    color = MODEL_PALETTE[((hash % MODEL_PALETTE.length) + MODEL_PALETTE.length) % MODEL_PALETTE.length];
    modelColorCache.set(model, color);
  }
  return color;
}

export function getOrchestratorColor(id: string): { bg: string; text: string } {
  return ORCHESTRATOR_COLORS[id] || DEFAULT_ORCH_COLOR;
}

/**
 * Format an orchestrator ID into a display label.
 * Prefers the displayName from the provided orchestrator list, falling back
 * to a static map of known display names, then to the raw ID.
 */
const ORCHESTRATOR_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'copilot-cli': 'GitHub Copilot',
  'codex-cli': 'Codex',
};

export function getOrchestratorLabel(
  orchId: string,
  allOrchestrators?: Array<{ id: string; shortName?: string; displayName?: string }>,
): string {
  const info = allOrchestrators?.find((o) => o.id === orchId);
  if (info) return info.displayName || info.shortName || orchId;
  return ORCHESTRATOR_DISPLAY_NAMES[orchId] || orchId;
}

/**
 * Format a model string into a display label.
 * Capitalizes the first letter (e.g., "sonnet" → "Sonnet").
 */
export function formatModelLabel(model: string | undefined): string {
  if (!model || model === 'default') return 'Default';
  return model.charAt(0).toUpperCase() + model.slice(1);
}
