import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GROUP_WORKSPACE_SECTION, GROUP_WORKSPACE_SECTIONS, isGroupWorkspaceSection, resolveGroupWorkspaceRoute,
} from './groupProjectRoute';

describe('group workspace route', () => {
  it('lands on the Board when no section is named', () => {
    expect(DEFAULT_GROUP_WORKSPACE_SECTION).toBe('board');
    expect(resolveGroupWorkspaceRoute({ groupId: 'gp_1' })).toEqual({ groupId: 'gp_1', section: 'board' });
  });

  it('keeps a section that is named', () => {
    expect(resolveGroupWorkspaceRoute({ groupId: 'gp_1', section: 'members' })).toEqual({ groupId: 'gp_1', section: 'members' });
  });

  it('falls back to the Board for a section it does not know, and keeps the id', () => {
    expect(resolveGroupWorkspaceRoute({ groupId: 'gp_1', section: 'nope' as never })).toEqual({ groupId: 'gp_1', section: 'board' });
  });

  it('names the sections the workspace lists, Board first', () => {
    expect(GROUP_WORKSPACE_SECTIONS[0]).toBe('board');
    expect(GROUP_WORKSPACE_SECTIONS.every(isGroupWorkspaceSection)).toBe(true);
    expect(isGroupWorkspaceSection('settings')).toBe(false);
  });
});
