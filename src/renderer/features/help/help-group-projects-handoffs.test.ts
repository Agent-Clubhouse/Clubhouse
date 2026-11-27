import { describe, it, expect } from 'vitest';
import { HELP_SECTIONS, CHROME_HELP_SECTIONS, GROUP_PROJECT_TOPICS } from './help-content';

describe('Group projects and Handoffs refresh (#3552, #3898)', () => {
  const find = (id: string) => [...HELP_SECTIONS, ...CHROME_HELP_SECTIONS].flatMap((s) => s.topics).concat(GROUP_PROJECT_TOPICS).find((t) => t.id === id)!.content;

  it('says what lead and admin can do, and names the group switches and Post notifications', () => {
    const content = find('group-projects');
    for (const part of [
      'A lead can wake and put members to sleep', 'An admin can change the group project itself', '**Tell members about new posts**',
      '**Wake sleeping members**', '**Run group project Actions**', '**Post notifications**',
    ]) expect(content, part).toContain(part);
    expect(content).not.toContain('A lead can coordinate members');
    expect(find('group-project-glossary')).not.toContain('coordinate members');
  });

  it('says how a handoff starts, what happens after, and the defaults and limits', () => {
    const content = find('agents-handoffs');
    for (const part of [
      "There's no handoff button", '## After it\'s accepted', '`.clubhouse/handoffs/<id>`', 'Nothing changes for the agent that sent the work',
      "It's on by default", '**Handoff transfer limits**', '10,000 files',
    ]) expect(content, part).toContain(part);
    expect(content).not.toContain('—');
  });
});

describe('Group project words after #3946', () => {
  it('says the computer that holds a group project, not host, outside the Host field label', () => {
    for (const id of ['group-projects', 'group-project-glossary']) {
      const content = GROUP_PROJECT_TOPICS.find((t) => t.id === id)!.content.replace(/\*\*Host\*\*/g, '');
      expect(content, id).not.toMatch(/\bhost\b|\bwires?\b/i);
    }
    const actions = HELP_SECTIONS.flatMap((s) => s.topics).find((t) => t.id === 'agents-actions')!.content;
    expect(actions).not.toMatch(/\bhosts? the group\b/);
    expect(actions).toContain('the computer that holds the group');
  });
});
