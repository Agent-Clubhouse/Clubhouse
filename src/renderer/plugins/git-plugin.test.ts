import { describe, it, expect, vi } from 'vitest';

vi.mock('../features/git/GitSidebar', () => ({ GitSidebar: () => null }));
vi.mock('../features/git/GitMainView', () => ({ GitMainView: () => null }));

import { gitPlugin } from './git-plugin';

describe('git plugin', () => {
  it('has correct id and label', () => {
    expect(gitPlugin.id).toBe('git');
    expect(gitPlugin.label).toBe('Git');
  });

  it('provides SidebarPanel and MainPanel', () => {
    expect(gitPlugin.SidebarPanel).toBeDefined();
    expect(gitPlugin.MainPanel).toBeDefined();
  });

  it('is not fullWidth', () => {
    expect(gitPlugin.fullWidth).toBeFalsy();
  });
});
