/** The shape of a generated project id (project-store newProject): never shown as a name. */
const INTERNAL_PROJECT_ID = /\bproj_\d{10,}_[a-z0-9]+\b/i;

/** Display names must never fall back to an internal project id. A real name that merely contains "proj_" is kept. */
export function groupProjectLabel(displayName?: string, name?: string, fallback = 'Linked project'): string {
  return [displayName, name].find((value) => value?.trim() && !INTERNAL_PROJECT_ID.test(value)) || fallback;
}
