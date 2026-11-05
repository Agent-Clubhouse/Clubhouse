/**
 * Features that left Experimental for v1.0.0. They stay in
 * experimental-settings.json, so a saved false is kept, and a missing key means on.
 */
export function isGraduatedFlagOn(settings: Record<string, boolean | undefined> | null | undefined, key: string): boolean {
  return settings?.[key] !== false;
}
