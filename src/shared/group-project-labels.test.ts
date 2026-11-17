import { describe, expect, it } from 'vitest';
import { groupProjectLabel } from './group-project-labels';

describe('group project display names (#3661 QA)', () => {
  it.each(['proj_x', 'my_proj_tools', 'Documentation for proj_example'])('preserves the real project name %s', (name) => {
    // Registered project names and user-provided display names are not IDs
    // merely because they contain the same prefix as an internal project ID.
    expect(groupProjectLabel(undefined, name)).toBe(name);
    expect(groupProjectLabel(name, 'repository')).toBe(name);
  });

  it('does not expose a generated internal project id when its real name is unavailable', () => {
    expect(groupProjectLabel(undefined, 'proj_1771095672646_a2myyt')).toBe('Linked project');
    expect(groupProjectLabel('proj_1771095672646_a2myyt', 'Atlas')).toBe('Atlas');
  });
});
