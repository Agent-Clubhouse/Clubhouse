/**
 * Skills found on disk (#2929): listing and reading an agent's skills is read
 * only and bounded, and runs nothing. Real files, with a marker script that
 * would leave a file behind if anything ran it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { frontMatterNameOf, listSkills, MAX_LISTED_SKILLS, readSkillContent } from './agent-settings-service';

let root: string;
let worktree: string;
let marker: string;

function skill(folder: string, skillMd: string, base = path.join(worktree, '.claude', 'skills')): string {
  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd);
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-discovery-'));
  worktree = path.join(root, 'agent');
  marker = path.join(root, 'MARKER');
  // A skill whose script, and whose SKILL.md's inline command, would each leave the marker if run.
  const dir = skill('runner', [
    '---',
    'name: runner-skill',
    'description: Runs a script.',
    '---',
    '',
    `Context: !\`touch ${JSON.stringify(marker)}\``,
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  const script = path.join(dir, 'scripts', 'run.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  fs.chmodSync(script, 0o755);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('skills found on disk (#2929)', () => {
  it('lists and reads a skill with a script without running anything', async () => {
    const listed = await listSkills(worktree);
    expect(listed).toEqual([{ name: 'runner', path: path.join(worktree, '.claude', 'skills', 'runner'), hasReadme: false, skillName: 'runner-skill' }]);
    expect(await readSkillContent(worktree, 'runner')).toContain('name: runner-skill');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('says which folders Clubhouse delivered, from its manifest only', async () => {
    skill('build', '---\nname: build\n---\nBuild it.\n');
    skill('mine', 'No front matter.\n');
    fs.writeFileSync(path.join(worktree, '.claude', 'skills', '.clubhouse-managed-skills.json'), JSON.stringify({ skills: ['build', 'gone'] }));
    const byName = Object.fromEntries((await listSkills(worktree)).map((s) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual(['build', 'mine', 'runner']);
    expect(byName.build).toMatchObject({ managed: true, skillName: 'build' });
    expect(byName.mine.managed).toBeUndefined();
    expect(byName.mine.skillName).toBeUndefined();
    expect(byName.runner.managed).toBeUndefined();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('reads the folder of the provider it is given, and no other', async () => {
    skill('codex-only', '---\nname: codex-only\n---\n', path.join(worktree, '.agents', 'skills'));
    const codex = { configDir: '.codex', skillsDir: 'skills', skillsRoot: '.agents/skills', localInstructionsFile: 'AGENTS.md', legacyInstructionsFile: 'AGENTS.md', mcpConfigFile: '.codex/config.toml', localSettingsFile: 'config.toml' };
    expect((await listSkills(worktree, codex)).map((s) => s.name)).toEqual(['codex-only']);
    expect((await listSkills(worktree)).map((s) => s.name)).toEqual(['runner']);
  });

  it('is bounded, keeping the first folders by name', async () => {
    for (let i = 0; i < MAX_LISTED_SKILLS + 5; i++) fs.mkdirSync(path.join(worktree, '.claude', 'skills', `s${String(i).padStart(3, '0')}`));
    const listed = await listSkills(worktree);
    expect(listed.length).toBe(MAX_LISTED_SKILLS);
    expect(listed[0].name).toBe('runner');
    expect(listed[1].name).toBe('s000');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('doesn\'t follow a SKILL.md that links out of the folder', async () => {
    const outside = path.join(root, 'outside.md');
    fs.writeFileSync(outside, '---\nname: outside\n---\n');
    const dir = path.join(worktree, '.claude', 'skills', 'linked');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(dir, 'SKILL.md'));
    } catch {
      return; // No symlinks here (Windows without the privilege).
    }
    const linked = (await listSkills(worktree)).find((s) => s.name === 'linked')!;
    expect(linked.skillName).toBeUndefined();
  });

  it('reads the front matter name, quoted or bare, and nothing else', () => {
    expect(frontMatterNameOf('---\nname: build\n---\n')).toBe('build');
    expect(frontMatterNameOf('\uFEFF---\r\nname: "it\'s"\r\n---\r\n')).toBe("it's");
    expect(frontMatterNameOf("---\nname: 'quoted'\n---\n")).toBe('quoted');
    expect(frontMatterNameOf('---\nname: foo # note\n---\n')).toBe('foo');
    expect(frontMatterNameOf('---\nname:\ndescription: Runs a thing\n---\n')).toBeUndefined();
    expect(frontMatterNameOf('name: no front matter\n')).toBeUndefined();
  });
});
