import { describe, expect, it } from 'vitest';
import { claudeMcpToolPrefix, driverReports, MAX_REPORTED_TOOLS, reportedCopilotSkillNames, reportedMcpToolNames } from './provider-inventory';

describe('provider inventory (#2855)', () => {
  it('keeps only MCP tool names, and treats a missing or malformed list as unknown, not empty', () => {
    expect(reportedMcpToolNames(['Read', 'mcp__a__x', 'mcp__a__x', 'Bash'])).toEqual(['mcp__a__x']);
    expect(reportedMcpToolNames([])).toEqual([]);
    for (const bad of [undefined, 'mcp__a__x', ['mcp__a__x', 3], [''], ['a\nb'], Array(MAX_REPORTED_TOOLS + 1).fill('mcp__a__x')]) {
      expect(reportedMcpToolNames(bad)).toBeNull();
    }
  });

  it('counts only enabled Copilot skills, and nothing from a malformed list', () => {
    expect(reportedCopilotSkillNames([{ name: 'on', enabled: true, path: '/abs/SKILL.md' }, { name: 'off', enabled: false }])).toEqual(['on']);
    for (const bad of [undefined, {}, [null], [{ name: 'no-flag' }], [{ name: 3, enabled: true }]]) {
      expect(reportedCopilotSkillNames(bad)).toBeNull();
    }
  });

  it('names Claude MCP tools by the server key with unsafe characters replaced', () => {
    expect(claudeMcpToolPrefix('tickets.api v2')).toBe('mcp__tickets_api_v2__');
    expect(claudeMcpToolPrefix('my-server_1')).toBe('mcp__my-server_1__');
  });

  it('says which drivers report which kinds', () => {
    expect(driverReports('claude_agent_sdk')).toEqual({ skills: true, mcpTools: true });
    expect(driverReports('claude_stream_json')).toEqual({ skills: true, mcpTools: true });
    expect(driverReports('copilot_sdk')).toEqual({ skills: true, mcpTools: false });
    expect(driverReports('codex_app_server')).toEqual({ skills: false, mcpTools: false });
  });
});
