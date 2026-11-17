import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_TEXT } from './builtin-text/index';

const text = BUILTIN_TEXT['group-projects.md'];
const help = readFileSync(join(__dirname, '../../../renderer/features/help/content/group-projects.md'), 'utf8');

describe('group projects built-in text (#3618)', () => {
  it('distinguishes app-wide and project-scoped initial membership', () => {
    expect(text).toContain('A new app-wide group project starts with no members.');
    expect(text).toContain('A new group project for one project starts with the top-level durable agents in that project');
    expect(text).toContain('unless the person turned that off');
    expect(text).toContain('Agents on linked computers are a separate choice.');
    expect(text).not.toContain('New group projects include top-level durable agents in scope automatically');
  });

  it('tells agents to check the roster instead of assuming members', () => {
    expect(text).toContain('`list_members`');
  });

  it('keeps notices first and lead and admin separate', () => {
    expect(text).toContain('Do not poll the board in a loop.');
    expect(text).toContain('Lead and admin are separate grants');
  });

  it('agrees with the help page on initial membership', () => {
    expect(help).toContain('An app-wide group starts with no members.');
    expect(help).toContain('A group for one project starts with every durable agent in that project');
  });
});
