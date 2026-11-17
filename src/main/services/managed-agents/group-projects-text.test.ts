import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_MANIFEST, BUILTIN_BLOCK_IDS } from './builtins';
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

const source = (relative: string) => readFileSync(join(__dirname, relative), 'utf8');
const basics = BUILTIN_TEXT['clubhouse-basics.md'];
const lead = BUILTIN_TEXT['group-project-lead.md'];
const admin = BUILTIN_TEXT['group-project-admin.md'];
const boardSkill = source('builtin-text/skills/post-result-board/SKILL.md');
const controller = source('../dispatcher/dispatcher-instructions.md');
const chat = source('../dispatcher/dispatcher-chat-instructions.md');
const toolSource = source('../clubhouse-mcp/tools/group-project-tools.ts');
const connectionSource = source('../clubhouse-mcp/tools/connection-tools.ts');

describe('Group Project guidance parity across delivered surfaces (#3618)', () => {
  it.each([
    ['overview', basics], ['member', text], ['lead', lead], ['admin', admin],
    ['board result skill', boardSkill], ['controller', controller],
  ])('%s verifies membership and avoids blanket polling', (_name, guidance) => {
    expect(guidance).toContain('`list_members`');
    expect(guidance).toMatch(/(not assume|never assume|does not establish|do not assume|do not prove)/i);
    expect(guidance).toMatch(/not poll|rather than polling/i);
  });

  it.each([
    ['member', text], ['lead', lead], ['admin', admin],
    ['board result skill', boardSkill], ['controller', controller], ['chat', chat],
  ])('%s distinguishes pending offline changes from delivery and completion', (_name, guidance) => {
    expect(guidance).toMatch(/host.*offline|offline.*(host|copies)/i);
    expect(guidance).toMatch(/pending/i);
    expect(guidance).toMatch(/accept/i);
    expect(guidance).toMatch(/not.*(acknowledgment|completion|prove)/i);
  });

  it.each([['member', text], ['admin', admin], ['controller', controller], ['chat', chat]])(
    '%s teaches notices and legacy polling as distinct modes', (_name, guidance) => {
      expect(guidance).toMatch(/(legacy polling|polling groups|polling sends).*no notices/i);
      expect(guidance).toMatch(/sleeping.*(not|without)|not.*wake.*sleeping/i);
    },
  );

  it('teaches board versus one-off messages in discovery and result workflows', () => {
    for (const guidance of [basics, text, admin, boardSkill, controller, chat]) {
      expect(guidance).toContain('one-off message');
      expect(guidance).toMatch(/shared|durable|persistent/);
    }
    expect(chat).toContain('through `start_work`');
    expect(controller).toContain('neither grant implies the other');
    expect(admin).toContain('`set_project_info` requires admin');
    expect(lead).toContain('Admin is a separate grant');
  });

  it('ships an optional admin part without changing existing template setups', () => {
    expect(BUILTIN_MANIFEST.blocks.find(b => b.id === BUILTIN_BLOCK_IDS.groupAdmin)).toMatchObject({
      name: 'Group project admin', file: 'group-project-admin.md',
    });
    expect(BUILTIN_MANIFEST.templates.every(t => !t.blocks.includes(BUILTIN_BLOCK_IDS.groupAdmin))).toBe(true);
    expect(admin).toContain('adding it does not grant permissions or make you a member');
  });

  it('keeps referenced board and connection tool names registered', () => {
    // Assert against the actual registration metadata: a rename must update guidance too.
    const boardNames = new Set([...toolSource.matchAll(/nameSuffix: '([^']+)'/g)].map(m => m[1]));
    const connectionNames = new Set([...connectionSource.matchAll(/registerGlobalTool\('([^']+)'/g)].map(m => m[1]));
    for (const guidance of [basics, text, lead, admin, boardSkill, controller]) {
      for (const name of ['get_project_info', 'list_members', 'read_bulletin', 'read_topic', 'read_message',
        'post_bulletin', 'subscribe_topic', 'set_project_info', 'toggle_polling', 'nudge_polling',
        'shoulder_tap', 'broadcast', 'clear_topic', 'delete_messages', 'wake_agent', 'sleep_agent',
        'compact_agent', 'clear_agent']) {
        if (guidance.includes('`' + name + '`')) expect(boardNames.has(name), name).toBe(true);
      }
    }
    for (const name of ['join_group_project', 'leave_group_project']) {
      expect(controller).toContain('`' + name + '`');
      expect(connectionNames.has(name), name).toBe(true);
    }
  });
});
