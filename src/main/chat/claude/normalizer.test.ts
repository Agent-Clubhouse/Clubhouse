import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { ClaudeNormalizer, initializedFromWire, permissionRequestFromWire } from './normalizer';
import { buildStreamJsonArgs } from './stream-transport';
import { toWirePermissionResult, toWireUserMessage } from './transport';

const kinds = (evs: Array<{ kind: string }>) => evs.map((e) => e.kind);

describe('ClaudeNormalizer', () => {
  it('keeps partial streams of a subagent apart from the main thread', () => {
    const n = new ClaudeNormalizer();
    n.normalize({ type: 'stream_event', event: { type: 'message_start', message: { id: 'main' } }, parent_tool_use_id: null });
    n.normalize({ type: 'stream_event', event: { type: 'message_start', message: { id: 'sub' } }, parent_tool_use_id: 'toolu_task' });
    const [main] = n.normalize({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } }, parent_tool_use_id: null });
    const [sub] = n.normalize({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'b' } }, parent_tool_use_id: 'toolu_task' });
    expect(main).toMatchObject({ kind: 'message_chunk', messageId: 'main', text: 'a' });
    expect(main).not.toHaveProperty('parentToolCallId', expect.anything());
    expect(sub).toMatchObject({ kind: 'thought_chunk', messageId: 'sub', text: 'b', parentToolCallId: 'toolu_task' });
  });

  it('maps assistant blocks and remembers tool names for their results', () => {
    const n = new ClaudeNormalizer();
    const a = n.normalize({
      type: 'assistant',
      session_id: 's1',
      message: {
        id: 'm1',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Editing' },
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.ts' } },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'b.ts' } },
        ],
      },
    });
    expect(kinds(a)).toEqual(['thought', 'message', 'tool_call', 'tool_call']);
    expect(a.every((e) => e.sessionId === 's1')).toBe(true);

    const r = n.normalize({
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] },
        { type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true },
      ] },
      tool_use_result: { structuredPatch: [] },
    });
    expect(r).toMatchObject([
      { kind: 'tool_call_update', toolCallId: 't1', name: 'Edit', status: 'completed', content: 'ok', result: undefined },
      { kind: 'tool_call_update', toolCallId: 't2', name: 'Read', status: 'failed', content: 'boom', result: undefined },
    ]);
  });

  it('attaches tool_use_result when the message carries one tool result', () => {
    const n = new ClaudeNormalizer();
    n.normalize({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'Edit', input: {} }] } });
    const [u] = n.normalize({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'done' }] },
      tool_use_result: { structuredPatch: [{ oldStart: 1 }] },
    });
    expect(u).toMatchObject({ kind: 'tool_call_update', result: { structuredPatch: [{ oldStart: 1 }] } });
  });

  it('maps user replays, system subtypes and subagent tasks', () => {
    const n = new ClaudeNormalizer();
    expect(n.normalize({ type: 'user', isReplay: true, uuid: 'u1', message: { content: 'hi' } })).toMatchObject([
      { kind: 'user_message', text: 'hi', uuid: 'u1', replay: true },
    ]);
    expect(n.normalize({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 9000 } })).toMatchObject([
      { kind: 'compacted', trigger: 'auto', preTokens: 9000 },
    ]);
    expect(n.normalize({ type: 'system', subtype: 'status', status: 'compacting' })).toEqual([]);
    expect(n.normalize({ type: 'system', subtype: 'task_started', task_id: 'task-1' })).toMatchObject([
      { kind: 'subagent', phase: 'started', taskId: 'task-1' },
    ]);
    expect(n.normalize({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash' })).toMatchObject([
      { kind: 'permission_denied', toolName: 'Bash' },
    ]);
    expect(n.normalize({ type: 'keep_alive' })).toEqual([]);
    expect(n.normalize({ type: 'something_new' })).toMatchObject([{ kind: 'unmapped', type: 'something_new' }]);
  });

  it('reports an assistant API error without dropping its content', () => {
    const n = new ClaudeNormalizer();
    const evs = n.normalize({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'partial' }] }, error: 'rate_limit' });
    expect(evs).toMatchObject([{ kind: 'message', text: 'partial' }, { kind: 'error', message: 'rate_limit', fatal: false }]);
  });

  it('maps an error result', () => {
    const n = new ClaudeNormalizer();
    const [r] = n.normalize({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many', 3], num_turns: 9 });
    expect(r).toMatchObject({ kind: 'turn_ended', subtype: 'error_max_turns', isError: true, errors: ['too many'], numTurns: 9 });
  });
});

describe('control protocol mapping', () => {
  it('maps can_use_tool wire fields', () => {
    expect(permissionRequestFromWire('r1', {
      tool_name: 'Write',
      input: { file_path: 'x' },
      tool_use_id: 't9',
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }, 'junk'],
      blocked_path: 'x',
      decision_reason: 'outside cwd',
      agent_id: 'a1',
      description: 'desc',
    })).toEqual({
      kind: 'permission_request',
      requestId: 'r1',
      toolName: 'Write',
      input: { file_path: 'x' },
      toolCallId: 't9',
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      title: undefined,
      description: 'desc',
      displayName: undefined,
      blockedPath: 'x',
      decisionReason: 'outside cwd',
      agentId: 'a1',
    });
  });

  it('maps the initialize response', () => {
    const body = initializedFromWire({ commands: [{ name: 'compact' }, 'junk'], models: [{ value: 'opus', displayName: 'Opus' }] });
    expect(body).toMatchObject({ kind: 'initialized', commands: [{ name: 'compact' }], models: [{ value: 'opus', displayName: 'Opus' }] });
  });

  it('echoes the original input on allow and keeps deny messages', () => {
    expect(toWirePermissionResult({ behavior: 'allow' }, { a: 1 }, 't1')).toEqual({ behavior: 'allow', updatedInput: { a: 1 }, toolUseID: 't1' });
    expect(toWirePermissionResult({ behavior: 'deny', message: 'no', interrupt: true }, {})).toEqual({ behavior: 'deny', message: 'no', interrupt: true });
  });

  it('builds text and image user messages', () => {
    expect(toWireUserMessage({ text: 'hi' }, 's')).toEqual({ type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null, session_id: 's' });
    const withImage = toWireUserMessage({ text: 'see', images: [{ mediaType: 'image/png', data: 'AAA' }], priority: 'now' }, '');
    expect(withImage).toMatchObject({
      priority: 'now',
      message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }, { type: 'text', text: 'see' }] },
    });
  });
});

describe('buildStreamJsonArgs', () => {
  it('builds the SDK-equivalent flag set', () => {
    const dir = path.join('repo', 'extra');
    const args = buildStreamJsonArgs({
      binary: 'claude',
      cwd: 'repo',
      permissionMode: 'bypassPermissions',
      includePartialMessages: false,
      resume: 'abc',
      forkSession: true,
      resumeSessionAt: 'msg-uuid',
      effort: 'high',
      mcpServers: { clubhouse: { type: 'stdio', command: 'node', args: ['bridge.js'] } },
      appendSystemPrompt: 'be brief',
      allowedTools: ['Read', 'Bash(git:*)'],
      disallowedTools: ['WebFetch'],
      additionalDirectories: [dir],
    });
    expect(args).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio', '--permission-mode', 'bypassPermissions',
      '--allow-dangerously-skip-permissions',
      '--effort', 'high',
      '--mcp-config', '{"mcpServers":{"clubhouse":{"type":"stdio","command":"node","args":["bridge.js"]}}}',
      '--resume', 'abc', '--fork-session', '--resume-session-at', 'msg-uuid',
      '--append-system-prompt', 'be brief',
      '--allowedTools', 'Read,Bash(git:*)', '--disallowedTools', 'WebFetch',
      '--add-dir', dir,
    ]);
  });

  it('ignores fork options without resume', () => {
    const args = buildStreamJsonArgs({ binary: 'claude', cwd: '.', permissionMode: 'default', forkSession: true });
    expect(args).not.toContain('--fork-session');
    expect(args).toContain('--include-partial-messages');
  });
});
