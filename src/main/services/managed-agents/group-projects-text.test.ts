import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_MANIFEST, BUILTIN_BLOCK_IDS } from './builtins';
import { BUILTIN_TEXT } from './builtin-text/index';
import { dispatcherSkills } from '../dispatcher/dispatcher-skills';

const text = BUILTIN_TEXT['group-projects.md'];
const help = readFileSync(join(__dirname, '../../../renderer/features/help/content/group-projects.md'), 'utf8');
const glossary = readFileSync(join(__dirname, '../../../renderer/features/help/content/group-project-glossary.md'), 'utf8');

describe('group project member guidance (#3698)', () => {
  it('keeps the member block identity stable while renaming its display name', () => {
    expect(BUILTIN_MANIFEST.blocks.find(b => b.id === 'builtin-block-group-projects')).toMatchObject({
      name: 'Group project member', file: 'group-projects.md',
    });
    expect(text).toContain('# Group project member');
  });

  it('teaches notices, direct messages, urgency and honest delivery outcomes concisely', () => {
    for (const phrase of ['`list_members`', '`read_topic`', '`since`', 'Never poll',
      '`@name@computer`', '`urgent: true`', 'wakes a sleeping member', 'pending until accepted',
      'Delivered does not mean read or done', 'Use `general` only for team-wide announcements',
      '`control` for how the team works; agree in `control` before opening a channel']) expect(text).toContain(phrase);
    expect(text.trim().split(/\s+/).length).toBeLessThanOrEqual(150);
  });

  it('distinguishes local wake permission from the additional remote lead-Allow gate', () => {
    const directWake = glossary.split('\n').find(line => line.startsWith('- **Direct wake:**'))!;
    expect(directWake).toContain("Local members wake each other under the group's wake permission (on by default) and per-member wake limits.");
    expect(directWake).toContain("Remote-origin wakes also require the receiving computer's Allow for the sender's lead grant.");
    expect(directWake).toContain('when one is resumable');
  });

  it('keeps membership details in help and documents the new roster and wake rules', () => {
    expect(help).toContain('An app-wide group starts with no members.');
    expect(help).toContain('A group for one project starts with every durable agent in that project');
    for (const phrase of ['`address`', '`inbox`', '`lastSeen`', '`roles`', '`unknown`',
      '`@name@computer`', 'resuming its last session', 'A person can turn waking off']) expect(help).toContain(phrase);
  });
});

const source = (relative: string) => readFileSync(join(__dirname, relative), 'utf8');
const basics = BUILTIN_TEXT['clubhouse-basics.md'];
const lead = BUILTIN_TEXT['group-project-lead.md'];
const admin = BUILTIN_TEXT['group-project-admin.md'];
const boardSkill = source('builtin-text/skills/post-result-board/SKILL.md');
const controller = source('../dispatcher/dispatcher-instructions.md');
const procedures = dispatcherSkills('work').find((s) => s.name === 'tool-procedures')!.text;
const chat = source('../dispatcher/dispatcher-chat-instructions.md');
const toolSource = source('../clubhouse-mcp/tools/group-project-tools.ts');
const connectionSource = source('../clubhouse-mcp/tools/connection-tools.ts');

describe('Group Project guidance parity across delivered surfaces (#3618)', () => {
  it('puts shared member guidance in the member block rather than repeating it', () => {
    expect(basics).not.toContain('Use a group project board');
    expect(text).toContain('shared assignments');
    expect(lead).toContain('Lead and admin are separate grants');
    expect(admin).toContain('Lead and admin are separate grants');
    for (const gate of ['The host controls scope.', "Remote writes require the host's Allow.",
      "Permanent group project deletion requires a person's impact review and confirmation."]) {
      expect(text).toContain(gate);
      expect(lead).not.toContain(gate);
      expect(admin).not.toContain(gate);
    }
    for (const guidance of [lead, admin]) {
      expect(guidance.trim().split(/\s+/).length).toBeLessThanOrEqual(230);
    }
  });

  it.each([
    ['board result skill', boardSkill], ['controller', procedures], ['chat', chat],
  ])('%s distinguishes pending offline changes and direct wakes from completion', (_name, guidance) => {
    expect(guidance).toMatch(/host.*offline|offline.*(host|copies)/i);
    expect(guidance).toMatch(/pending/i);
    expect(guidance).toMatch(/accept/i);
    expect(guidance).toMatch(/not.*(acknowledgment|completion|prove)/i);
    expect(guidance).toContain('@mention');
    expect(guidance).not.toMatch(/Legacy polling|not wake sleeping members/i);
  });

  it('removes retired tools from every delivered group instruction', () => {
    for (const guidance of [text, lead, admin, basics, boardSkill, controller, procedures, chat]) {
      expect(guidance).not.toMatch(/shoulder_tap|broadcast|query_polling|toggle_polling|nudge_polling/);
    }
  });

  it('teaches Dispatcher membership checks through its offered management tools', () => {
    expect(controller).toContain('Read the `tool-procedures` skill before acting');
    expect(controller).toContain('within verified membership and grants');
    expect(controller).toContain('do not invent tools or assume a connection establishes board membership');
    expect(procedures).toContain('`get_group_project_management`');
    expect(procedures).toContain('do not assume they are in your catalog');
    for (const name of ['list_members', 'get_project_info', 'read_topic', 'read_bulletin', 'read_message']) {
      for (const guidance of [controller, procedures]) expect(guidance).not.toContain('`' + name + '`');
    }
  });

  it('ships an optional admin part without changing existing template setups', () => {
    expect(BUILTIN_MANIFEST.blocks.find(b => b.id === BUILTIN_BLOCK_IDS.groupAdmin)).toMatchObject({
      name: 'Group project admin', file: 'group-project-admin.md',
    });
    expect(BUILTIN_MANIFEST.templates.every(t => !t.blocks.includes(BUILTIN_BLOCK_IDS.groupAdmin))).toBe(true);
    expect(admin).toContain('Adding this block does not grant permissions or make you a member');
  });

  it('keeps referenced board and connection tool names registered', () => {
    // Assert against the actual registration metadata: a rename must update guidance too.
    const boardNames = new Set([...toolSource.matchAll(/nameSuffix: '([^']+)'/g)].map(m => m[1]));
    const connectionNames = new Set([...connectionSource.matchAll(/registerGlobalTool\('([^']+)'/g)].map(m => m[1]));
    for (const guidance of [basics, text, lead, admin, boardSkill, controller, procedures]) {
      for (const name of ['get_project_info', 'list_members', 'read_bulletin', 'read_topic', 'read_message',
        'post_bulletin', 'subscribe_topic', 'set_project_info', 'clear_topic', 'delete_messages', 'wake_agent', 'sleep_agent',
        'compact_agent', 'clear_agent']) {
        if (guidance.includes('`' + name + '`')) expect(boardNames.has(name), name).toBe(true);
      }
    }
    for (const name of ['join_group_project', 'leave_group_project']) {
      expect(procedures).toContain('`' + name + '`');
      expect(connectionNames.has(name), name).toBe(true);
    }
  });
});
