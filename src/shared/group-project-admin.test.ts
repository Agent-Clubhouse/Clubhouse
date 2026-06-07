import { describe, it, expect } from 'vitest';
import {
  getProjectAdmins,
  isProjectAdmin,
  addAdmin,
  removeAdmin,
  deniedGroupProjectTools,
} from './group-project-admin';
import {
  GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES,
  GROUP_PROJECT_CORE_TOOL_SUFFIXES,
} from './group-project-permissions';

describe('group-project admin helpers', () => {
  it('getProjectAdmins reads the admins array defensively', () => {
    expect(getProjectAdmins(undefined)).toEqual([]);
    expect(getProjectAdmins({})).toEqual([]);
    expect(getProjectAdmins({ admins: 'nope' })).toEqual([]);
    expect(getProjectAdmins({ admins: ['a', 1, 'b'] })).toEqual(['a', 'b']);
  });

  it('isProjectAdmin checks membership', () => {
    expect(isProjectAdmin({ admins: ['a'] }, 'a')).toBe(true);
    expect(isProjectAdmin({ admins: ['a'] }, 'b')).toBe(false);
    expect(isProjectAdmin(undefined, 'a')).toBe(false);
  });

  it('addAdmin is idempotent; removeAdmin filters', () => {
    expect(addAdmin({ admins: ['a'] }, 'b')).toEqual(['a', 'b']);
    expect(addAdmin({ admins: ['a'] }, 'a')).toEqual(['a']);
    expect(removeAdmin({ admins: ['a', 'b'] }, 'a')).toEqual(['b']);
    expect(removeAdmin(undefined, 'a')).toEqual([]);
  });
});

describe('deniedGroupProjectTools (role-based gating)', () => {
  const adminMeta = { admins: ['lead'] };

  it('denies all privileged tools to a non-admin', () => {
    const denied = deniedGroupProjectTools(adminMeta, 'member');
    for (const t of GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES) expect(denied.has(t)).toBe(true);
    for (const t of GROUP_PROJECT_CORE_TOOL_SUFFIXES) expect(denied.has(t)).toBe(false);
  });

  it('grants all privileged tools to an admin', () => {
    const denied = deniedGroupProjectTools(adminMeta, 'lead');
    for (const t of GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES) expect(denied.has(t)).toBe(false);
  });

  it('per-wire disabledTools restrict an admin further', () => {
    const denied = deniedGroupProjectTools(adminMeta, 'lead', ['broadcast', 'post_bulletin']);
    expect(denied.has('broadcast')).toBe(true);   // privileged removed by the wire
    expect(denied.has('post_bulletin')).toBe(true); // core removed by the wire
    expect(denied.has('wake_agent')).toBe(false);   // still granted
  });

  it('a non-admin with no metadata is denied privileged but keeps core', () => {
    const denied = deniedGroupProjectTools(undefined, 'member');
    expect(denied.has('wake_agent')).toBe(true);
    expect(denied.has('list_members')).toBe(false);
  });
});
