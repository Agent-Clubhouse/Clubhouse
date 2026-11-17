/** Display names must never fall back to an internal project id. */
export function groupProjectLabel(displayName?: string, name?: string, fallback = 'Linked project'): string {
  return [displayName, name].find((value) => value?.trim() && !/proj_[\w-]+/.test(value)) || fallback;
}
