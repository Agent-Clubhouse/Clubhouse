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

  it('keeps the MCP servers from init, and leaves them out when the CLI sends none', () => {
    const n = new ClaudeNormalizer();
    const [withServers] = n.normalize({
      type: 'system', subtype: 'init', session_id: 's1',
      mcp_servers: [{ name: 'clubhouse', status: 'connected' }, { name: 'github', status: 'needs-auth' }, { status: 'failed' }, 'junk'],
    });
    expect(withServers).toMatchObject({ kind: 'session_started', mcpServers: [{ name: 'clubhouse', status: 'connected' }, { name: 'github', status: 'needs-auth' }] });
    const [without] = new ClaudeNormalizer().normalize({ type: 'system', subtype: 'init', session_id: 's1' });
    expect(without).not.toHaveProperty('mcpServers');
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
    expect(n.normalize({ type: 'system', subtype: 'something_new' })).toMatchObject([{ kind: 'unmapped', type: 'system', subtype: 'something_new' }]);
    expect(n.normalize({ type: 'something_new' })).toMatchObject([{ kind: 'unmapped', type: 'something_new' }]);
  });

  it('drops thinking-token estimates instead of reporting them as unknown', () => {
    const n = new ClaudeNormalizer();
    const frame = { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 120, estimated_tokens_delta: 40, uuid: 'u1', session_id: 's1' };
    expect(n.normalize(frame)).toEqual([]);
    expect(n.normalize(frame)).toEqual([]);
    // Dropped frames don't advance seq.
    expect(n.normalize({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash' })).toMatchObject([{ seq: 1 }]);
  });

  // Wire samples (#2109): shapes from Agent SDK 0.3.301's sdk.d.ts (tool_progress,
  // background_tasks_changed) and the bundled CLI's message schemas (the rest).
  describe('status frames from CLI 2.1.30x (#2109)', () => {
    const base = { uuid: 'u1', session_id: 's1' };

    it('maps tool_progress: Bash progress, heartbeats and subagent retries', () => {
      const n = new ClaudeNormalizer();
      expect(n.normalize({ ...base, type: 'tool_progress', tool_use_id: 'toolu_bash', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 12, task_id: 'b1' }))
        .toMatchObject([{ kind: 'tool_progress', toolCallId: 'toolu_bash', toolName: 'Bash', elapsedSeconds: 12, heartbeat: false }]);
      expect(n.normalize({ ...base, type: 'tool_progress', tool_use_id: 'toolu_web', tool_name: 'WebFetch', parent_tool_use_id: 'toolu_task', elapsed_time_seconds: 30, heartbeat: true }))
        .toMatchObject([{ kind: 'tool_progress', toolCallId: 'toolu_web', heartbeat: true, parentToolCallId: 'toolu_task' }]);
      const [retry] = n.normalize({
        ...base, type: 'tool_progress', tool_use_id: 'toolu_task', tool_name: 'Task', parent_tool_use_id: null, elapsed_time_seconds: 0,
        subagent_type: 'Explore',
        subagent_retry: { agent_id: 'ag1', attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error_category: 'overloaded' },
      });
      expect(retry).toMatchObject({
        kind: 'tool_progress', subagentType: 'Explore',
        retry: { attempt: 2, maxRetries: 10, retryDelayMs: 4000, errorStatus: 529, errorCategory: 'overloaded' },
      });
    });

    it('maps background_tasks_changed to the full live set', () => {
      const n = new ClaudeNormalizer();
      expect(n.normalize({
        ...base, type: 'system', subtype: 'background_tasks_changed',
        tasks: [
          { task_id: 't1', task_type: 'local_bash', description: 'npm run dev' },
          { task_id: 't2', task_type: 'local_agent', subagent_type: 'Explore', description: 'Find the bug', awaited: true },
          { task_id: 't3', task_type: 'local_bash', description: 'watcher', ambient: true },
        ],
      })).toMatchObject([{
        kind: 'background_tasks',
        tasks: [
          { taskId: 't1', taskType: 'local_bash', description: 'npm run dev', ambient: false },
          { taskId: 't2', taskType: 'local_agent', subagentType: 'Explore', description: 'Find the bug', ambient: false },
          { taskId: 't3', ambient: true },
        ],
      }]);
      expect(n.normalize({ ...base, type: 'system', subtype: 'background_tasks_changed', tasks: [] })).toMatchObject([{ kind: 'background_tasks', tasks: [] }]);
    });

    it('maps vcs_state_changed to a workspace change', () => {
      const n = new ClaudeNormalizer();
      expect(n.normalize({ ...base, type: 'system', subtype: 'vcs_state_changed', kind: 'commit', cwd: '/repo', branch: 'fix/x' }))
        .toMatchObject([{ kind: 'vcs_changed', vcsKind: 'commit', branch: 'fix/x', cwd: '/repo' }]);
    });

    it('knowingly drops code_change_published and command_lifecycle, without advancing seq', () => {
      const n = new ClaudeNormalizer();
      expect(n.normalize({
        ...base, type: 'system', subtype: 'code_change_published',
        provider: 'github', url: 'https://github.com/o/r/pull/1', repo: 'o/r', identifier: '1', action: 'created', branch: 'fix/x',
      })).toEqual([]);
      for (const state of ['queued', 'started', 'completed']) {
        expect(n.normalize({ ...base, type: 'command_lifecycle', command_uuid: 'c1', state })).toEqual([]);
      }
      expect(n.normalize({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash' })).toMatchObject([{ seq: 1 }]);
    });

    it('none of the five is reported as unmapped', () => {
      const n = new ClaudeNormalizer();
      const frames = [
        { type: 'tool_progress', tool_use_id: 't', tool_name: 'Bash', elapsed_time_seconds: 1 },
        { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
        { type: 'system', subtype: 'vcs_state_changed', kind: 'push', cwd: '/r' },
        { type: 'system', subtype: 'code_change_published', provider: 'github', url: 'u', repo: 'r', identifier: '1' },
        { type: 'command_lifecycle', command_uuid: 'c', state: 'queued' },
      ];
      expect(frames.flatMap((f) => n.normalize({ ...base, ...f })).filter((e) => e.kind === 'unmapped')).toEqual([]);
    });
  });

  it('reports an assistant API error without dropping its content', () => {
    const n = new ClaudeNormalizer();
    const evs = n.normalize({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'partial' }] }, error: 'rate_limit' });
    expect(evs).toMatchObject([{ kind: 'message', text: 'partial' }, { kind: 'error', message: 'rate_limit', fatal: false, apiError: 'rate_limit' }]);
  });

  it('reports a main-loop call\'s usage for context, and not a subagent\'s', () => {
    const n = new ClaudeNormalizer();
    const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };
    const main = n.normalize({ type: 'assistant', message: { id: 'm', model: 'claude-opus-5-5', content: [], usage }, parent_tool_use_id: null });
    expect(main).toMatchObject([{ kind: 'assistant_usage', messageId: 'm', model: 'claude-opus-5-5', usage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 } }]);
    expect(n.normalize({ type: 'assistant', message: { id: 's', content: [], usage }, parent_tool_use_id: 'toolu_task' })).toHaveLength(0);
  });

  it('keeps extra usage on a rate_limit_event', () => {
    const [ev] = new ClaudeNormalizer().normalize({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', overageStatus: 'allowed_warning', overageResetsAt: 1_760_000_000 } });
    expect(ev).toMatchObject({ kind: 'rate_limit', rateLimitType: 'five_hour', overageStatus: 'allowed_warning', overageResetsAt: 1_760_000_000 });
  });

  it('maps an error result', () => {
    const n = new ClaudeNormalizer();
    const [r] = n.normalize({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many', 3], num_turns: 9, stop_reason: 'tool_use', terminal_reason: 'max_turns' });
    expect(r).toMatchObject({ kind: 'turn_ended', subtype: 'error_max_turns', isError: true, errors: ['too many'], numTurns: 9, stopReason: 'tool_use', terminalReason: 'max_turns' });
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

  it('keeps the builtin marker on Claude Code\'s own commands (#2135)', () => {
    const body = initializedFromWire({ commands: [{ name: 'compact', builtin: true }, { name: 'code-review' }] });
    expect(body).toMatchObject({ commands: [{ name: 'compact', builtin: true }, { name: 'code-review' }] });
    expect((body as { commands: Array<{ builtin?: boolean }> }).commands[1]).not.toHaveProperty('builtin');
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
