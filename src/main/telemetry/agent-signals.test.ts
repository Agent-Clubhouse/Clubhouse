import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAttributeSpec } from '../../shared/telemetry/attributes';
import { ATTR } from '../../shared/telemetry/attributes';
import { recordBinaryLookup, recordHookEvent, recordMcpToolCall, recordPermission, toolBucket } from './agent-signals';
import { setRuntime } from './facade';
import type { TelemetryRuntime } from './types';

let rt: TelemetryRuntime;
beforeEach(() => {
  rt = {
    level: 'standard', flow: vi.fn(), step: vi.fn(), count: vi.fn(), event: vi.fn(), exception: vi.fn(),
    replaySpan: vi.fn(), replayTree: vi.fn(), recentExports: () => [], preview: () => [],
    forceFlush: vi.fn(async () => {}), shutdown: vi.fn(async () => {}),
  } as unknown as TelemetryRuntime;
  setRuntime(rt);
});
afterEach(() => setRuntime(null));

describe('toolBucket', () => {
  it.each([
    ['Bash', 'Bash'],
    ['apply_patch', 'apply_patch'],
    ['mcp__clubhouse__abc123__send_message', 'mcp_clubhouse'],
    ['mcp__github__create_issue', 'mcp_other'],
    ['SomePrivateTool', 'other'],
    [undefined, 'other'],
  ])('%s → %s', (name, bucket) => {
    expect(toolBucket(name)).toBe(bucket);
  });
});

describe('agent signals', () => {
  it('counts hook events, and tool calls on post_tool / tool_error only', () => {
    recordHookEvent('claude-code', 'pre_tool', 'Bash');
    recordHookEvent('claude-code', 'post_tool', 'Bash');
    recordHookEvent('codex-cli', 'tool_error', 'mcp__github__x');
    recordHookEvent('weird-cli', 'session_start', undefined);
    const calls = (rt.count as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.filter((c) => c[0] === 'clubhouse.agent.hook_events')).toHaveLength(4);
    expect(calls).toContainEqual(['clubhouse.agent.tool_calls', 1, [ATTR.orchestrator('claude-code'), ATTR.toolBucket('Bash'), ATTR.toolResult('ok')]]);
    expect(calls).toContainEqual(['clubhouse.agent.tool_calls', 1, [ATTR.orchestrator('codex-cli'), ATTR.toolBucket('mcp_other'), ATTR.toolResult('error')]]);
    expect(calls).toContainEqual(['clubhouse.agent.hook_events', 1, [ATTR.orchestrator('other'), ATTR.hookKind('other')]]);
  });

  it('records the permission span and wait', () => {
    recordPermission({ startMs: Date.now() - 1500, orchestrator: 'claude-code', toolName: 'Edit', decision: 'ask', timedOut: true });
    expect(rt.replaySpan).toHaveBeenCalledWith(expect.objectContaining({ name: 'clubhouse.agent.permission', outcome: 'timeout' }));
    expect(rt.count).toHaveBeenCalledWith('clubhouse.agent.permission.wait', expect.any(Number), [ATTR.permissionDecision('ask'), ATTR.permissionResult('timeout'), ATTR.permissionPath('hook')]);
    expect(vi.mocked(rt.replaySpan).mock.calls[0][0].attrs).toContainEqual(ATTR.permissionPath('hook'));
  });

  it('names Clubhouse MCP tools by suffix only, never the full name', () => {
    recordMcpToolCall('group__proj_x7q__send_message', Date.now(), 'ok', false);
    recordMcpToolCall('some_global_tool', Date.now(), 'threw', true);
    const spans = (rt.replaySpan as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(spans[0].attrs).toEqual([ATTR.mcpToolKind('group'), ATTR.mcpTool('send_message'), ATTR.mcpResult('ok')]);
    expect(spans[1]).toMatchObject({ outcome: 'error', errorType: 'mcp_tool_threw' });
    expect(JSON.stringify(spans)).not.toContain('proj_x7q');
  });

  it('names global tools and never names plugin tools', () => {
    recordMcpToolCall('notify_user', Date.now(), 'ok', true);
    recordMcpToolCall('plugin__acme_tool__navigate', Date.now(), 'ok', false);
    recordMcpToolCall('unknown_tool', Date.now(), 'threw', false);
    const attrs = (rt.replaySpan as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].attrs.slice(0, 2));
    expect(attrs).toEqual([
      [ATTR.mcpToolKind('global'), ATTR.mcpTool('notify_user')],
      [ATTR.mcpToolKind('plugin'), ATTR.mcpTool('other')],
      [ATTR.mcpToolKind('other'), ATTR.mcpTool('other')],
    ]);
  });

  it('lists every Clubhouse MCP tool suffix and global tool registered under clubhouse-mcp/tools', () => {
    const dir = path.resolve(__dirname, '../services/clubhouse-mcp/tools');
    const names = new Set<string>();
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const m of src.matchAll(/nameSuffix:\s*'([a-z_]+)'/g)) names.add(m[1]);
      for (const m of src.matchAll(/registerGlobalTool\(\s*'([a-z_]+)'/g)) names.add(m[1]);
    }
    expect(names.size).toBeGreaterThan(20);
    const allowed = getAttributeSpec('clubhouse.mcp.tool')?.values ?? [];
    expect([...names].filter((n) => !allowed.includes(n))).toEqual([]);
    expect(allowed.filter((v) => v !== 'other' && !names.has(v))).toEqual([]);
  });

  it('records binary lookup time by tier', () => {
    recordBinaryLookup('login_shell', Date.now() - 2000);
    expect(rt.count).toHaveBeenCalledWith('clubhouse.provider.binary_lookup.duration', expect.any(Number), [ATTR.binaryLookupTier('login_shell')]);
  });

  it('does nothing while telemetry is off', () => {
    setRuntime(null);
    recordHookEvent('claude-code', 'post_tool', 'Bash');
    recordMcpToolCall('x', Date.now(), 'ok', true);
    expect(rt.count).not.toHaveBeenCalled();
  });
});
