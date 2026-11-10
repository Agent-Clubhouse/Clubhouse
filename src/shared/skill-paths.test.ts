import { describe, expect, it } from 'vitest';
import { planSkillImport, skillPathError } from './skill-paths';

describe('planSkillImport (#3247)', () => {
  it('keeps a supporting folder\'s name and names no skill', () => {
    expect(planSkillImport(['assets/note.md', 'assets/deep/more.md'])).toEqual({ paths: ['assets/note.md', 'assets/deep/more.md'], skillName: null });
  });

  it('strips only the outer folder of a whole skill and names the skill after it', () => {
    expect(planSkillImport(['sample-skill/SKILL.md', 'sample-skill/assets/note.md'])).toEqual({ paths: ['SKILL.md', 'assets/note.md'], skillName: 'sample-skill' });
  });

  it('treats each folder in a mixed drop by what it holds', () => {
    expect(planSkillImport(['sample-skill/SKILL.md', 'sample-skill/run.sh', 'assets/note.md', 'loose.md']))
      .toEqual({ paths: ['SKILL.md', 'run.sh', 'assets/note.md', 'loose.md'], skillName: 'sample-skill' });
  });

  it('a SKILL.md deeper down doesn\'t make a skill folder, and loose files stay as they are', () => {
    expect(planSkillImport(['refs/inner/SKILL.md', 'SKILL.md'])).toEqual({ paths: ['refs/inner/SKILL.md', 'SKILL.md'], skillName: null });
  });

  it('names no skill when two skill folders come in together', () => {
    expect(planSkillImport(['a/SKILL.md', 'b/SKILL.md']).skillName).toBeNull();
  });

  it('reads either separator', () => {
    expect(planSkillImport(['assets\\note.md']).paths).toEqual(['assets/note.md']);
  });
});

describe('skillPathError (#3247)', () => {
  const existing = ['SKILL.md', 'assets/note.md', 'run.sh'];

  it('accepts a new nested path', () => {
    expect(skillPathError('scripts/run.sh', existing)).toBeNull();
    expect(skillPathError('assets/other.md', existing)).toBeNull();
  });

  it.each(['', '../outside.md', 'assets/../x.md', '/absolute.md', 'C:/x.md', 'a\\b.md', 'a//b.md', './x.md', 'NUL.txt', 'trailing.'])('refuses %j', (path) => {
    expect(skillPathError(path, existing)).toMatch(/portable path/);
  });

  it('refuses a clash with a file or folder, in any case', () => {
    expect(skillPathError('assets/note.md', existing)).toMatch(/conflicts with assets\/note\.md/);
    expect(skillPathError('ASSETS/NOTE.md', existing)).toMatch(/conflicts/);
    expect(skillPathError('assets', existing)).toMatch(/conflicts/);
    expect(skillPathError('run.sh/inner.md', existing)).toMatch(/conflicts/);
    expect(skillPathError('skill.md', existing)).toMatch(/conflicts/);
  });

  it('a renamed file doesn\'t clash with its own old path', () => {
    expect(skillPathError('Run.sh', existing, 'run.sh')).toBeNull();
    expect(skillPathError('assets/run.sh', existing, 'run.sh')).toBeNull();
  });
});
