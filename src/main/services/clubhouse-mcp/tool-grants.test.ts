import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../plugin-manifest-registry', () => ({
  getManifest: vi.fn(() => ({ permissions: ['mcp.tools'] })),
}));

import { GRANT_ACTIONS } from '../../../shared/agent-grants';
import { listToolGrants, _resetForTesting } from './tool-registry';
import { mcpAdapter } from './mcp-adapter';
import { registerClubhouseMcpTools } from './tools/register-all';
import { registerPluginTools, _resetForTesting as resetPluginTools } from './plugin-tool-registry';
import { describeToolGrant, isToolGrantPassThrough, toolGrantDeclarations, TOOL_GRANT_TARGETS } from './tool-grants';

/** Registers every tool the way the app does at startup (mcp-binding-handlers). */
function registerAll() {
  _resetForTesting();
  mcpAdapter._resetForTesting();
  registerClubhouseMcpTools();
  return listToolGrants();
}

describe('tool grant declarations (#2967)', () => {
  beforeEach(() => {
    _resetForTesting();
    resetPluginTools();
  });

  it('every tool the app registers declares its grant', () => {
    const tools = registerAll();
    expect(tools.length).toBeGreaterThan(60);
    const missing = tools.filter((t) => t.grant === undefined).map((t) => `${t.kind}:${t.name}`);
    expect(missing).toEqual([]);
  });

  it('every declaration names known actions and a known target', () => {
    for (const tool of registerAll()) {
      if (isToolGrantPassThrough(tool.grant)) continue;
      const declarations = toolGrantDeclarations(tool.grant);
      expect(declarations.length, `${tool.kind}:${tool.name}`).toBeGreaterThan(0);
      for (const d of declarations) {
        expect(d.actions.length, `${tool.kind}:${tool.name}`).toBeGreaterThan(0);
        for (const action of d.actions) expect(GRANT_ACTIONS, `${tool.kind}:${tool.name}`).toContain(action);
        expect(TOOL_GRANT_TARGETS, `${tool.kind}:${tool.name}`).toContain(d.target);
        // A wire's target exists only for a template tool, and a template tool's target is its wire's.
        if (d.target === 'bound' || d.target === 'group_members') expect(tool.kind, tool.name).not.toBe('global');
      }
    }
  });

  it('only call_wire_tool passes through to the tool it calls', () => {
    const passThrough = registerAll().filter((t) => isToolGrantPassThrough(t.grant)).map((t) => `${t.name}: ${t.grant}`);
    expect(passThrough).toEqual(['call_wire_tool: called_tool']);
  });

  it('plugin tools are marked as plugin tools, with no action', () => {
    registerPluginTools('acme', [{ name: 'lookup', description: 'Look up', inputSchema: {} }]);
    expect(listToolGrants()).toEqual([{ kind: 'plugin', name: 'lookup', grant: 'plugin' }]);
  });

  it('no tool finishes a pairing: none pairs, takes a code or confirms a certificate (#3068)', () => {
    const names = registerAll().map((t) => t.name);
    expect(names.filter((n) => /pair|pin|certificate|confirm_device|join/i.test(n))).toEqual([]);
  });

  it('the whole map: every tool and its declaration', () => {
    const table = registerAll().map((t) => `${t.kind === 'global' ? '' : `${t.kind} `}${t.name}: ${describeToolGrant(t.grant)}`);
    expect(table.join('\n')).toMatchInlineSnapshot(`
      "agent preview_provider: agent.configure on bound
      agent change_provider: agent.configure on bound
      agent send_message: agent.message on bound
      agent get_status: agent.read on bound
      agent read_output: agent.read on bound
      agent check_connectivity: agent.read on bound
      agent send_file: agent.message on bound
      agent clear_agent: agent.reset on bound
      agent compact_agent: agent.reset on bound
      agent wake_agent: agent.wake on bound; agent.message on bound if message
      agent sleep_agent: agent.sleep on bound
      browser navigate: browser.act on bound
      browser screenshot: browser.read on bound
      browser get_console: browser.read on bound
      browser click: browser.act on bound
      browser type: browser.act on bound
      browser evaluate: browser.act on bound
      browser get_page_content: browser.read on bound
      browser get_accessibility_tree: browser.read on bound
      group-project list_members: group_project.read on bound
      group-project post_bulletin: group_project.post on bound
      group-project read_bulletin: group_project.read on bound
      group-project read_topic: group_project.read on bound
      group-project get_project_info: group_project.read on bound
      group-project shoulder_tap: agent.message on group_members
      group-project broadcast: agent.message on group_members
      group-project wake_agent: agent.wake on group_members; agent.message on group_members if message
      group-project sleep_agent: agent.sleep on group_members
      group-project toggle_polling: group_project.admin on bound
      group-project query_polling: group_project.read on bound
      group-project nudge_polling: group_project.admin on bound
      group-project read_message: group_project.read on bound
      group-project clear_topic: group_project.admin on bound
      group-project clear_agent: agent.reset on group_members
      group-project compact_agent: agent.reset on group_members
      group-project delete_messages: group_project.admin on bound
      group-project set_project_info: group_project.admin on bound
      call_wire_tool: (called_tool)
      notify_user: user.notify on app
      hand_off: agent.dispose on my_helpers
      dispose_helper: agent.dispose on my_helpers
      start_helper: agent.create on project_arg; agent.grant on project_arg if template or addParts or removeParts or access
      list_helpers: agent.read on my_helpers
      sleep_helper: agent.sleep on my_helpers
      wake_helper: agent.wake on my_helpers; agent.message on my_helpers if message
      list_projects: project.read on all_projects
      message_parent: agent.message on parent
      list_models: models.read on app
      list_agents: agent.read on connected
      inspect_helper: agent.read on agent_arg
      start_work: agent.message on self
      read_memory: agent.read on self
      tell_user: user.notify on app
      search_memory: agent.read on self
      update_project: project.display on project_arg
      update_agent: agent.display on agent_arg
      list_settings: settings.app.read on app
      read_settings: agent.read on agent_arg; project.read on project_arg; settings.app.read on app
      set_orchestrator_helpers: agent.configure on agent_arg
      connect_orchestrators: connection.manage on agent_arg
      disconnect_orchestrators: connection.manage on agent_arg
      list_orchestrator_controls: agent.read on connected
      list_agent_parts: library.read on library
      get_agent_part: library.read on library
      create_agent_part: library.write on library
      update_agent_part: library.write on library
      fork_agent_part: library.write on library; agent.grant on agent_arg if agent
      delete_agent_part: library.write on library
      get_agent_setup: agent.read on agent_arg
      set_agent_setup: agent.grant on agent_arg
      preview_agent_setup: agent.read on agent_arg
      list_agent_templates: library.read on library
      save_agent_template: template.write on library
      push_agent_template: template.write on library; template.push on agent_arg if agents
      delete_agent_template: template.write on library
      create_managed_agent: agent.create on project_arg; agent.grant on project_arg if settings or templateId
      restart_agent: agent.restart on agent_arg
      answer_helper_question: agent.message on my_helpers
      create_group_project: connection.manage on agent_arg
      add_to_group_project: connection.manage on agent_arg
      remove_from_group_project: connection.manage on agent_arg
      connect_agents: connection.manage on agent_arg
      disconnect_agents: connection.manage on agent_arg
      create_action: action.write on app
      list_actions: action.read on app
      update_action: action.write on action_arg
      delete_action: action.write on action_arg
      run_action: action.run on action_arg
      action_history: action.read on app
      subscribe: action.write on app
      read_helper_presets: settings.app.read on app
      set_helper_presets: settings.app.write on app
      request_grant: grant.request on self
      update_my_card: agent.display on self
      list_devices: device.read on app
      rename_device: device.manage on app
      reconnect_device: device.manage on app
      remove_device: device.manage on app
      start_adding_device: device.manage on app"
    `);
  });
});
