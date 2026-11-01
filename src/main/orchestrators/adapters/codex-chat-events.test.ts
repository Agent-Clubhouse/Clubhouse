import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { CodexChatEventMapper, codexErrorCode, codexErrorName, toCodexInput, toCodexMcpServers } from './codex-chat-events';
import { isChatEvent, CHAT_CONTRACT_VERSION, COMPACTION_SETTLED, COMPACTION_STARTED, type ChatEventDraft } from '../../../shared/chat/events';
import type { ServerNotification } from './codex-protocol';
import * as fx from './codex-protocol/__fixtures__/app-server-session';

const at = { threadId: fx.THREAD_ID, turnId: fx.TURN_ID };

function itemStarted(item: Extract<ServerNotification, { method: 'item/started' }>['params']['item']): ServerNotification {
  return { method: 'item/started', params: { ...at, item, startedAtMs: 1 } };
}

function mapAll(mapper: CodexChatEventMapper, notifications: ServerNotification[]): ChatEventDraft[] {
  return notifications.flatMap((n) => mapper.mapNotification(n));
}

describe('CodexChatEventMapper', () => {
  let mapper: CodexChatEventMapper;

  beforeEach(() => {
    mapper = new CodexChatEventMapper();
  });

  it('maps a full turn to contract events in order', () => {
    const events = mapAll(mapper, fx.completedTurnNotifications);

    expect(events.map((e) => e.type)).toEqual([
      'session_state',        // thread active
      'turn_started',
      // userMessage started/completed: recorded by the runtime, not re-emitted
      'agent_thought_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
      'agent_message',
      'plan',
      'tool_call',            // npm test
      'tool_call_update',     // output delta
      'tool_call_update',     // completed
      'tool_call_update',     // patch updated
      // turn/diff/updated has no contract event
      'usage',                // tokens
      'usage',                // rate limits
      'error',                // retrying stream error
      'turn_ended',
      'session_state',        // idle
    ]);
  });

  it('every mapped draft stamps into a valid ChatEvent', () => {
    const events = mapAll(mapper, fx.completedTurnNotifications);
    events.forEach((draft, i) => {
      const envelope = { v: CHAT_CONTRACT_VERSION, agentId: 'a1', sessionId: 's1', seq: i + 1, ts: 1, ...draft };
      expect(isChatEvent(envelope)).toBe(true);
    });
  });

  it('carries message ids and leaves turn ids to the runtime', () => {
    const events = mapAll(mapper, fx.completedTurnNotifications);
    const chunks = events.filter((e) => e.type === 'agent_message_chunk');
    expect(chunks.map((e) => e.data)).toEqual([
      { messageId: 'item-agent-1', text: 'Running ' },
      { messageId: 'item-agent-1', text: 'the tests.' },
    ]);
    expect(events.every((e) => e.turnId === undefined)).toBe(true);
    expect(events.find((e) => e.type === 'turn_started')?.data).toEqual({ trigger: 'prompt', nativeTurnId: fx.TURN_ID });
    expect(events.find((e) => e.type === 'agent_message')?.data).toEqual({ messageId: 'item-agent-1', text: 'Running the tests.' });
  });

  it('appends streamed command output and replaces it on completion', () => {
    const events = mapAll(mapper, fx.completedTurnNotifications);
    const [call, delta, done] = events.filter((e) => e.type === 'tool_call' || e.type === 'tool_call_update');

    expect(call).toMatchObject({
      type: 'tool_call',
      data: { toolCallId: 'item-cmd-1', kind: 'execute', title: 'npm test', status: 'in_progress', toolName: 'commandExecution' },
    });
    expect(delta.data).toEqual({ toolCallId: 'item-cmd-1', content: [{ type: 'terminal', output: 'FAIL math.test.ts\n' }], contentMode: 'append' });
    expect(done.data).toEqual({
      toolCallId: 'item-cmd-1',
      status: 'completed',
      content: [{ type: 'terminal', command: 'npm test', cwd: 'workspace', output: 'FAIL math.test.ts\n', exitCode: 1 }],
      contentMode: 'replace',
      durationMs: 900,
    });
  });

  it('maps plan steps, token usage and rate-limit windows', () => {
    const events = mapAll(mapper, fx.completedTurnNotifications);

    expect(events.find((e) => e.type === 'plan')?.data).toEqual({
      entries: [
        { content: 'Run tests', status: 'in_progress' },
        { content: 'Fix failure', status: 'pending' },
      ],
    });
    const [tokens, limits] = events.filter((e) => e.type === 'usage');
    expect(tokens.data).toEqual({
      scope: 'session',
      tokens: { input: 1000, cachedInput: 400, cacheWrite: 0, output: 200, reasoning: 50, total: 1200 },
      context: { used: 300, size: 272_000 },
    });
    expect(limits.data).toEqual({
      scope: 'session',
      limits: [
        { window: '5h', utilization: 0.125, resetsAt: 1_760_610_000_000 },
        { window: 'week', utilization: 0.03, resetsAt: 1_761_000_000_000 },
      ],
    });
  });

  it('maps a retrying error with its stable code', () => {
    const events = mapAll(mapper, fx.completedTurnNotifications);
    expect(events.find((e) => e.type === 'error')?.data).toEqual({
      code: 'unknown',
      message: 'stream disconnected',
      fatal: false,
      willRetry: true,
    });
  });

  it.each([
    [fx.completedTurnNotifications.find((n) => n.method === 'turn/completed'), 'end_turn'],
    [fx.interruptedTurnCompleted, 'cancelled'],
    [fx.failedTurnCompleted, 'error'],
  ] as const)('maps turn/completed to stop reason %#', (notification, stopReason) => {
    const events = mapper.mapNotification(notification as ServerNotification);
    expect(events[events.length - 1]).toMatchObject({ type: 'turn_ended', data: { stopReason, durationMs: 8000 } });
  });

  it('a failed turn also reports its error', () => {
    const [error] = mapper.mapNotification(fx.failedTurnCompleted);
    expect(error).toEqual({
      type: 'error',
      data: { code: 'rate_limited', message: 'usage limit reached', fatal: false },
    });
  });

  it('a context-window failure ends the turn as max_tokens', () => {
    const turn = { ...fx.failedTurnCompleted.params.turn, error: { ...fx.failedTurnCompleted.params.turn.error!, codexErrorInfo: 'contextWindowExceeded' as const } };
    const events = mapper.mapNotification({ method: 'turn/completed', params: { threadId: fx.THREAD_ID, turn } });
    expect(events[1]).toMatchObject({ type: 'turn_ended', data: { stopReason: 'max_tokens' } });
  });

  it('reports a terminal failure once across error → failed turn/completed', () => {
    const turnError = fx.failedTurnCompleted.params.turn.error!;
    const events = mapAll(mapper, [
      fx.secondTurnStarted,
      { method: 'error', params: { threadId: fx.THREAD_ID, turnId: fx.SECOND_TURN_ID, willRetry: false, error: turnError } },
      fx.failedTurnCompleted,
    ]);

    expect(events.map((e) => e.type)).toEqual(['turn_started', 'error', 'turn_ended']);
    expect(events[1].data).toEqual({ code: 'rate_limited', message: 'usage limit reached', fatal: false, willRetry: false });
    expect(events[2].data).toMatchObject({ stopReason: 'error' });
  });

  it('keeps a retrying error and still reports the eventual failure', () => {
    const turnError = fx.failedTurnCompleted.params.turn.error!;
    const events = mapAll(mapper, [
      { method: 'error', params: { threadId: fx.THREAD_ID, turnId: fx.SECOND_TURN_ID, willRetry: true, error: turnError } },
      fx.failedTurnCompleted,
    ]);

    expect(events.map((e) => [e.type, e.type === 'error' ? e.data.willRetry : undefined])).toEqual([
      ['error', true],
      ['error', undefined],
      ['turn_ended', undefined],
    ]);
  });

  describe('items', () => {
    const started = (item: Parameters<typeof itemStarted>[0]) => mapper.mapNotification(itemStarted(item));
    const completed = (item: Parameters<typeof itemStarted>[0]) =>
      mapper.mapNotification({ method: 'item/completed', params: { ...at, item, completedAtMs: 2 } });

    it('maps an MCP tool call', () => {
      const item = {
        type: 'mcpToolCall' as const, id: 'mcp-1', server: 'clubhouse', tool: 'send_message', status: 'inProgress' as const,
        arguments: { to: 'agent-2' }, appContext: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null,
      };
      expect(started(item)[0].data).toEqual({
        toolCallId: 'mcp-1', kind: 'other', title: 'clubhouse: send_message', status: 'in_progress',
        toolName: 'mcp__clubhouse__send_message', rawInput: { to: 'agent-2' },
      });
      expect(completed({ ...item, status: 'failed', error: { message: 'no such agent' }, durationMs: 12 })[0].data).toEqual({
        toolCallId: 'mcp-1', status: 'failed', error: 'no such agent', durationMs: 12,
      });
      const result = { content: [{ type: 'text', text: 'sent' }], structuredContent: null, _meta: null };
      expect(completed({ ...item, status: 'completed', result })[0].data).toEqual({ toolCallId: 'mcp-1', status: 'completed', rawOutput: result });
    });

    it('maps a dynamic tool call, failing on success:false', () => {
      const item = {
        type: 'dynamicToolCall' as const, id: 'dyn-1', namespace: 'ext', tool: 'lookup', arguments: {}, status: 'inProgress' as const,
        contentItems: null, success: null, durationMs: null,
      };
      expect(started(item)[0].data).toMatchObject({ toolCallId: 'dyn-1', title: 'lookup', toolName: 'ext.lookup', kind: 'other' });
      expect(completed({ ...item, status: 'completed', success: false })[0].data).toMatchObject({ status: 'failed' });
      expect(completed({ ...item, status: 'completed', success: true })[0].data).toMatchObject({ status: 'completed' });
    });

    it('maps a web search', () => {
      const item = { type: 'webSearch' as const, id: 'ws-1', query: 'codex app-server', action: null, results: null };
      expect(started(item)[0].data).toEqual({ toolCallId: 'ws-1', kind: 'fetch', title: 'Search: codex app-server', status: 'in_progress', toolName: 'webSearch' });
      expect(completed(item)[0].data).toEqual({ toolCallId: 'ws-1', status: 'completed' });
    });

    it('maps an image view as a completed read with the image to preview', () => {
      expect(started({ type: 'imageView', id: 'img-1', path: 'shot.png' })[0].data).toEqual({
        toolCallId: 'img-1', kind: 'read', title: 'View shot.png', status: 'completed', toolName: 'imageView', locations: [{ path: 'shot.png' }],
        media: [{ type: 'image', mimeType: 'image/*', sourcePath: 'shot.png' }],
      });
    });

    it('keeps a generated image that arrives as a fileId (Codex 0.166)', () => {
      const item = {
        type: 'imageGeneration' as const, id: 'gen-2', status: 'completed', revisedPrompt: 'a red fox', fileId: 'file-1', failure: null, generationId: null,
      };
      expect(completed({ ...item, savedPath: '/home/u/.codex/generated_images/fox.png' })[0].data).toEqual({
        toolCallId: 'gen-2', status: 'completed', title: 'a red fox', media: [{ type: 'image', mimeType: 'image/png', sourcePath: '/home/u/.codex/generated_images/fox.png' }],
      });
      expect(completed(item)[0].data).toEqual({
        toolCallId: 'gen-2', status: 'completed', title: 'a red fox', media: [{ type: 'image', mimeType: 'image/png', unavailable: true }],
      });
    });

    it('maps a generated image to a media-only call carrying its bytes', () => {
      const item = {
        type: 'imageGeneration' as const, id: 'gen-1', status: 'generating', revisedPrompt: null, result: '', failure: null,
      };
      expect(started(item)[0].data).toEqual({ toolCallId: 'gen-1', kind: 'other', title: 'Generating image', status: 'in_progress', toolName: 'imageGeneration', mediaOnly: true });
      expect(completed({ ...item, status: 'completed', revisedPrompt: 'a red fox', result: 'iVBORw0KGgo=', savedPath: '/home/u/.codex/generated_images/fox.png' })[0].data).toEqual({
        toolCallId: 'gen-1', status: 'completed', title: 'a red fox', media: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
      });
      expect(completed({ ...item, status: 'failed', failure: { type: 'usageLimitExceeded', limitId: 'images', resetsAt: null } })[0].data).toEqual({
        toolCallId: 'gen-1', status: 'failed', title: 'Generated image', error: 'Image generation hit a usage limit',
      });
    });

    it('maps images in MCP and dynamic tool results', () => {
      const mcp = {
        type: 'mcpToolCall' as const, id: 'mcp-img', server: 'browser', tool: 'screenshot', status: 'completed' as const, arguments: {},
        result: { content: [
          { type: 'text', text: 'took it' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
          { type: 'resource', resource: { uri: 'mem://shot', mimeType: 'image/webp', blob: 'BBBB' } },
          { type: 'resource', resource: { uri: 'mem://log', mimeType: 'text/plain', blob: 'CCCC' } },
        ], structuredContent: null, _meta: null },
        error: null, durationMs: 5,
      };
      expect(completed(mcp as never)[0].data).toMatchObject({ media: [{ type: 'image', mimeType: 'image/jpeg', data: 'AAAA' }, { type: 'image', mimeType: 'image/webp', data: 'BBBB' }] });
      const dyn = {
        type: 'dynamicToolCall' as const, id: 'dyn-img', namespace: null, tool: 'render', arguments: {}, status: 'completed' as const, success: true, durationMs: null,
        contentItems: [{ type: 'inputImage' as const, imageUrl: 'data:image/png;base64,AAAA' }, { type: 'inputImage' as const, imageUrl: 'https://example.com/a.png' }],
      };
      expect(completed(dyn as never)[0].data).toMatchObject({
        media: [{ type: 'image', mimeType: 'image/*', data: 'data:image/png;base64,AAAA' }, { type: 'image', mimeType: 'image/*', uri: 'https://example.com/a.png' }],
      });
    });

    it('maps collab agent calls to one subagent event per receiver thread', () => {
      const item = {
        type: 'collabAgentToolCall' as const, id: 'collab-1', tool: 'spawnAgent' as const, status: 'inProgress' as const,
        senderThreadId: fx.THREAD_ID, receiverThreadIds: ['sub-a', 'sub-b'], prompt: 'help', model: null, reasoningEffort: null, agentsStates: {},
      };
      expect(started(item).map((e) => e.data)).toEqual([
        { subagentId: 'sub-a', name: 'spawnAgent', status: 'running', parentToolCallId: 'collab-1', nativeSessionId: 'sub-a' },
        { subagentId: 'sub-b', name: 'spawnAgent', status: 'running', parentToolCallId: 'collab-1', nativeSessionId: 'sub-b' },
      ]);
      expect(completed({ ...item, status: 'interrupted' })[0].data).toMatchObject({ status: 'cancelled' });
      expect(completed({ ...item, status: 'failed' })[0].data).toMatchObject({ status: 'failed' });
      expect(completed({ ...item, status: 'completed' })[0].data).toMatchObject({ status: 'completed' });
    });

    it('uses the reasoning summary, falling back to raw content', () => {
      expect(completed({ type: 'reasoning', id: 'r-1', summary: ['First', 'Second'], content: ['raw'] })[0].data).toEqual({ messageId: 'r-1', text: 'First\n\nSecond' });
      expect(completed({ type: 'reasoning', id: 'r-2', summary: [], content: ['raw a', 'raw b'] })[0].data).toEqual({ messageId: 'r-2', text: 'raw a\n\nraw b' });
      expect(completed({ type: 'reasoning', id: 'r-3', summary: [], content: [] })).toEqual([]);
    });

    it('maps review mode: entering is a notice, the exited item carries the review', () => {
      expect(completed({ type: 'enteredReviewMode', id: 'rv-1', review: 'current changes' })).toEqual([
        { type: 'notice', data: { level: 'info', code: 'review_started', message: 'Reviewing current changes' } },
      ]);
      expect(completed({ type: 'exitedReviewMode', id: 'rv-2', review: '- [P1] Null check missing in parse()' })).toEqual([
        { type: 'agent_message', data: { messageId: 'rv-2', text: '- [P1] Null check missing in parse()' } },
      ]);
      expect(completed({ type: 'exitedReviewMode', id: 'rv-3', review: '' })).toEqual([]);
    });

    it('maps a context compaction to a running notice that the completed item settles', () => {
      // Auto compaction and /compact (thread/compact/start) both arrive as a contextCompaction item.
      expect(started({ type: 'contextCompaction', id: 'cc-1' })).toEqual([
        { type: 'notice', data: { level: 'info', code: COMPACTION_STARTED, message: 'Compacting context…' } },
      ]);
      const done = completed({ type: 'contextCompaction', id: 'cc-1' });
      expect(done).toEqual([
        { type: 'notice', data: { level: 'info', code: 'context_compacted', message: 'Context compacted' } },
      ]);
      expect(COMPACTION_SETTLED).toContain((done[0] as Extract<ChatEventDraft, { type: 'notice' }>).data.code);
    });
  });

  it('maps a model reroute to model_changed', () => {
    expect(mapper.mapNotification({
      method: 'model/rerouted',
      params: { ...at, fromModel: 'gpt-5-codex', toModel: 'gpt-5', reason: 'highRiskCyberActivity' },
    })).toEqual([{ type: 'model_changed', data: { modelId: 'gpt-5' } }]);
  });

  it('maps thread status flags to session states', () => {
    const state = (status: Extract<ServerNotification, { method: 'thread/status/changed' }>['params']['status']) =>
      mapper.mapNotification({ method: 'thread/status/changed', params: { threadId: fx.THREAD_ID, status } });

    expect(state({ type: 'active', activeFlags: ['waitingOnApproval'] })).toEqual([{ type: 'session_state', data: { state: 'waiting_permission' } }]);
    expect(state({ type: 'active', activeFlags: ['waitingOnUserInput'] })).toEqual([{ type: 'session_state', data: { state: 'waiting_input' } }]);
    expect(state({ type: 'systemError' })).toEqual([{ type: 'session_state', data: { state: 'error' } }]);
    expect(state({ type: 'notLoaded' })).toEqual([]);
  });

  it('streams a plan document and finalizes it', () => {
    const d1 = mapper.mapNotification({ method: 'item/plan/delta', params: { ...at, itemId: 'plan-1', delta: '# Plan\n' } });
    const d2 = mapper.mapNotification({ method: 'item/plan/delta', params: { ...at, itemId: 'plan-1', delta: '- step' } });
    const done = mapper.mapNotification({ method: 'item/completed', params: { ...at, item: { type: 'plan', id: 'plan-1', text: '# Plan\n- step' }, completedAtMs: 1 } });

    expect(d1[0].data).toEqual({ planId: 'plan-1', markdown: '# Plan\n', status: 'streaming' });
    expect(d2[0].data).toEqual({ planId: 'plan-1', markdown: '# Plan\n- step', status: 'streaming' });
    expect(done[0].data).toEqual({ planId: 'plan-1', markdown: '# Plan\n- step', status: 'ready' });
  });

  it('maps file changes to an edit tool call with diffs', () => {
    const item = {
      type: 'fileChange' as const,
      id: 'item-patch-1',
      changes: [{ path: 'src/math.ts', kind: { type: 'update' as const, move_path: null }, diff: '-a\n+b\n' }],
      status: 'inProgress' as const,
    };
    const [started] = mapper.mapNotification({ method: 'item/started', params: { ...at, item, startedAtMs: 1 } });
    const [completed] = mapper.mapNotification({ method: 'item/completed', params: { ...at, item: { ...item, status: 'declined' }, completedAtMs: 2 } });

    expect(started.data).toEqual({
      toolCallId: 'item-patch-1',
      kind: 'edit',
      title: 'Edit src/math.ts',
      status: 'in_progress',
      toolName: 'fileChange',
      locations: [{ path: 'src/math.ts' }],
      content: [{ type: 'diff', path: 'src/math.ts', unifiedDiff: '-a\n+b\n' }],
    });
    expect(completed.data).toMatchObject({ toolCallId: 'item-patch-1', status: 'cancelled' });
  });

  it('known notifications with no chat meaning map to nothing', () => {
    expect(mapper.mapNotification({ method: 'turn/diff/updated', params: { ...at, diff: '' } })).toEqual([]);
    expect(mapper.mapNotification({ method: 'skills/changed', params: {} } as ServerNotification)).toEqual([]);
  });

  it('surfaces warnings as notices', () => {
    expect(mapper.mapNotification({ method: 'warning', params: { threadId: null, message: 'slow' } })).toEqual([
      { type: 'notice', data: { level: 'warn', code: 'codex_warning', message: 'slow' } },
    ]);
  });

  // ── Permissions ──────────────────────────────────────────────────────────

  describe('permissions', () => {
    it('maps a command approval with every native option', () => {
      const [event] = mapper.mapServerRequest(fx.commandApprovalRequest)!;

      expect(event).toMatchObject({
        type: 'permission_request',
        data: {
          requestId: '0',
          title: 'Run npm install',
          description: 'needs network to install deps',
          toolCallId: 'item-cmd-1',
          toolName: 'commandExecution',
        },
      });
      expect(event.type === 'permission_request' && event.data.options).toEqual([
        { optionId: 'accept', kind: 'allow_once', label: 'Allow' },
        { optionId: 'acceptForSession', kind: 'allow_session', label: 'Allow for this session' },
        { optionId: 'execpolicy', kind: 'allow_always', label: 'Always allow npm install', scope: 'npm install' },
        { optionId: 'network:0', kind: 'allow_always', label: 'Always allow network access to registry.npmjs.org', scope: 'registry.npmjs.org' },
        { optionId: 'decline', kind: 'reject_once', label: 'Deny' },
        { optionId: 'cancel', kind: 'cancel_turn', label: 'Deny and stop the turn' },
      ]);
    });

    it.each([
      ['accept', 'accept', 'allow'],
      ['acceptForSession', 'acceptForSession', 'allow'],
      ['execpolicy', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'install'] } }, 'allow'],
      ['network:0', { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'registry.npmjs.org', action: 'allow' } } }, 'allow'],
      ['decline', 'decline', 'deny'],
      ['cancel', 'cancel', 'cancelled'],
    ])('resolves command option %s to the native decision', (optionId, decision, outcome) => {
      mapper.mapServerRequest(fx.commandApprovalRequest);

      const resolved = mapper.resolvePermission('0', optionId);

      expect(resolved?.reply).toEqual({ id: 0, method: 'item/commandExecution/requestApproval', result: { decision } });
      expect(resolved?.event).toEqual({ type: 'permission_resolved', data: { requestId: '0', optionId, decision: outcome, by: 'user' } });
      expect(mapper.resolvePermission('0', optionId)).toBeUndefined();
    });

    it('maps and resolves a file-change approval', () => {
      const [event] = mapper.mapServerRequest(fx.fileChangeApprovalRequest)!;
      expect(event.type === 'permission_request' && event.data.options.map((o) => o.optionId)).toEqual(['accept', 'acceptForSession', 'decline', 'cancel']);

      const resolved = mapper.resolvePermission('1', 'acceptForSession', 'annex');
      expect(resolved?.reply).toEqual({ id: 1, method: 'item/fileChange/requestApproval', result: { decision: 'acceptForSession' } });
      expect(resolved?.event.data).toMatchObject({ decision: 'allow', by: 'annex' });
    });

    it('rejects unknown request or option ids', () => {
      mapper.mapServerRequest(fx.fileChangeApprovalRequest);
      expect(mapper.resolvePermission('1', 'execpolicy')).toBeUndefined();
      expect(mapper.resolvePermission('nope', 'accept')).toBeUndefined();
    });

    it('a request Codex withdraws resolves as cancelled by the agent', () => {
      mapper.mapServerRequest(fx.fileChangeApprovalRequest);

      expect(mapper.mapNotification(fx.serverRequestResolved)).toEqual([
        { type: 'permission_resolved', data: { requestId: '1', decision: 'cancelled', by: 'agent' } },
      ]);
      expect(mapper.resolvePermission('1', 'accept')).toBeUndefined();
      expect(mapper.mapNotification(fx.serverRequestResolved)).toEqual([]);
    });

    describe('additional-permissions requests', () => {
      const request = {
        method: 'item/permissions/requestApproval' as const,
        id: 11,
        params: {
          ...at, itemId: 'item-perm-1', environmentId: null, startedAtMs: 1, cwd: 'workspace', reason: 'needs to fetch deps',
          permissions: { network: { enabled: true }, fileSystem: { read: null, write: ['build'] } },
        },
      };

      it('maps to a permission_request with turn and session grants', () => {
        expect(mapper.mapServerRequest(request)).toEqual([{
          type: 'permission_request',
          data: {
            requestId: '11',
            title: 'Allow network access and write access to build',
            description: 'needs to fetch deps',
            toolCallId: 'item-perm-1',
            toolName: 'permissions',
            rawInput: request.params.permissions,
            options: [
              { optionId: 'grantForTurn', kind: 'allow_once', label: 'Allow for this turn' },
              { optionId: 'grantForSession', kind: 'allow_session', label: 'Allow for this session' },
              { optionId: 'decline', kind: 'reject_once', label: 'Deny' },
            ],
          },
        }]);
      });

      it.each([
        ['grantForTurn', { permissions: request.params.permissions, scope: 'turn' }, 'allow'],
        ['grantForSession', { permissions: request.params.permissions, scope: 'session' }, 'allow'],
        ['decline', { permissions: {}, scope: 'turn' }, 'deny'],
      ])('resolves %s', (optionId, result, outcome) => {
        mapper.mapServerRequest(request);
        const resolved = mapper.resolvePermission('11', optionId);
        expect(resolved?.reply).toEqual({ id: 11, method: 'item/permissions/requestApproval', result });
        expect(resolved?.event.data).toMatchObject({ decision: outcome });
      });
    });

    it('returns null for server requests the contract cannot express', () => {
      expect(mapper.mapServerRequest({
        method: 'item/tool/call',
        id: 5,
        params: { ...at, callId: 'c', namespace: null, tool: 't', arguments: {} },
      })).toBeNull();
    });
  });

  describe('questions', () => {
    const request = {
      method: 'item/tool/requestUserInput' as const,
      id: 5,
      params: {
        ...at,
        itemId: 'item-q-1',
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          { id: 'q1', header: 'Scope', question: 'Which package?', isOther: false, isSecret: false, options: [{ label: 'app', description: 'The app' }, { label: 'lib', description: '' }] },
          { id: 'q2', header: '', question: 'Anything else?', isOther: false, isSecret: false, options: null },
        ],
      },
    };

    it('maps requestUserInput to a question event', () => {
      expect(mapper.mapServerRequest(request)).toEqual([{
        type: 'question',
        data: {
          requestId: '5',
          toolCallId: 'item-q-1',
          questions: [
            { id: 'q1', prompt: 'Which package?', header: 'Scope', options: [{ id: 'app', label: 'app', description: 'The app' }, { id: 'lib', label: 'lib' }], allowFreeText: false },
            { id: 'q2', prompt: 'Anything else?', allowFreeText: true },
          ],
        },
      }]);
    });

    it('resolves answers into the Codex reply', () => {
      mapper.mapServerRequest(request);

      const resolved = mapper.resolveQuestion('5', { q1: 'app', q2: ['no', 'thanks'] });

      expect(resolved?.reply).toEqual({
        id: 5,
        method: 'item/tool/requestUserInput',
        result: { answers: { q1: { answers: ['app'] }, q2: { answers: ['no', 'thanks'] } } },
      });
      expect(resolved?.event).toEqual({ type: 'question_resolved', data: { requestId: '5', answers: { q1: 'app', q2: ['no', 'thanks'] } } });
      expect(mapper.resolveQuestion('5', {})).toBeUndefined();
    });

    it('a question Codex withdraws resolves as cancelled', () => {
      mapper.mapServerRequest(request);
      expect(mapper.mapNotification({ method: 'serverRequest/resolved', params: { threadId: fx.THREAD_ID, requestId: 5 } })).toEqual([
        { type: 'question_resolved', data: { requestId: '5', answers: {}, cancelled: true } },
      ]);
    });
  });

  it('cancelOpenRequests resolves every open approval and question once', () => {
    mapper.mapServerRequest(fx.commandApprovalRequest);
    mapper.mapServerRequest({
      method: 'item/tool/requestUserInput',
      id: 5,
      params: { ...at, itemId: 'q', isBlocking: true, autoResolutionMs: null, questions: [] },
    });

    expect(mapper.cancelOpenRequests()).toEqual([
      { type: 'permission_resolved', data: { requestId: '0', decision: 'cancelled', by: 'agent' } },
      { type: 'question_resolved', data: { requestId: '5', answers: {}, cancelled: true } },
    ]);
    expect(mapper.cancelOpenRequests()).toEqual([]);
    expect(mapper.resolvePermission('0', 'accept')).toBeUndefined();
  });

  it('maps unrecognized messages to protocol_unknown', () => {
    expect(mapper.mapUnrecognized({ kind: 'notification', method: 'thread/new', params: {} })).toEqual([
      { type: 'protocol_unknown', data: { driver: 'codex_app_server', kind: 'notification', name: 'thread/new' } },
    ]);
    expect(mapper.mapUnrecognized({ kind: 'request', id: 1, method: 'x/y', params: {} })[0].data).toMatchObject({ kind: 'request', name: 'x/y' });
    expect(mapper.mapUnrecognized({ kind: 'other', message: {} })[0].data).toMatchObject({ kind: 'field' });
  });
});

describe('codex chat helpers', () => {
  it('codexErrorName reads string and object infos', () => {
    expect(codexErrorName('unauthorized')).toBe('unauthorized');
    expect(codexErrorName({ httpConnectionFailed: { httpStatusCode: 502 } })).toBe('httpConnectionFailed');
    expect(codexErrorName(null)).toBeUndefined();
  });

  it.each([
    ['contextWindowExceeded', 'context_overflow'],
    ['usageLimitExceeded', 'rate_limited'],
    ['rateLimitExceeded', 'rate_limited'],
    ['unauthorized', 'auth_required'],
    ['cyberPolicy', 'refusal'],
    ['sandboxError', 'tool_failed'],
    ['badRequest', 'protocol_error'],
    ['serverOverloaded', 'unknown'],
  ] as const)('codexErrorCode maps %s to %s', (info, code) => {
    expect(codexErrorCode(info)).toBe(code);
  });

  it('a policy refusal ends the turn as refusal', () => {
    const mapper = new CodexChatEventMapper();
    const turn = { ...fx.failedTurnCompleted.params.turn, error: { ...fx.failedTurnCompleted.params.turn.error!, codexErrorInfo: 'cyberPolicy' as const } };
    const events = mapper.mapNotification({ method: 'turn/completed', params: { threadId: fx.THREAD_ID, turn } });
    expect(events[1]).toMatchObject({ type: 'turn_ended', data: { stopReason: 'refusal' } });
  });

  it('maps a thread rename to session_info', () => {
    const mapper = new CodexChatEventMapper();
    expect(mapper.mapNotification({ method: 'thread/name/updated', params: { threadId: fx.THREAD_ID, threadName: 'Fix tests' } })).toEqual([
      { type: 'session_info', data: { title: 'Fix tests' } },
    ]);
  });

  it('toCodexInput converts contract content blocks', () => {
    expect(toCodexInput([
      { type: 'text', text: 'hi' },
      { type: 'image', mimeType: 'image/png', path: 'shot.png' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      { type: 'file', path: 'src/a.ts' },
      { type: 'resource', uri: 'x://y' },
    ])).toEqual([
      { type: 'text', text: 'hi', text_elements: [] },
      { type: 'localImage', path: 'shot.png' },
      { type: 'image', url: 'data:image/png;base64,AAAA' },
      { type: 'mention', name: 'src/a.ts', path: 'src/a.ts' },
    ]);
  });
});

describe('toCodexMcpServers', () => {
  it('translates stdio and HTTP servers to the keys Codex reads', () => {
    expect(toCodexMcpServers({
      clubhouse: { type: 'stdio', command: 'node', args: ['bridge.js'], env: { CLUBHOUSE_MCP_PORT: 4123 } },
      local: { command: 'uvx', args: [], cwd: 'tools' },
      remote: { type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'Bearer x' } },
      plain: { url: 'https://other.example.test/mcp', bearer_token_env_var: 'OTHER_TOKEN' },
    })).toEqual({
      servers: {
        clubhouse: { command: 'node', args: ['bridge.js'], env: { CLUBHOUSE_MCP_PORT: '4123' } },
        local: { command: 'uvx', cwd: 'tools' },
        remote: { url: 'https://mcp.example.test/mcp', http_headers: { Authorization: 'Bearer x' } },
        plain: { url: 'https://other.example.test/mcp', bearer_token_env_var: 'OTHER_TOKEN' },
      },
      skipped: [],
    });
  });

  it('skips SSE and malformed servers rather than mis-wiring them', () => {
    expect(toCodexMcpServers({
      events: { type: 'sse', url: 'https://sse.example.test/sse' },
      broken: { type: 'stdio' },
      nothing: null,
    })).toEqual({
      servers: {},
      skipped: [
        { name: 'events', reason: 'Codex has no SSE transport' },
        { name: 'broken', reason: 'not a stdio or HTTP server' },
        { name: 'nothing', reason: 'not a stdio or HTTP server' },
      ],
    });
  });

  it('handles no servers', () => {
    expect(toCodexMcpServers(undefined)).toEqual({ servers: {}, skipped: [] });
  });

  it('passes env_vars through so Codex forwards the bridge nonce from its own env (#2222)', () => {
    expect(toCodexMcpServers({
      clubhouse: { type: 'stdio', command: 'node', args: ['bridge.js'], env_vars: ['CLUBHOUSE_HOOK_NONCE', 7] },
    }).servers.clubhouse).toEqual({ command: 'node', args: ['bridge.js'], env_vars: ['CLUBHOUSE_HOOK_NONCE'] });
  });

  it('accepts the streamable-http spelling and leaves disabled servers out', () => {
    expect(toCodexMcpServers({
      dashed: { type: 'streamable-http', url: 'https://a.example.test/mcp' },
      off: { command: 'node', disabled: true },
    })).toEqual({ servers: { dashed: { url: 'https://a.example.test/mcp' } }, skipped: [] });
  });

  it('resolves a relative cwd against the agent directory and keeps an absolute one', () => {
    const base = path.join(os.tmpdir(), 'project');
    const absolute = path.join(os.tmpdir(), 'elsewhere');
    const { servers } = toCodexMcpServers({
      rel: { command: 'node', cwd: 'tools' },
      abs: { command: 'node', cwd: absolute },
    }, base);
    expect(servers.rel).toEqual({ command: 'node', cwd: path.resolve(base, 'tools') });
    expect(servers.abs).toEqual({ command: 'node', cwd: absolute });
  });

  it('passes ${VAR} through literally (Codex does not expand it either)', () => {
    expect(toCodexMcpServers({ s: { command: 'node', env: { TOKEN: '${MY_TOKEN}' } } }).servers.s)
      .toEqual({ command: 'node', env: { TOKEN: '${MY_TOKEN}' } });
  });
});

describe('MCP startup status', () => {
  const status = (s: 'starting' | 'ready' | 'failed', error: string | null = null) => new CodexChatEventMapper().mapNotification({
    method: 'mcpServer/startupStatus/updated',
    params: { threadId: null, name: 'remote', status: s, error, failureReason: null },
  });

  it('reports a server that failed to start', () => {
    expect(status('failed', 'connection refused')).toEqual([
      { type: 'notice', data: { level: 'warn', code: 'mcp_server_failed', message: 'MCP server remote failed to start: connection refused' } },
    ]);
  });

  it('strips URL query strings and shortens Codex\'s error text', () => {
    const [notice] = status('failed', `GET https://mcp.example.test/mcp?token=abc123&x=1 returned 401 ${'x'.repeat(300)}`);
    expect(notice.type === 'notice' && notice.data.message).not.toContain('abc123');
    expect(notice.type === 'notice' && notice.data.message).toContain('https://mcp.example.test/mcp?…');
    expect(notice.type === 'notice' && notice.data.message.length).toBeLessThan(260);
  });

  it('stays quiet while servers start or once they are ready', () => {
    expect(status('starting')).toEqual([]);
    expect(status('ready')).toEqual([]);
  });
});

describe('file change line counts (#2160)', () => {
  const change = (kind: 'add' | 'delete' | 'update', diff: string) => ({
    path: 'itest-codex.txt',
    kind: kind === 'update' ? { type: 'update' as const, move_path: null } : { type: kind },
    diff,
  });
  const fileChangeItem = (changes: ReturnType<typeof change>[]) => ({
    type: 'fileChange' as const, id: 'patch-1', changes, status: 'inProgress' as const,
  });
  const diffsOf = (events: ChatEventDraft[]) => events.flatMap((e) => {
    const content = (e.data as { content?: unknown[] }).content ?? [];
    return content.filter((c) => (c as { type: string }).type === 'diff');
  });

  it("maps an added file's content as newText, so the card counts its lines and shows it as created", () => {
    const events = new CodexChatEventMapper().mapNotification(itemStarted(fileChangeItem([change('add', 'hello\n')])));
    expect(diffsOf(events)).toEqual([{ type: 'diff', path: 'itest-codex.txt', newText: 'hello\n' }]);
  });

  it("maps a deleted file's content as oldText", () => {
    const events = new CodexChatEventMapper().mapNotification(itemStarted(fileChangeItem([change('delete', 'bye\n')])));
    expect(diffsOf(events)).toEqual([{ type: 'diff', path: 'itest-codex.txt', oldText: 'bye\n' }]);
  });

  it('keeps an update as a unified diff', () => {
    const events = new CodexChatEventMapper().mapNotification(itemStarted(fileChangeItem([change('update', '@@ -1 +1 @@\n-a\n+b\n')])));
    expect(diffsOf(events)).toEqual([{ type: 'diff', path: 'itest-codex.txt', unifiedDiff: '@@ -1 +1 @@\n-a\n+b\n' }]);
  });

  it('maps the same way while pending approval (patchUpdated) and once applied (item/completed)', () => {
    const mapper = new CodexChatEventMapper();
    const pending = mapper.mapNotification({ method: 'item/fileChange/patchUpdated', params: { ...at, itemId: 'patch-1', changes: [change('add', 'hello\n')] } });
    const applied = mapper.mapNotification({
      method: 'item/completed',
      params: { ...at, item: { ...fileChangeItem([change('add', 'hello\n')]), status: 'completed' }, completedAtMs: 2 },
    });
    expect(diffsOf(pending)).toEqual([{ type: 'diff', path: 'itest-codex.txt', newText: 'hello\n' }]);
    expect(diffsOf(applied)).toEqual([{ type: 'diff', path: 'itest-codex.txt', newText: 'hello\n' }]);
  });
});

describe('per-turn token usage (#2161)', () => {
  const breakdown = (input: number, cached: number, output: number) => ({
    totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0,
  });
  const tokenUpdate = (turnId: string, total: ReturnType<typeof breakdown>, last: ReturnType<typeof breakdown>): ServerNotification => ({
    method: 'thread/tokenUsage/updated',
    params: { threadId: fx.THREAD_ID, turnId, tokenUsage: { total, last, modelContextWindow: 272_000 } },
  });
  const completed = fx.completedTurnNotifications.find((n) => n.method === 'turn/completed') as Extract<ServerNotification, { method: 'turn/completed' }>;
  const turnCompleted = (turnId: string): ServerNotification => ({
    method: 'turn/completed', params: { ...completed.params, turn: { ...completed.params.turn, id: turnId } },
  });
  const turnEndedUsage = (events: ChatEventDraft[]) => {
    const ended = events.find((e) => e.type === 'turn_ended');
    return (ended?.data as { usage?: unknown } | undefined)?.usage;
  };

  it("attaches the turn's own tokens to its turn_ended, from the full fixture turn", () => {
    const events = mapAll(new CodexChatEventMapper(), fx.completedTurnNotifications);
    // One update with no earlier total: the turn is that update's `last`.
    expect(turnEndedUsage(events)).toEqual({ input: 250, cachedInput: 100, cacheWrite: 0, output: 50, reasoning: 10, total: 300 });
  });

  it("a later turn gets only what it added to the thread's total, however many updates it had", () => {
    const mapper = new CodexChatEventMapper();
    mapAll(mapper, [
      tokenUpdate('t1', breakdown(1000, 400, 100), breakdown(1000, 400, 100)),
      turnCompleted('t1'),
    ]);
    const second = mapAll(mapper, [
      tokenUpdate('t2', breakdown(2500, 1400, 150), breakdown(1500, 1000, 50)),
      tokenUpdate('t2', breakdown(4200, 2900, 260), breakdown(1700, 1500, 110)),
      tokenUpdate('t2', breakdown(4200, 2900, 260), breakdown(1700, 1500, 110)), // repeated: not counted twice
      turnCompleted('t2'),
    ]);
    expect(turnEndedUsage(second)).toEqual({ input: 3200, cachedInput: 2500, cacheWrite: 0, output: 160, reasoning: 0, total: 3360 });
  });

  it("a subagent thread's update doesn't move the parent's baseline", () => {
    const mapper = new CodexChatEventMapper();
    mapAll(mapper, [
      tokenUpdate('t1', breakdown(50_000, 0, 1000), breakdown(50_000, 0, 1000)),
      turnCompleted('t1'),
      // A subagent thread reports its own, much smaller running total.
      { method: 'thread/tokenUsage/updated', params: { threadId: 'sub-thread', turnId: 's1', tokenUsage: { total: breakdown(2000, 0, 100), last: breakdown(2000, 0, 100), modelContextWindow: 272_000 } } },
    ]);
    const second = mapAll(mapper, [
      tokenUpdate('t2', breakdown(60_000, 0, 1200), breakdown(10_000, 0, 200)),
      turnCompleted('t2'),
    ]);
    expect(turnEndedUsage(second)).toEqual({ input: 10_000, cachedInput: 0, cacheWrite: 0, output: 200, reasoning: 0, total: 10_200 });
  });

  it('a turn with no token updates ends without usage', () => {
    expect(turnEndedUsage(mapAll(new CodexChatEventMapper(), [turnCompleted('t9')]))).toBeUndefined();
  });

  it('still reports the session total and context on each update', () => {
    const [usage] = new CodexChatEventMapper().mapNotification(tokenUpdate('t1', breakdown(1000, 400, 100), breakdown(300, 100, 20)));
    expect(usage).toMatchObject({
      type: 'usage',
      data: { scope: 'session', tokens: { input: 1000, cachedInput: 400, output: 100 }, context: { used: 320, size: 272_000 } },
    });
  });
});
