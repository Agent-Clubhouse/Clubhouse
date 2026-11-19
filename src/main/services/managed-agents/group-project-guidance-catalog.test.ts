import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_TEXT } from './builtin-text/index';

// Register the shipped catalog, without invoking its services or mutating app data.
interface CatalogTool {
  definition: { description: string; inputSchema: { properties: Record<string, unknown> } };
  options: { group: string; grant: { actions: string[]; target: string } };
}
const catalog = vi.hoisted(() => new Map<string, CatalogTool>());
vi.mock('../clubhouse-mcp/tool-registry', () => ({
  registerGlobalTool: (name: string, definition: CatalogTool['definition'], _handler: unknown, options: CatalogTool['options']) => {
    catalog.set(name, { definition, options });
  },
}));
vi.mock('../group-project-host', () => ({ groupProjectHost: {} }));
vi.mock('../group-project-membership', () => ({ addMember: vi.fn(), excludeMember: vi.fn() }));
vi.mock('../project-store', () => ({}));
vi.mock('../group-project-remote-create', () => ({ groupProjectRemoteCreate: {} }));
vi.mock('../clubhouse-mcp/binding-manager', () => ({ bindingManager: {} }));
vi.mock('../group-project-polling', () => ({ listPausedPolling: vi.fn() }));
vi.mock('../clubhouse-mcp/dispatcher-gate', () => ({ isTrackedDispatcher: vi.fn() }));

import { GROUP_PROJECT_MANAGEMENT_TOOLS, registerGroupProjectManagementTools } from '../clubhouse-mcp/tools/group-project-management-tools';

const read = (relative: string) => readFileSync(join(__dirname, relative), 'utf8');
const controller = read('../dispatcher/dispatcher-instructions.md');
const chat = read('../dispatcher/dispatcher-chat-instructions.md');
const delegation = read('../dispatcher/skills/work/delegating-work/SKILL.md');
const abilities = read('../dispatcher/skills/chat/what-else-can-you-do/SKILL.md');
const admin = BUILTIN_TEXT['group-project-admin.md'];
const lead = BUILTIN_TEXT['group-project-lead.md'];
const surfaces = [controller, chat, delegation, abilities, admin, lead,
  BUILTIN_TEXT['clubhouse-basics.md'], BUILTIN_TEXT['group-projects.md'],
  read('builtin-text/skills/post-result-board/SKILL.md')];

beforeEach(() => {
  catalog.clear();
  registerGroupProjectManagementTools();
});

describe('Group Project guidance against the shipped management catalog (#3618)', () => {
  it('keeps the full management reference in the Dispatcher and actual roles in the catalog', () => {
    expect([...catalog.keys()].sort()).toEqual(GROUP_PROJECT_MANAGEMENT_TOOLS.map(([name]) => name).sort());
    for (const [name, _capability, action] of GROUP_PROJECT_MANAGEMENT_TOOLS) {
      if (action === 'group_project.lead') {
        expect(controller, name).not.toContain('`' + name + '`');
      } else {
        expect(controller, name).toContain('`' + name + '`');
      }
      const tool = catalog.get(name)!;
      expect(tool.definition.description, name).toContain(`Requires ${action}`);
      expect(tool.options).toMatchObject({ group: 'groupProjects', grant: { actions: [action] } });
      expect(tool.options.grant.target, name).toBe(name === 'preview_group_project_create' || name === 'create_group_project'
        ? 'app' : 'group_project_arg');
    }
  });

  it('rejects invented or renamed management tool references in parts, instructions and skills', () => {
    const existingConnectionsAndDirectory = new Set(['list_group_projects', 'open_group_project_directory',
      'join_group_project', 'leave_group_project']);
    for (const guidance of surfaces) {
      for (const [, name] of guidance.matchAll(/`([a-z][a-z0-9_]*group_project[a-z0-9_]*)`/g)) {
        expect(catalog.has(name) || existingConnectionsAndDirectory.has(name), name).toBe(true);
      }
      expect(guidance).not.toContain('TODO #3617');
    }
  });

  it('keeps creation preview and saved custom-instruction review requirements discoverable', () => {
    const create = catalog.get('create_group_project')!.definition;
    expect(create.description).toContain('exact reviewed choices');
    expect(create.inputSchema.properties).toHaveProperty('preview_token');
    expect(create.inputSchema.properties).toHaveProperty('retry_of');
    for (const guidance of [controller]) {
      expect(guidance).toContain('preview_token');
      expect(guidance).toContain('exact reviewed choices');
      expect(guidance).toContain('explicit members afterward');
      expect(guidance).toContain('replace_across_sources');
      expect(guidance).toContain('revision');
      expect(guidance).toContain('custom instructions');
    }
    expect(admin).toContain('Preserve custom instructions');
    expect(admin).toContain('current revision');
    expect(admin).toContain('exact reviewed choices');
    expect(controller).toContain('retry_of');
    const settings = catalog.get('set_group_project_member_settings')!.definition;
    expect(settings.description).toContain('revision');
    expect(settings.inputSchema.properties).toHaveProperty('replace_across_sources');
  });

  it('warns that clearing a board includes protected topics, unlike ordinary topic curation', () => {
    expect(catalog.get('clear_group_project_board')!.definition.description).toContain('including protected topics');
    for (const guidance of [controller]) {
      expect(guidance).toContain('including protected topics');
      expect(guidance).toMatch(/explicit confirmation/);
      expect(guidance).toContain('trim count and sequence');
    }
  });

  it('keeps host-role and delivery limits in guidance and tool descriptions', () => {
    expect(catalog.get('set_group_project_role')!.definition.description).toContain('does not change the host');
    expect(catalog.get('dismiss_group_project_refusals')!.definition.description).toContain('Does not resend or cancel queued writes');
    expect(controller).toContain('Allow from the authoritative host');
    expect(BUILTIN_TEXT['group-projects.md']).toContain("Remote writes require the host's Allow.");
    for (const guidance of [controller, admin]) {
      expect(guidance).toContain('this-computer grants');
      expect(guidance).toMatch(/host.role view is read-only|read-only host.role view/);
      expect(guidance).toMatch(/member.*tool switches/);
    }
  });
});
