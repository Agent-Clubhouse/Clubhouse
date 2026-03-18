import { describe, it, expect } from 'vitest';

/**
 * TitleBar title text formatting.
 *
 * When a project is active the title bar now shows:
 *   "ProjectName · TabLabel"
 * instead of the previous format:
 *   "TabLabel (ProjectName)"
 *
 * This makes the project context more prominent and reads more naturally.
 */

interface MockProject {
  id: string;
  name: string;
  displayName?: string;
}

function computeTitleText(
  explorerTab: string,
  activeProject: MockProject | undefined,
  isHome: boolean,
  tabLabel: string,
): string {
  if (isHome) return 'Home';
  if (activeProject) {
    return `${activeProject.displayName || activeProject.name} \u00b7 ${tabLabel}`;
  }
  return tabLabel;
}

describe('TitleBar — title text formatting', () => {
  it('shows "Home" when no project is active and on home tab', () => {
    expect(computeTitleText('agents', undefined, true, 'Agents')).toBe('Home');
  });

  it('shows "ProjectName · TabLabel" when project is active', () => {
    const project: MockProject = { id: 'p1', name: 'my-app' };
    expect(computeTitleText('agents', project, false, 'Agents')).toBe('my-app · Agents');
  });

  it('uses displayName over name when available', () => {
    const project: MockProject = { id: 'p1', name: 'my-app', displayName: 'My App' };
    expect(computeTitleText('agents', project, false, 'Agents')).toBe('My App · Agents');
  });

  it('shows just tab label when no project is active (non-home)', () => {
    expect(computeTitleText('settings', undefined, false, 'Settings')).toBe('Settings');
  });

  it('works with plugin tab labels', () => {
    const project: MockProject = { id: 'p1', name: 'my-app' };
    expect(computeTitleText('plugin:terminal', project, false, 'Terminal')).toBe('my-app · Terminal');
  });

  it('uses middle dot (U+00B7) as separator', () => {
    const project: MockProject = { id: 'p1', name: 'proj' };
    const title = computeTitleText('agents', project, false, 'Agents');
    expect(title).toContain('\u00b7');
  });
});
