import { describe, expect, it } from 'vitest';
import {
  inferLegacyGroupProjectScope, memberInScope, membersLeavingScope, resolveGroupProjectScope,
} from './group-project-scope';

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

describe('group project scope membership (#3355)', () => {
  const FP = Array.from({ length: 32 }, () => 'cd').join(':');
  const here = { address: 'agent-1', projectId: 'p-one' };
  const elsewhere = { address: `agent-2@${FP}`, projectId: 'p-one' };

  it('follows the scope table: project or app, this computer or network', () => {
    expect(memberInScope({ level: 'project', projectId: 'p-one', reach: 'local' }, here)).toBe(true);
    expect(memberInScope({ level: 'project', projectId: 'p-two', reach: 'local' }, here)).toBe(false);
    expect(memberInScope({ level: 'app', reach: 'local' }, here)).toBe(true);
    expect(memberInScope({ level: 'app', reach: 'local' }, elsewhere)).toBe(false);
    expect(memberInScope({ level: 'app', reach: 'network' }, elsewhere)).toBe(true);
    expect(memberInScope({ level: 'project', projectId: 'p-one', reach: 'network' }, elsewhere)).toBe(true);
  });

  it('never counts a member whose project is unknown as leaving', () => {
    const unknown = { address: 'agent-3' };
    expect(memberInScope({ level: 'project', projectId: 'p-one', reach: 'local' }, unknown)).toBeUndefined();
    expect(membersLeavingScope({ level: 'project', projectId: 'p-one', reach: 'local' }, [here, unknown, { address: 'x', projectId: 'p-two' }]))
      .toEqual([{ address: 'x', projectId: 'p-two' }]);
  });

  it('allows network reach only when it is available, with its reason otherwise', () => {
    const network = { scope: { level: 'app', reach: 'network' } };
    expect(() => resolveGroupProjectScope(network, registered, { available: false, reason: 'Turn on Annex Network.' })).toThrow('Turn on Annex Network.');
    expect(resolveGroupProjectScope(network, registered, { available: true })).toEqual({ level: 'app', reach: 'network' });
  });
});
