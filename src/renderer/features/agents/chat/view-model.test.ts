import { describe, it, expect } from 'vitest';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../../shared/chat';
import { foldChatEvents } from '../../../stores/chatStore';
import { chatFixture, ChatFixture, FIXTURE_AGENT_ID, FIXTURE_PROVIDERS, FIXTURE_SCENARIOS, PROFILES } from './fixtures';
import type { AgentMessageItem, ChatItem, ToolCallItem } from '../../../stores/chatStore';
import {
  agentMessagesToName,
  argSummary,
  buildStreamBlocks,
  FAILED_OUTPUT_OPEN_LINES,
  groupCopyText,
  groupLabel,
  isLongFailedOutput,
  isNavigationStop,
  lastOutputLine,
  type StreamBlock,
  commandForRequest,
  commandOutputIds,
  composerModes,
  diffStats,
  diffTexts,
  diffLines,
  exploreLabel,
  formatDuration,
  formatTokens,
  implementLevel,
  looksPreformatted,
  mcpTool,
  needsManualPlanHandoff,
  parseUnifiedDiff,
  shortName,
  slashCommandOf,
  toolArgs,
  toolErrorText,
  toolOpenByDefault,
  toolResultText,
  modelLabel,
} from './view-model';

const fold = (events: ReturnType<typeof chatFixture>) => foldChatEvents(undefined, FIXTURE_AGENT_ID, events);

describe('fixtures', () => {
  it.each(FIXTURE_PROVIDERS.flatMap((p) => FIXTURE_SCENARIOS.map((s) => [p, s] as const)))('%s/%s has strictly increasing seq from 1', (p, s) => {
    const events = chatFixture(p, s);
    expect(events[0].seq).toBe(1);
    for (let i = 1; i < events.length; i++) expect(events[i].seq).toBe(events[i - 1].seq + 1);
    expect(events[0].type).toBe('session_started');
  });
});

describe('buildStreamBlocks', () => {
  it.each(FIXTURE_PROVIDERS)('folds the five reads into one explore block (%s)', (p) => {
    const blocks = buildStreamBlocks(fold(chatFixture(p, 'conversation')));
    const explores = blocks.filter((b) => b.type === 'explore');
    expect(explores).toHaveLength(1);
    expect(explores[0].type === 'explore' && exploreLabel(explores[0].tools, false)).toBe('Explored 3 files, 2 searches');
  });

  it('keeps a single read as an ordinary row', () => {
    const state = fold(chatFixture('claude', 'conversation'));
    const oneRead = { ...state, items: state.items.filter((i) => !(i.kind === 'tool_call' && i.toolCallId !== 'read-1' && i.toolKind !== 'edit' && i.toolKind !== 'execute')) };
    const blocks = buildStreamBlocks(oneRead);
    expect(blocks.some((b) => b.type === 'explore')).toBe(false);
    expect(blocks.some((b) => b.type === 'item' && b.item.kind === 'tool_call' && b.item.toolCallId === 'read-1')).toBe(true);
  });

  it.each(['claude', 'codex'] as const)('nests subagent work under its card when subagents are full (%s)', (p) => {
    const blocks = buildStreamBlocks(fold(chatFixture(p, 'subagents')));
    const sub = blocks.find((b) => b.type === 'subagent');
    expect(sub).toBeDefined();
    if (sub?.type !== 'subagent') return;
    expect(sub.tool?.toolCallId).toBe('task-1');
    expect(sub.children.map((c) => c.kind)).toEqual(['tool_call', 'tool_call', 'agent_message']);
    // Neither the parent tool call nor the subagent's items appear at top level.
    const topIds = blocks.flatMap((b) => (b.type === 'item' ? [b.item.id] : b.type === 'explore' ? b.tools.map((t) => t.id) : []));
    expect(topIds.some((id) => id.includes('sub-'))).toBe(false);
    expect(topIds.some((id) => id.endsWith(':task-1'))).toBe(false);
  });

  it.each(['ids_only', 'none'] as const)('leaves subagent work inline when subagents are %s', (mode) => {
    const fixture = fold(chatFixture('copilot', 'subagents'));
    const state = { ...fixture, capabilities: { ...fixture.capabilities!, subagents: mode } };
    const blocks = buildStreamBlocks(state);
    expect(blocks.some((b) => b.type === 'subagent')).toBe(false);
    expect(blocks.some((b) => b.type === 'item' && b.item.kind === 'tool_call' && b.item.toolCallId === 'task-1')).toBe(true);
    expect(blocks.some((b) => b.type === 'explore' && b.tools.some((t) => t.subagentId === 'sub-1'))).toBe(true);
  });

  it('keeps every item when subagent events arrive but the capability is off', () => {
    const state = fold(chatFixture('claude', 'subagents'));
    const blocks = buildStreamBlocks({ ...state, capabilities: { ...MINIMAL_CHAT_CAPABILITIES } });
    expect(blocks.some((b) => b.type === 'subagent')).toBe(false);
  });
});

describe('diffs', () => {
  it('parses a unified diff with line numbers', () => {
    const lines = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -10,2 +10,2 @@\n keep\n-old\n+new\n');
    expect(lines.map((l) => l.type)).toEqual(['hunk', 'ctx', 'del', 'add']);
    expect(lines[2]).toMatchObject({ oldNo: 11, text: 'old' });
    expect(lines[3]).toMatchObject({ newNo: 11, text: 'new' });
  });

  it('diffs old and new text', () => {
    const lines = diffTexts('a\nb\nc', 'a\nB\nc');
    expect(lines.map((l) => `${l.type}:${l.text}`)).toEqual(['ctx:a', 'del:b', 'add:B', 'ctx:c']);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });

  it('treats a missing old text as a new file', () => {
    expect(diffStats(diffTexts(undefined, 'x\ny'))).toEqual({ added: 2, removed: 0 });
  });

  it("counts a file's final newline as ending its last line, not as another line (#2160)", () => {
    // Codex's added one-line file: the TUI says +1 -0.
    expect(diffStats(diffLines({ type: 'diff', path: 'itest-codex.txt', newText: 'hello\n' }))).toEqual({ added: 1, removed: 0 });
    expect(diffStats(diffLines({ type: 'diff', path: 'gone.txt', oldText: 'a\nb\n' }))).toEqual({ added: 0, removed: 2 });
    expect(diffTexts('a\n', 'a\nb\n').map((l) => `${l.type}:${l.text}`)).toEqual(['ctx:a', 'add:b']);
    // A blank last line before the newline is still a line.
    expect(diffStats(diffTexts(undefined, 'x\n\n'))).toEqual({ added: 2, removed: 0 });
  });

  it('gives the same stats for the unified and old/new shapes of one edit', () => {
    const unified = PROFILES.codex.editContent;
    const texts = PROFILES.claude.editContent;
    if (unified.type !== 'diff' || texts.type !== 'diff') throw new Error('fixture');
    expect(diffStats(parseUnifiedDiff(unified.unifiedDiff!))).toEqual(diffStats(diffTexts(texts.oldText, texts.newText)));
  });
});

describe('composerModes', () => {
  it('sends when idle', () => {
    expect(composerModes(PROFILES.claude.capabilities, false)).toEqual({ primary: 'send', secondary: null, canStop: false });
  });

  it('steers and queues when the driver can steer', () => {
    expect(composerModes(PROFILES.codex.capabilities, true)).toEqual({ primary: 'steer', secondary: 'queue', canStop: true });
  });

  it('offers stop-and-send when the driver can interrupt but not steer', () => {
    expect(composerModes(PROFILES.copilot.capabilities, true)).toEqual({ primary: 'stop_and_send', secondary: 'queue', canStop: true });
  });

  it('only queues when the driver can neither steer nor interrupt', () => {
    expect(composerModes({ ...MINIMAL_CHAT_CAPABILITIES }, true)).toEqual({ primary: 'queue', secondary: null, canStop: false });
  });

  it('drops the queue button when there is no queue', () => {
    expect(composerModes({ ...PROFILES.claude.capabilities, queue: 'none' }, true).secondary).toBeNull();
  });
});

describe('plan hand-off', () => {
  it('is offered when the driver has no plan approval and a plan is ready', () => {
    const state = fold(chatFixture('copilot', 'plan'));
    expect(needsManualPlanHandoff(state)).toBe(true);
    expect(implementLevel(state.capabilities)).toBe('ask');
  });

  it('is not offered when the driver approves plans itself', () => {
    expect(needsManualPlanHandoff(fold(chatFixture('claude', 'plan')))).toBe(false);
  });

  it('is not offered while a turn is running', () => {
    expect(needsManualPlanHandoff(fold(chatFixture('codex', 'plan')))).toBe(false);
  });
});

describe('formatting', () => {
  it('formats durations and tokens', () => {
    expect(formatDuration(6000)).toBe('6s');
    expect(formatDuration(72000)).toBe('1m 12s');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(18200)).toBe('18.2k');
    expect(formatTokens(258000)).toBe('258k');
  });
});

describe('tool card helpers (#2110)', () => {
  const tool = (over: Partial<ToolCallItem>): ToolCallItem => ({
    kind: 'tool_call', id: 't', sessionId: 's', seq: 1, ts: 0, toolCallId: 't', toolKind: 'other', title: 'T', status: 'completed', content: [], ...over,
  });

  it('opens only failed and pending calls by default', () => {
    expect(toolOpenByDefault('failed')).toBe(true);
    expect(toolOpenByDefault('pending')).toBe(true);
    expect(toolOpenByDefault('in_progress')).toBe(false);
    expect(toolOpenByDefault('completed')).toBe(false);
    expect(toolOpenByDefault('cancelled')).toBe(false);
  });

  it('splits an MCP tool name into server and tool', () => {
    expect(mcpTool(tool({ toolName: 'mcp__clubhouse__read_topic' }))).toEqual({ server: 'clubhouse', tool: 'read_topic' });
    // Clubhouse's own tool names contain `__`: the first split keeps them whole.
    expect(mcpTool(tool({ toolName: 'mcp__clubhouse__group__proj_x7q__post_bulletin' }))).toEqual({ server: 'clubhouse', tool: 'group__proj_x7q__post_bulletin' });
    expect(mcpTool(tool({ toolName: 'Bash' }))).toBeNull();
    expect(mcpTool(tool({ toolName: 'mcp__solo' }))).toBeNull();
    expect(mcpTool(tool({}))).toBeNull();
  });

  it('prefers the longest known server name when one contains `__`', () => {
    const servers = [{ name: 'my' }, { name: 'my__server' }];
    expect(mcpTool(tool({ toolName: 'mcp__my__server__do_thing' }), servers)).toEqual({ server: 'my__server', tool: 'do_thing' });
    expect(mcpTool(tool({ toolName: 'mcp__my__other' }), servers)).toEqual({ server: 'my', tool: 'other' });
    expect(mcpTool(tool({ toolName: 'mcp__unknown__x__y' }), servers)).toEqual({ server: 'unknown', tool: 'x__y' });
  });

  it('summarizes with the first non-empty string argument on one line', () => {
    expect(argSummary(tool({ rawInput: { limit: 5, topic: '  theme\nfixes ', body: 'x' } }))).toBe('theme fixes');
    expect(argSummary(tool({ rawInput: { limit: 5 } }))).toBe('');
    expect(argSummary(tool({ rawInput: 'raw' }))).toBe('');
  });

  it('treats empty or non-object input as no arguments', () => {
    expect(toolArgs(tool({ rawInput: {} }))).toBeNull();
    expect(toolArgs(tool({ rawInput: ['a'] }))).toBeNull();
    expect(toolArgs(tool({ rawInput: { a: 1 } }))).toEqual({ a: 1 });
  });

  it('prefers text content for the result and falls back to raw output', () => {
    expect(toolResultText(tool({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }))).toBe('a\nb');
    expect(toolResultText(tool({ rawOutput: 'plain' }))).toBe('plain');
    expect(toolResultText(tool({ rawOutput: { ok: true } }))).toBe('{\n  "ok": true\n}');
    expect(toolResultText(tool({}))).toBe('');
  });
});

describe('slash command output (#2179)', () => {
  // Copilot's /context reply, verbatim from a live session.
  const CONTEXT = [
    'Context Usage',
    '',
    '○ ○ ◌ ● ◉ · · · · ·   gpt-5.6-sol · 17k/400k tokens (4%)',
    '· · · · · · · · · ·   ○ System Prompt           8.9k   (2%)',
    '· · · · · · · · · ·   ◌ System Tools            6.0k   (2%)',
    '◎ ◎ ◎ ◎ ◎ ◎ ◎ ◎ ◎ ◎   ◎ Buffer                141.6k  (35%)',
  ].join('\n');
  const COMMANDS = [{ name: 'context' }, { name: 'mission' }];
  const base = { sessionId: 's', seq: 0, ts: 0 };
  const user = (id: string, text: string) => ({ ...base, id, kind: 'user_message' as const, messageId: id, content: [], text, source: 'user' as const, delivery: 'prompt' as const });
  const reply = (id: string, text: string) => ({ ...base, id, kind: 'agent_message' as const, messageId: id, text, streaming: false });

  it('recognises only commands the session offers, at the start of the message', () => {
    expect(slashCommandOf('/context', COMMANDS)).toBe('context');
    expect(slashCommandOf('  /mission fix it', COMMANDS)).toBe('mission');
    expect(slashCommandOf('/contexts', COMMANDS)).toBeNull();
    expect(slashCommandOf('/usr/bin is missing', COMMANDS)).toBeNull();
    expect(slashCommandOf('run /context', COMMANDS)).toBeNull();
  });

  it('treats column-aligned lines as preformatted, and prose or markdown as not', () => {
    expect(looksPreformatted(CONTEXT)).toBe(true);
    expect(looksPreformatted('One line  with  gaps')).toBe(false);
    expect(looksPreformatted('First paragraph.\n\nSecond paragraph.')).toBe(false);
    expect(looksPreformatted('| a  | b |\n|----|---|\n| 1  | 2 |')).toBe(false);
    expect(looksPreformatted('## Heading\nsome    text\nmore    text')).toBe(false);
    expect(looksPreformatted('```\na    b\nc    d\n```')).toBe(false);
  });

  it('marks a command\'s laid-out reply, not ordinary replies or skill output in markdown', () => {
    const items = [
      user('u1', '/context'), reply('a1', CONTEXT),
      user('u2', 'Same grid again please'), reply('a2', CONTEXT),
      user('u3', '/mission tidy up'), reply('a3', 'Plan:\n\n- one\n- two'),
    ];
    expect([...commandOutputIds(items, COMMANDS)]).toEqual(['a1']);
  });

  it('marks only the first reply after a command: not one after a tool call or a later reply (#2188 review)', () => {
    const toolCall = { ...base, id: 't1', kind: 'tool_call' as const, toolCallId: 't1', toolKind: 'read' as const, title: 'Read', status: 'completed' as const, content: [] };
    const turnEnd = { ...base, id: 'e1', kind: 'turn_end' as const, stopReason: 'end_turn' as const };
    expect([...commandOutputIds([user('u1', '/context'), reply('a1', CONTEXT), reply('a2', CONTEXT)], COMMANDS)]).toEqual(['a1']);
    expect([...commandOutputIds([user('u1', '/mission go'), toolCall, reply('a1', CONTEXT)], COMMANDS)]).toEqual([]);
    expect([...commandOutputIds([user('u1', '/context'), turnEnd, reply('a1', CONTEXT)], COMMANDS)]).toEqual([]);
  });
});

describe('toolErrorText (#2188 review)', () => {
  const failed = (error: string) => ({ sessionId: 's', seq: 0, ts: 0, id: 't', kind: 'tool_call' as const, toolCallId: 't', toolKind: 'other' as const, title: 'T', status: 'failed' as const, content: [], error });

  it('hides an error only when what is shown is the same message', () => {
    expect(toolErrorText(failed('<tool_use_error>Timed out</tool_use_error>'), 'Timed  out\n')).toBeUndefined();
    expect(toolErrorText(failed('Timed out'), '<tool_use_error>Timed out</tool_use_error>')).toBeUndefined();
  });

  it('keeps an error the shown text merely contains', () => {
    expect(toolErrorText(failed('failed'), 'Step 3 failed, retrying\nok')).toBe('failed');
    expect(toolErrorText(failed('Exit code 1'), 'Exit code 1\nnpm ERR! missing script')).toBe('Exit code 1');
  });

  it('ignores an empty error', () => {
    expect(toolErrorText(failed('<tool_use_error> </tool_use_error>'))).toBeUndefined();
  });
});

describe('commandForRequest (#2183 review)', () => {
  const base = { sessionId: 's', seq: 0, ts: 0 };
  const req = (over: Record<string, unknown> = {}) => ({ requestId: 'r', title: 'Run', options: [], ts: 0, ...over });
  const execTool = (over: Record<string, unknown> = {}) => ({ ...base, id: 'tc', kind: 'tool_call' as const, toolCallId: 'tc', toolKind: 'execute' as const, title: 'Run', status: 'pending' as const, content: [], ...over });

  it("reads Claude's Bash input, and an argv array", () => {
    expect(commandForRequest([], req({ toolName: 'Bash', rawInput: { command: 'git status --short' } }))).toBe('git status --short');
    expect(commandForRequest([], req({ rawInput: { command: ['npm', 'test'] } }))).toBe('npm test');
  });

  it('falls back to the execute tool call the request is for', () => {
    expect(commandForRequest([execTool({ content: [{ type: 'terminal', terminalId: 't', command: 'make build', output: '' }] })], req({ toolCallId: 'tc' }))).toBe('make build');
    expect(commandForRequest([execTool({ rawInput: { command: ['ls', '-la'] } })], req({ toolCallId: 'tc' }))).toBe('ls -la');
    expect(commandForRequest([execTool({ toolKind: 'edit', rawInput: { command: 'x' } })], req({ toolCallId: 'tc' }))).toBeUndefined();
  });

  it("leaves it to the request's own content when that already shows it", () => {
    expect(commandForRequest([], req({ rawInput: { command: 'rm -rf build' }, content: [{ type: 'text', text: 'rm -rf build' }] }))).toBeUndefined();
    expect(commandForRequest([], req({ rawInput: { path: '/a' } }))).toBeUndefined();
  });
});

describe('modelLabel', () => {
  // As the Claude SDK lists them (Claude Code 2.1.302).
  const models = [
    { id: 'default', label: 'Default (recommended)' },
    { id: 'opus', label: 'Opus 5.5' },
    { id: 'claude-opus-5', label: 'Opus 5' },
  ];

  it('uses the provider label for a listed id', () => {
    expect(modelLabel('opus', models)).toBe('Opus 5.5');
    expect(modelLabel('claude-opus-5', models)).toBe('Opus 5');
  });

  it('names an alias with the 1M context suffix after the alias', () => {
    expect(modelLabel('opus[1m]', models)).toBe('Opus 5.5 · 1M');
  });

  it('names a full Claude id the way the aliases are named', () => {
    expect(modelLabel('claude-opus-5-5[1m]', models)).toBe('Opus 5.5 · 1M');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1');
  });

  it('shows anything else as-is', () => {
    expect(modelLabel('gpt-6-astra', models)).toBe('gpt-6-astra');
    expect(modelLabel('o4-mini')).toBe('o4-mini');
  });
});

describe('shortName', () => {
  it('keeps a short single line as it is', () => {
    expect(shortName('npm run typecheck')).toBe('npm run typecheck');
    expect(shortName('  git status \n')).toBe('git status');
  });

  it('cuts to the first line, with an ellipsis, when there is more', () => {
    expect(shortName("cat <<'EOF' > notes.md\nline one\nEOF")).toBe("cat <<'EOF' > notes.md…");
  });

  it('caps at 80 characters, the ellipsis included', () => {
    const name = shortName('x'.repeat(500));
    expect(name).toHaveLength(80);
    expect(name.endsWith('…')).toBe(true);
    expect(shortName('y'.repeat(80))).toBe('y'.repeat(80));
    expect(shortName('z'.repeat(81))).toHaveLength(80);
  });

  it('never cuts an emoji or other astral character in half', () => {
    // 78 ASCII characters then emoji: a UTF-16 slice at 79 would land inside the first emoji's surrogate pair.
    const name = shortName(`${'a'.repeat(78)}${'😀'.repeat(5)}`);
    expect(Array.from(name)).toHaveLength(80);
    expect(name).toBe(`${'a'.repeat(78)}😀…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(name)).toBe(false);
    expect(shortName('😀'.repeat(80))).toBe('😀'.repeat(80));
  });
});

describe('agentMessagesToName', () => {
  const base = { sessionId: 's', seq: 1, ts: 1 };
  const agent = (id: string, over: Partial<AgentMessageItem> = {}): ChatItem => ({ ...base, id, kind: 'agent_message', messageId: id, text: 'hi', streaming: false, ...over });
  const user = (id: string): ChatItem => ({ ...base, id, kind: 'user_message', messageId: id, content: [], text: 'x', source: 'user', delivery: 'prompt' });
  const end = (id: string): ChatItem => ({ ...base, id, kind: 'turn_end', stopReason: 'end_turn' });

  it('names the first message of each run', () => {
    expect([...agentMessagesToName([user('u'), agent('a'), agent('b'), end('e'), agent('c'), user('v'), agent('d')])]).toEqual(['a', 'c', 'd']);
  });

  it('skips subagent text and empty messages', () => {
    expect([...agentMessagesToName([agent('s', { subagentId: 'x' }), agent('e', { text: '' }), agent('a')])]).toEqual(['a']);
  });
});

describe('chat reading rules (#2664)', () => {
  const prof = PROFILES.claude;
  const stream = (build: (f: ChatFixture) => void, opts: Parameters<typeof buildStreamBlocks>[1] = {}) => {
    const f = new ChatFixture();
    f.start(prof.driver, prof.provider, prof.capabilities);
    f.prompt('t', 'Go');
    build(f);
    return buildStreamBlocks(foldChatEvents(undefined, FIXTURE_AGENT_ID, f.events), opts).slice(1);
  };
  const edit = (f: ChatFixture, id: string, done: Record<string, unknown> = {}) =>
    f.tool('t', { toolCallId: id, kind: 'edit', title: id, status: 'in_progress', content: [] }, done as never);
  const routed = (f: ChatFixture, id: string, extra: Record<string, unknown> = {}) =>
    f.emit('user_message', { messageId: id, content: [{ type: 'text', text: `from ${id}` }], text: `from ${id}`, source: 'mcp', delivery: 'steer', routed: [{ sender: { name: id }, text: `from ${id}` }], ...extra } as never, { turnId: 't' });
  const types = (blocks: StreamBlock[]) => blocks.map((b) => (b.type === 'item' ? b.item.kind : b.type));

  it('folds adjacent tool calls and messages from others into one row, in order', () => {
    const [group] = stream((f) => { edit(f, 'a'); routed(f, 'helper'); edit(f, 'b'); });
    expect(group.type).toBe('group');
    if (group.type !== 'group') return;
    expect(group.items.map((i) => i.kind)).toEqual(['tool_call', 'user_message', 'tool_call']);
    expect(group.tools).toHaveLength(2);
    expect(group.messages).toHaveLength(1);
  });

  it('leaves a single tool or message as its normal row', () => {
    expect(types(stream((f) => { edit(f, 'a'); f.say('t', 'm', 'Hi'); }))).toEqual(['tool_call', 'agent_message']);
    expect(types(stream((f) => { routed(f, 'helper'); f.say('t', 'm', 'Hi'); }))).toEqual(['user_message', 'agent_message']);
  });

  it('keeps the group key as it grows', () => {
    const one = stream((f) => { edit(f, 'a'); edit(f, 'b'); })[0];
    const two = stream((f) => { edit(f, 'a'); edit(f, 'b'); edit(f, 'c'); })[0];
    expect(one.key).toBe(two.key);
  });

  it('carries a thought inside a group only when a tool follows', () => {
    const between = stream((f) => { edit(f, 'a'); f.think('t', 'th', 'Hmm', 1000); edit(f, 'b'); });
    expect(types(between)).toEqual(['group']);
    if (between[0].type === 'group') expect(between[0].items.map((i) => i.kind)).toEqual(['tool_call', 'thought', 'tool_call']);
    expect(types(stream((f) => { edit(f, 'a'); edit(f, 'b'); f.think('t', 'th', 'Hmm', 1000); }))).toEqual(['group', 'thought']);
  });

  it.each([
    ['an agent message', (f: ChatFixture) => f.say('t', 'm', 'Hi'), 'agent_message'],
    ['the user\'s own message', (f: ChatFixture) => f.prompt('t', 'More', 'steer'), 'user_message'],
    ['a failed tool', (f: ChatFixture) => edit(f, 'x', { status: 'failed', error: 'no' }), 'tool_call'],
    ['a command that exited non-zero', (f: ChatFixture) => f.tool('t', { toolCallId: 'x', kind: 'execute', title: 'x', status: 'in_progress', content: [{ type: 'terminal', command: 'x', output: 'no', exitCode: 1 }] }), 'tool_call'],
    ['a helper question', (f: ChatFixture) => routed(f, 'q', { routed: undefined, text: '[QUESTION FROM HELPER:h (id)] h is waiting for your answer. Answer with answer_helper_question, requestId "r". If the user should decide, call it with escalate: true instead.\nWhich?', content: [{ type: 'text', text: '[QUESTION FROM HELPER:h (id)] h is waiting for your answer. Answer with answer_helper_question, requestId "r". If the user should decide, call it with escalate: true instead.\nWhich?' }] }), 'user_message'],
    ['a notice', (f: ChatFixture) => f.emit('notice', { level: 'info', code: 'c', message: 'FYI' }, { turnId: 't' }), 'notice'],
    ['an error', (f: ChatFixture) => f.emit('error', { code: 'c', message: 'Bad', fatal: false }, { turnId: 't' }), 'error'],
  ])('%s breaks a group and stays in place', (_name, breaker, kind) => {
    const blocks = stream((f) => { edit(f, 'a'); edit(f, 'b'); breaker(f); edit(f, 'c'); edit(f, 'd'); });
    expect(types(blocks)).toEqual(['group', kind, 'group']);
  });

  it('pulls a call with an open permission request out of its group', () => {
    const blocks = stream((f) => { edit(f, 'a'); edit(f, 'b'); edit(f, 'c'); }, { awaitingApproval: new Set(['b']) });
    expect(types(blocks)).toEqual(['tool_call', 'tool_call', 'tool_call']);
    expect(blocks[1].type === 'item' && blocks[1].item.kind === 'tool_call' && blocks[1].item.toolCallId).toBe('b');
  });

  it('keeps a tool with visible images out of a group', () => {
    const f = new ChatFixture();
    f.start(prof.driver, prof.provider, prof.capabilities);
    edit(f, 'a'); edit(f, 'b');
    const state = foldChatEvents(undefined, FIXTURE_AGENT_ID, f.events);
    const items = state.items.map((i) => (i.kind === 'tool_call' && i.toolCallId === 'b' ? { ...i, media: [{ mediaRef: 'r', mimeType: 'image/png' }] } : i)) as typeof state.items;
    expect(types(buildStreamBlocks({ ...state, items }, { mediaVisible: true }))).toEqual(['tool_call', 'tool_call']);
    expect(types(buildStreamBlocks({ ...state, items }))).toEqual(['group']);
  });

  it('counts the agent\'s messages, plans and questions as stops, and nothing else', () => {
    const f = new ChatFixture();
    f.start(prof.driver, prof.provider, prof.capabilities);
    f.prompt('t', 'Go');
    f.say('t', 'marker', 'TASK_RESULT:abc: Done');
    f.emit('agent_message', { messageId: 'empty', text: 'TASK_RESULT:abc:' }, { turnId: 't' });
    f.say('t', 'sub', 'From a subagent', { subagentId: 'unknown' });
    routed(f, 'helper');
    const blocks = buildStreamBlocks(foldChatEvents(undefined, FIXTURE_AGENT_ID, f.events));
    const stops = blocks.filter(isNavigationStop);
    expect(stops).toHaveLength(1);
    expect(stops[0].type === 'item' && stops[0].item.kind === 'agent_message' && stops[0].item.messageId).toBe('marker');
    const plan = { type: 'item', key: 'p', item: { kind: 'plan_document' } } as unknown as StreamBlock;
    const question = { type: 'item', key: 'q', item: { kind: 'question' } } as unknown as StreamBlock;
    expect(isNavigationStop(plan)).toBe(true);
    expect(isNavigationStop(question)).toBe(true);
  });

  it('labels a group with its counts and senders', () => {
    expect(groupLabel(6, 2, ['Orchestrator', 'go-helper'], false)).toBe('Made 6 tool calls, 2 messages from Orchestrator and go-helper');
    expect(groupLabel(1, 0, [], true)).toBe('Making 1 tool call');
    expect(groupLabel(0, 3, ['a', 'b', 'c', 'd'], false)).toBe('3 messages from a, b and 2 others');
  });

  it('copies a group in order, full content included', () => {
    const [group] = stream((f) => {
      f.tool('t', { toolCallId: 'x', kind: 'execute', title: 'x', status: 'in_progress', content: [{ type: 'terminal', command: 'npm test', output: 'all good', exitCode: 0 }] });
      routed(f, 'helper');
    });
    if (group.type !== 'group') throw new Error('expected a group');
    const text = groupCopyText(group.items);
    expect(text).toContain('$ npm test\nall good');
    expect(text.indexOf('npm test')).toBeLessThan(text.indexOf('from helper'));
  });

  it('calls output long past the failed output limit, and finds its last line', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
    expect(isLongFailedOutput(lines(FAILED_OUTPUT_OPEN_LINES))).toBe(false);
    expect(isLongFailedOutput(lines(FAILED_OUTPUT_OPEN_LINES + 1))).toBe(true);
    expect(lastOutputLine('a\nb\n\n')).toBe('b');
  });
});
