/** Friendly names need an explicit identity match; a configured label is not a live report. */
export interface ProviderDisplayChoice { id?: string; label?: string }
export function admittedProviderLabel(id: string | null | undefined, current?: ProviderDisplayChoice, configured?: ProviderDisplayChoice): string | null {
  if (!id) return null;
  if (current?.id === id && current.label) return current.label;
  if (configured?.id === id && configured.label) return configured.label;
  return id;
}
/** Missing configured identity stays a separate next-start choice, never an inferred match. */
export function hasSeparateNextProvider(currentId: string | null | undefined, configuredId: string | undefined): boolean {
  return !!currentId && (!configuredId || configuredId !== currentId);
}
