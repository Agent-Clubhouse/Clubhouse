/** Color mappings for orchestrator and model badges */

export const ORCHESTRATOR_COLORS: Record<string, { bg: string; text: string }> = {
  'claude-code': { bg: 'rgba(249,115,22,0.2)', text: '#fb923c' },   // orange
  'copilot-cli': { bg: 'rgba(59,130,246,0.2)', text: '#60a5fa' },   // blue
};
export const DEFAULT_ORCH_COLOR = { bg: 'rgba(148,163,184,0.2)', text: '#94a3b8' }; // grey

const MODEL_PALETTE = [
  { bg: 'rgba(168,85,247,0.2)',  text: '#c084fc' },  // purple
  { bg: 'rgba(20,184,166,0.2)',  text: '#2dd4bf' },  // teal
  { bg: 'rgba(236,72,153,0.2)',  text: '#f472b6' },  // pink
  { bg: 'rgba(34,197,94,0.2)',   text: '#4ade80' },  // green
  { bg: 'rgba(251,191,36,0.2)',  text: '#fbbf24' },  // amber
  { bg: 'rgba(99,102,241,0.2)',  text: '#818cf8' },  // indigo
  { bg: 'rgba(14,165,233,0.2)',  text: '#38bdf8' },  // sky
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
 * Looks up the shortName from the provided orchestrator list, falling back
 * to a static map of known short names, then to the raw ID.
 */
const ORCHESTRATOR_SHORT_NAMES: Record<string, string> = {
  'claude-code': 'CC',
  'copilot-cli': 'GHCP',
  'opencode': 'OC',
};

export function getOrchestratorLabel(
  orchId: string,
  allOrchestrators?: Array<{ id: string; shortName?: string; displayName?: string }>,
): string {
  const info = allOrchestrators?.find((o) => o.id === orchId);
  if (info) return info.shortName || info.displayName || orchId;
  return ORCHESTRATOR_SHORT_NAMES[orchId] || orchId;
}

/**
 * Format a model string into a display label.
 * Capitalizes the first letter (e.g., "sonnet" → "Sonnet").
 */
export function formatModelLabel(model: string | undefined): string {
  if (!model || model === 'default') return 'Default';
  return model.charAt(0).toUpperCase() + model.slice(1);
}
