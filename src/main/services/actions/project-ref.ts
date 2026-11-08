/**
 * Find a project by id, name or path, for the Clubhouse MCP tools, which let
 * an agent name a project the way a person would.
 */

import * as path from 'path';
import { ActionError } from '../../../shared/actions';

export interface ProjectRefCandidate {
  id: string;
  name: string;
  displayName?: string;
  path: string;
}

/**
 * The id of the project `ref` names among `candidates`, or undefined when
 * none matches. Two with the name asked for are refused (invalid_input), so
 * the caller names one by path.
 */
export function matchProjectRef(
  candidates: readonly ProjectRefCandidate[],
  ref: string,
  samePath: (a: string, b: string) => boolean,
): string | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  if (candidates.some((p) => p.id === trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  const byName = candidates.filter((p) => (p.displayName || p.name).toLowerCase() === lower || p.name.toLowerCase() === lower);
  if (byName.length > 1) throw new ActionError('invalid_input', `More than one project is named "${trimmed}". Name it by its path instead.`);
  if (byName.length === 1) return byName[0].id;
  if (!path.isAbsolute(trimmed)) return undefined;
  return candidates.find((p) => samePath(p.path, trimmed))?.id;
}
