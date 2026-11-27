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
