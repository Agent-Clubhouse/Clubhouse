import { describe, it, expect, beforeEach } from 'vitest';
import { CodexChatEventMapper, codexErrorCode, toCodexInput } from './codex-chat-events';
import { isChatEvent, CHAT_CONTRACT_VERSION, type ChatEventDraft } from '../../../shared/chat/events';
import type { ServerNotification } from './codex-protocol';
import * as fx from './codex-protocol/__fixtures__/app-server-session';

const at = { threadId: fx.THREAD_ID, turnId: fx.TURN_ID };

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

  it('carries turn ids and message ids', () => {
    const events = mapAll(mapper, fx.completedTurnNotifications);
    const chunks = events.filter((e) => e.type === 'agent_message_chunk');
    expect(chunks.map((e) => e.data)).toEqual([
      { messageId: 'item-agent-1', text: 'Running ' },
      { messageId: 'item-agent-1', text: 'the tests.' },
    ]);
    expect(chunks.every((e) => e.turnId === fx.TURN_ID)).toBe(true);
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
      code: 'responseStreamDisconnected',
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
      turnId: fx.SECOND_TURN_ID,
      data: { code: 'usageLimitExceeded', message: 'usage limit reached', fatal: false },
    });
  });

  it('a context-window failure ends the turn as max_tokens', () => {
    const turn = { ...fx.failedTurnCompleted.params.turn, error: { ...fx.failedTurnCompleted.params.turn.error!, codexErrorInfo: 'contextWindowExceeded' as const } };
    const events = mapper.mapNotification({ method: 'turn/completed', params: { threadId: fx.THREAD_ID, turn } });
    expect(events[1]).toMatchObject({ type: 'turn_ended', data: { stopReason: 'max_tokens' } });
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
        turnId: fx.TURN_ID,
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

    it('returns null for server requests the contract cannot express', () => {
      expect(mapper.mapServerRequest({
        method: 'item/tool/requestUserInput',
        id: 5,
        params: { ...at, itemId: 'q', questions: [], isBlocking: true, autoResolutionMs: null },
      })).toBeNull();
    });
  });

  it('maps unrecognized messages to protocol_unknown', () => {
    expect(mapper.mapUnrecognized({ kind: 'notification', method: 'thread/new', params: {} })).toEqual([
      { type: 'protocol_unknown', data: { driver: 'codex_app_server', kind: 'notification', name: 'thread/new' } },
    ]);
    expect(mapper.mapUnrecognized({ kind: 'request', id: 1, method: 'x/y', params: {} })[0].data).toMatchObject({ kind: 'request', name: 'x/y' });
    expect(mapper.mapUnrecognized({ kind: 'other', message: {} })[0].data).toMatchObject({ kind: 'event' });
  });
});

describe('codex chat helpers', () => {
  it('codexErrorCode handles string, object and null infos', () => {
    expect(codexErrorCode('unauthorized')).toBe('unauthorized');
    expect(codexErrorCode({ httpConnectionFailed: { httpStatusCode: 502 } })).toBe('httpConnectionFailed');
    expect(codexErrorCode(null)).toBe('codex_error');
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
