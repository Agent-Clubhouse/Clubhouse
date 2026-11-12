import { describe, expect, it } from 'vitest';
import { inferLegacyGroupProjectScope, resolveGroupProjectScope } from './group-project-scope';

const registered = new Set(['p-one', 'p-two']);

describe('group project scope resolution', () => {
  it('defaults project entry points to the current registered project and local reach', () => {
    expect(resolveGroupProjectScope({ projectId: 'p-one' }, registered)).toEqual({
      level: 'project', projectId: 'p-one', reach: 'local',
    });
  });

  it('defaults app entry points to app scope and local reach', () => {
    expect(resolveGroupProjectScope(undefined, registered)).toEqual({ level: 'app', reach: 'local' });
    expect(resolveGroupProjectScope({}, registered)).toEqual({ level: 'app', reach: 'local' });
  });

  it('lets explicit app scope override a valid default project context', () => {
    expect(resolveGroupProjectScope({
      projectId: 'p-one', scope: { level: 'app', reach: 'local' },
    }, registered)).toEqual({ level: 'app', reach: 'local' });
  });

  it('accepts explicit project scope without a default or with the same project id', () => {
    const scope = { level: 'project', projectId: 'p-two', reach: 'local' };
    expect(resolveGroupProjectScope({ scope }, registered)).toEqual(scope);
    expect(resolveGroupProjectScope({ scope, projectId: 'p-two' }, registered)).toEqual(scope);
  });

  it.each([
    null,
    [],
    { projectId: '' },
    { projectId: 'unknown' },
    { projectId: 'unknown', scope: { level: 'app', reach: 'local' } },
    { scope: null },
    { scope: {} },
    { scope: { level: 'workspace', reach: 'local' } },
    { scope: { level: 'app', reach: 'remote' } },
    { scope: { level: 'app', reach: 'local', projectId: 'p-one' } },
    { scope: { level: 'project', reach: 'local' } },
    { scope: { level: 'project', reach: 'local', projectId: 'unknown' } },
    { projectId: 'p-one', scope: { level: 'project', reach: 'local', projectId: 'p-two' } },
  ])('refuses invalid or contradictory creation options: %j', (options) => {
    expect(() => resolveGroupProjectScope(options, registered)).toThrow(expect.objectContaining({ code: 'invalid_scope' }));
  });

  it.each([
    { level: 'app', reach: 'network' },
    { level: 'project', projectId: 'p-one', reach: 'network' },
  ])('refuses network scope rather than pretending it is local: %j', (scope) => {
    expect(() => resolveGroupProjectScope({ scope }, registered)).toThrow(expect.objectContaining({
      code: 'network_unavailable', message: expect.stringContaining('authoritative Annex host path'),
    }));
  });
});

describe('legacy group project scope inference', () => {
  it('uses project/local only when every known member belongs to the same project', () => {
    expect(inferLegacyGroupProjectScope(['p-one', 'p-one'])).toEqual({
      level: 'project', projectId: 'p-one', reach: 'local',
    });
  });

  it.each([
    { members: [] },
    { members: ['p-one', 'p-two'] },
    { members: ['p-one', undefined] },
    { members: [null, 'p-one'] },
    { members: ['', ''] },
  ])('uses app/local for mixed, unknown, or absent membership: $members', ({ members }) => {
    expect(inferLegacyGroupProjectScope(members)).toEqual({ level: 'app', reach: 'local' });
  });
});
