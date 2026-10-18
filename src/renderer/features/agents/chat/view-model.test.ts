import { describe, it, expect } from 'vitest';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../../shared/chat';
import { foldChatEvents } from '../../../stores/chatStore';
import { chatFixture, FIXTURE_AGENT_ID, FIXTURE_PROVIDERS, FIXTURE_SCENARIOS, PROFILES } from './fixtures';
import type { ToolCallItem } from '../../../stores/chatStore';
import {
  argSummary,
  buildStreamBlocks,
  composerModes,
  diffStats,
  diffTexts,
  diffLines,
  exploreLabel,
  formatDuration,
  formatTokens,
  implementLevel,
  mcpTool,
  needsManualPlanHandoff,
  parseUnifiedDiff,
  toolArgs,
  toolOpenByDefault,
  toolResultText,
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
