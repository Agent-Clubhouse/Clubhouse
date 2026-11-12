import type { GroupProjectScope } from './group-project-types';

export class GroupProjectScopeError extends Error {
  constructor(readonly code: 'invalid_scope' | 'network_unavailable', message: string) {
    super(message);
    this.name = 'GroupProjectScopeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function projectId(value: unknown, registered: ReadonlySet<string>): string {
  if (typeof value !== 'string' || !value || !registered.has(value)) {
    throw new GroupProjectScopeError('invalid_scope', 'Group project scope must name a registered project id.');
  }
  return value;
}

/** Validate untrusted creation options before choosing a canonical scope. */
export function resolveGroupProjectScope(options: unknown, registered: ReadonlySet<string>): GroupProjectScope {
  const input = options === undefined ? {} : options;
  if (!isRecord(input)) {
    throw new GroupProjectScopeError('invalid_scope', 'Group project creation options must be an object.');
  }
  const defaultProjectId = input.projectId === undefined ? undefined : projectId(input.projectId, registered);
  if (input.scope === undefined) {
    return defaultProjectId === undefined
      ? { level: 'app', reach: 'local' }
      : { level: 'project', projectId: defaultProjectId, reach: 'local' };
  }
  const scope = input.scope;
  if (!isRecord(scope) || (scope.level !== 'app' && scope.level !== 'project')
    || (scope.reach !== 'local' && scope.reach !== 'network')) {
    throw new GroupProjectScopeError('invalid_scope', 'Group project scope must specify project or app, and local or network.');
  }
  let result: GroupProjectScope;
  if (scope.level === 'project') {
    const id = projectId(scope.projectId, registered);
    if (defaultProjectId !== undefined && defaultProjectId !== id) {
      throw new GroupProjectScopeError('invalid_scope', 'The explicit group project scope conflicts with the supplied project id.');
    }
    result = { level: 'project', projectId: id, reach: scope.reach };
  } else {
    if (scope.projectId !== undefined) {
      throw new GroupProjectScopeError('invalid_scope', 'An app-scoped group project cannot name a project id in its scope.');
    }
    result = { level: 'app', reach: scope.reach };
  }
  if (result.reach === 'network') {
    throw new GroupProjectScopeError('network_unavailable', 'Network group projects are unavailable until the authoritative Annex host path is ready.');
  }
  return result;
}

/** Infer scope once for a legacy record, without adding or removing members. */
export function inferLegacyGroupProjectScope(memberProjectIds: readonly (string | null | undefined)[]): GroupProjectScope {
  const id = memberProjectIds[0];
  if (id && memberProjectIds.every(memberProjectId => memberProjectId === id)) {
    return { level: 'project', projectId: id, reach: 'local' };
  }
  return { level: 'app', reach: 'local' };
}
