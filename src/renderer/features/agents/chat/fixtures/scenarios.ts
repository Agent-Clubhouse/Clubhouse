/**
 * Fixture event streams for ChatView: the mockup scenarios (conversation,
 * approval, plan, steer and queue, subagents) plus failure states, for each
 * provider. Each scenario returns the full stamped stream, so a test can fold
 * a prefix of it to check intermediate (streaming) states.
 */

import type { ChatEvent } from '../../../../../shared/chat';
import { ChatFixture } from './builder';
import { PROFILES, type FixtureProvider } from './providers';

export type FixtureScenario =
  | 'conversation'
  | 'approval'
  | 'plan'
  | 'steer'
  | 'subagents'
  | 'agent_map'
  | 'turn_error'
  | 'protocol_drift';

export const FIXTURE_SCENARIOS: readonly FixtureScenario[] = [
  'conversation', 'approval', 'plan', 'steer', 'subagents', 'agent_map', 'turn_error', 'protocol_drift',
];

function begin(p: FixtureProvider, agentId?: string): ChatFixture {
  const prof = PROFILES[p];
  const f = new ChatFixture(agentId);
  f.start(prof.driver, prof.provider, prof.capabilities, { model: prof.model, cliVersion: prof.cliVersion });
  if (prof.effort) f.emit('model_changed', { modelId: prof.model, effort: prof.effort });
  return f;
}

/** Five read-only calls the stream folds into one "Explored" row. */
function explore(f: ChatFixture, turnId: string): void {
  const reads: Array<[string, string, 'read' | 'search', string]> = [
    ['read-1', 'Read src/renderer/features/agents/AgentListItem.tsx', 'read', 'src/renderer/features/agents/AgentListItem.tsx'],
    ['search-1', 'Search "py-3.5" in src/renderer', 'search', 'src/renderer'],
    ['read-2', 'Read src/renderer/features/agents/AgentAvatar.tsx', 'read', 'src/renderer/features/agents/AgentAvatar.tsx'],
    ['read-3', 'Read src/renderer/stores/panelStore.ts', 'read', 'src/renderer/stores/panelStore.ts'],
    ['search-2', 'Search "AgentChip" in src', 'search', 'src'],
  ];
  for (const [id, title, kind, path] of reads) {
    f.tool(turnId, { toolCallId: id, kind, title, status: 'in_progress', locations: [{ path }] }, { status: 'completed' }, { advanceMs: 150 });
  }
}

function usage(f: ChatFixture, p: FixtureProvider, turnId: string): void {
  const prof = PROFILES[p];
  if (p === 'claude') {
    f.emit('usage', { scope: 'turn', tokens: { input: 18200, output: 2100 }, costUsd: 0.31, costIsEstimate: true, context: { used: 82000, size: 200000 }, limits: prof.limits }, { turnId });
  } else if (p === 'codex') {
    f.emit('usage', { scope: 'turn', tokens: { input: 24600, cachedInput: 19100, output: 1800 }, context: { used: 98000, size: 258000 }, limits: prof.limits }, { turnId });
  } else {
    f.emit('usage', { scope: 'session', context: { used: 46000, size: 128000 } }, { turnId });
  }
}

function conversation(p: FixtureProvider, agentId?: string): ChatEvent[] {
  const prof = PROFILES[p];
  const f = begin(p, agentId);
  const t = 'turn-1';
  f.prompt(t, 'The agent list rows are too tall. Make each one a single 30px line and move the chips into a hover card.');
  f.think(t, 'th-1', 'The row stacks name, chips and status vertically. I should look at AgentListItem first.', 6000);
  explore(f, t);
  f.say(t, 'm-1', "The row stacks name, chips and status into three lines. I'll collapse it to one line with a status dot, and move the chips into a new hover card.");
  f.tool(t, {
    toolCallId: 'edit-1', kind: 'edit', title: 'Edit AgentListItem.tsx', status: 'in_progress', toolName: p === 'codex' ? 'fileChange' : 'Edit',
    locations: [{ path: 'src/renderer/features/agents/AgentListItem.tsx', line: 88 }],
    content: [prof.editContent],
  });
  f.tool(t, {
    toolCallId: 'edit-2', kind: 'edit', title: 'Create AgentHoverCard.tsx', status: 'in_progress', toolName: p === 'codex' ? 'fileChange' : 'Write',
    locations: [{ path: 'src/renderer/features/agents/AgentHoverCard.tsx' }],
    content: [{ type: 'diff', path: 'src/renderer/features/agents/AgentHoverCard.tsx', newText: 'export function AgentHoverCard() {\n  return null;\n}\n' }],
  });
  f.emit('tool_call', { toolCallId: 'cmd-1', kind: 'execute', title: 'npm run typecheck', status: 'in_progress', toolName: p === 'codex' ? 'commandExecution' : 'Bash', rawInput: { command: 'npm run typecheck' } }, { turnId: t });
  f.emit('tool_call_update', { toolCallId: 'cmd-1', contentMode: 'append', content: [{ type: 'terminal', command: 'npm run typecheck', output: '> tsc --noEmit -p tsconfig.json\n' }] }, { turnId: t, advanceMs: 6000 });
  f.emit('tool_call_update', { toolCallId: 'cmd-1', status: 'completed', durationMs: 14000, content: [{ type: 'terminal', command: 'npm run typecheck', output: '> tsc --noEmit -p tsconfig.json\n0 errors\n', exitCode: 0 }] }, { turnId: t, advanceMs: 8000 });
  f.say(t, 'm-2', 'Rows are now 30px. Chips live in `AgentHoverCard` and open after 300ms. Typecheck passes.\n\nWant me to move the orchestrator chip into the avatar badge too?');
  usage(f, p, t);
  f.end(t, { stopReason: 'end_turn', durationMs: 72000, usage: p === 'copilot' ? { input: 26100, output: 900 } : undefined, ...(p === 'claude' && { costUsd: 0.31 }) });
  return f.events;
}

function approval(p: FixtureProvider, agentId?: string): ChatEvent[] {
  const prof = PROFILES[p];
  const f = begin(p, agentId);
  const t = 'turn-1';
  f.prompt(t, 'Swap our hand-rolled validators for zod and update the tests.');
  f.think(t, 'th-1', 'zod is not installed yet.', 4000);
  explore(f, t);
  f.say(t, 'm-1', "zod isn't a dependency yet. I'll add it, then replace the validators in `src/shared/validate.ts`.");
  f.emit('tool_call', { toolCallId: 'cmd-install', kind: 'execute', title: 'npm install zod@4 --save', status: 'pending', toolName: p === 'codex' ? 'commandExecution' : 'Bash', rawInput: { command: 'npm install zod@4 --save' } }, { turnId: t });
  f.emit('permission_request', {
    requestId: 'perm-1',
    title: prof.installTitle,
    ...(prof.installDescription && { description: prof.installDescription }),
    toolCallId: 'cmd-install',
    toolName: p === 'codex' ? 'commandExecution' : 'Bash',
    rawInput: { command: 'npm install zod@4 --save' },
    options: prof.installOptions,
  }, { turnId: t });
  f.emit('session_state', { state: 'waiting_permission' });
  return f.events;
}

function plan(p: FixtureProvider, agentId?: string): ChatEvent[] {
  const f = begin(p, agentId);
  const t = 'turn-1';
  f.emit('mode_changed', { level: 'plan', nativeMode: p === 'claude' ? 'plan' : p === 'codex' ? 'collaborationMode: plan' : '#plan' });
  f.prompt(t, "Plan how to make agent rows 30px. Don't change code yet.");
  explore(f, t);
  const markdown = [
    '1. **Row layout.** One flex line in `AgentListItem`: dot, xs avatar, name, orchestrator badge, right-aligned meta.',
    '2. **Hover card.** New `AgentHoverCard` for chips, model and Free Agent Mode, opening after 300ms.',
    '3. **Avatar.** Add `xs` (18px) to `AgentAvatar` with a corner badge for the orchestrator.',
    '4. **Verify.** Update 6 snapshot tests, then run typecheck and unit tests.',
  ].join('\n');
  if (p === 'claude') {
    f.emit('tool_call', { toolCallId: 'exit-plan', kind: 'switch_mode', title: 'Ready to code?', status: 'pending', toolName: 'ExitPlanMode', rawInput: { plan: markdown } }, { turnId: t });
    f.emit('plan_document', { planId: 'plan-1', markdown, status: 'ready', toolCallId: 'exit-plan' }, { turnId: t });
    f.emit('permission_request', {
      requestId: 'perm-plan',
      title: 'Plan ready for review',
      toolCallId: 'exit-plan',
      toolName: 'ExitPlanMode',
      rawInput: { plan: markdown },
      options: [
        // ClaudeChatDriver's options; the CLI's setMode suggestion becomes the "always" scope.
        { optionId: 'allow', kind: 'allow_once', label: 'Allow' },
        { optionId: 'allow_always', kind: 'allow_always', label: "Allow and don't ask again", scope: 'acceptEdits mode' },
        { optionId: 'deny', kind: 'reject_once', label: 'Deny' },
      ],
    }, { turnId: t });
    f.emit('session_state', { state: 'waiting_permission' });
  } else if (p === 'codex') {
    f.emit('plan_document', { planId: 'plan-1', markdown: markdown.split('\n').slice(0, 2).join('\n'), status: 'streaming' }, { turnId: t });
    f.emit('plan_document', { planId: 'plan-1', markdown, status: 'streaming' }, { turnId: t });
    f.emit('question', {
      requestId: 'q-1',
      questions: [{
        id: 'tooltips',
        prompt: 'Should the hover card replace the existing chip tooltips, or sit alongside them?',
        options: [{ id: 'replace', label: 'Replace the tooltips' }, { id: 'both', label: 'Keep both' }],
        allowFreeText: true,
      }],
    }, { turnId: t });
    f.emit('session_state', { state: 'waiting_input' });
  } else {
    f.emit('plan', { entries: [
      { content: 'Row layout: one flex line in AgentListItem', status: 'pending' },
      { content: 'Hover card for chips', status: 'pending' },
      { content: 'Add xs avatar size', status: 'pending' },
      { content: 'Run typecheck and unit tests', status: 'pending' },
    ] }, { turnId: t });
    f.say(t, 'm-1', 'Here is the plan. Switch to Agent mode when you want me to implement it.');
    f.end(t, { stopReason: 'end_turn', durationMs: 31000 });
  }
  return f.events;
}

function steer(p: FixtureProvider, agentId?: string): ChatEvent[] {
  const f = begin(p, agentId);
  const t = 'turn-1';
  f.prompt(t, 'Run the full unit suite and fix whatever breaks from the row change.');
  f.emit('plan', { entries: [
    { content: 'Collapse row to one 30px line', status: 'completed' },
    { content: 'Move chips into a hover card', status: 'completed' },
    { content: 'Add xs avatar size', status: 'completed' },
    { content: 'Run typecheck and unit tests', status: 'in_progress' },
  ] }, { turnId: t });
  f.emit('tool_call', { toolCallId: 'cmd-test', kind: 'execute', title: 'npm test -- --run src/renderer/features/agents', status: 'in_progress', toolName: p === 'codex' ? 'commandExecution' : 'Bash' }, { turnId: t });
  f.emit('tool_call_update', { toolCallId: 'cmd-test', contentMode: 'append', content: [{ type: 'terminal', output: '✓ AgentAvatar.test.tsx (12)\n✓ AgentHoverCard.test.tsx (5)\n' }] }, { turnId: t, advanceMs: 3000 });
  f.emit('tool_call_update', { toolCallId: 'cmd-test', contentMode: 'append', content: [{ type: 'terminal', output: '✗ AgentListItem.test.tsx (2 failed)\n  → expected chip "opus" to be visible\n' }] }, { turnId: t, advanceMs: 2000 });
  f.emit('user_message', { messageId: 'q-1', content: [{ type: 'text', text: 'Then open a draft PR titled "Compact agent rows".' }], source: 'user', delivery: 'queued' }, { turnId: t });
  f.emit('user_message', { messageId: 'q-2', content: [{ type: 'text', text: 'Also add a Storybook story for the hover card.' }], source: 'mcp', delivery: 'queued' }, { turnId: t });
  return f.events;
}

function subagents(p: FixtureProvider, agentId?: string): ChatEvent[] {
  const f = begin(p, agentId);
  const t = 'turn-1';
  f.prompt(t, 'Audit every place that renders agent chips and make them consistent.');
  const sub = p === 'claude' ? 'Explore' : 'worker-1';
  f.emit('tool_call', { toolCallId: 'task-1', kind: 'other', title: 'Find every consumer of AgentChips', status: 'in_progress', toolName: p === 'codex' ? 'collabAgentToolCall' : 'Task' }, { turnId: t });
  if (p !== 'copilot') {
    f.emit('subagent', { subagentId: 'sub-1', name: sub, description: 'Find every consumer of AgentChips', status: 'running', parentToolCallId: 'task-1' }, { turnId: t });
  }
  f.tool(t, { toolCallId: 'sub-read-1', kind: 'read', title: 'Read src/renderer/features/agents/AgentListItem.tsx', status: 'in_progress', subagentId: 'sub-1' });
  f.tool(t, { toolCallId: 'sub-search-1', kind: 'search', title: 'Search "AgentChips" in src', status: 'in_progress', subagentId: 'sub-1' });
  f.say(t, 'sub-m-1', 'Found 3 consumers: AgentListItem, AgentHoverCard (new), DurableAgentRow. Only AgentListItem renders chips inline.', { subagentId: 'sub-1' });
  if (p !== 'copilot') {
    f.emit('subagent', { subagentId: 'sub-1', name: sub, status: 'completed', parentToolCallId: 'task-1', toolCount: 12, usage: { total: 9800 } }, { turnId: t, advanceMs: 41000 });
  }
  f.emit('tool_call_update', { toolCallId: 'task-1', status: 'completed', durationMs: 41000 }, { turnId: t });
  f.say(t, 'm-1', 'Waiting on the reviewer before I change the styles.');
  return f.events;
}

/** Two subagents in one turn, as in the mockup's agent map: one finished, one still working. */
function agentMap(p: FixtureProvider, agentId?: string): ChatEvent[] {
  const f = begin(p, agentId);
  const t = 'turn-1';
  const names = p === 'claude' ? ['Explore', 'code-reviewer'] : ['worker-1', 'worker-2'];
  const task = p === 'codex' ? 'collabAgentToolCall' : 'Task';
  f.prompt(t, 'Audit every place that renders agent chips and make them consistent.');
  f.emit('tool_call', { toolCallId: 'task-1', kind: 'other', title: 'Find every consumer of AgentChips', status: 'in_progress', toolName: task }, { turnId: t });
  f.emit('subagent', { subagentId: 'sub-1', name: names[0], description: 'Find every consumer of AgentChips', status: 'running', parentToolCallId: 'task-1' }, { turnId: t });
  f.tool(t, { toolCallId: 'sub1-read', kind: 'read', title: 'Read src/renderer/features/agents/AgentListItem.tsx', status: 'in_progress', subagentId: 'sub-1' });
  f.tool(t, { toolCallId: 'sub1-search', kind: 'search', title: 'Search "AgentChips" in src', status: 'in_progress', subagentId: 'sub-1' });
  f.say(t, 'sub1-m', 'Found 3 consumers: AgentListItem, AgentHoverCard (new), DurableAgentRow.', { subagentId: 'sub-1' });
  f.emit('subagent', { subagentId: 'sub-1', name: names[0], status: 'completed', parentToolCallId: 'task-1', toolCount: 12, usage: { total: 9800 } }, { turnId: t, advanceMs: 41000 });
  f.emit('tool_call_update', { toolCallId: 'task-1', status: 'completed', durationMs: 41000 }, { turnId: t });

  f.emit('tool_call', { toolCallId: 'task-2', kind: 'other', title: 'Review the chip styles for contrast', status: 'in_progress', toolName: task }, { turnId: t });
  f.emit('subagent', { subagentId: 'sub-2', name: names[1], description: 'Review the chip styles for contrast', status: 'running', parentToolCallId: 'task-2' }, { turnId: t });
  f.tool(t, { toolCallId: 'sub2-read', kind: 'read', title: 'Read ChipStyles.ts', status: 'in_progress', subagentId: 'sub-2' });
  f.emit('tool_call', { toolCallId: 'sub2-cmd', kind: 'execute', title: 'npx contrast-check', status: 'in_progress', toolName: 'Bash', subagentId: 'sub-2' }, { turnId: t });
  f.say(t, 'm-1', 'Waiting on the reviewer before I change the styles.');
  return f.events;
}

function turnError(p: FixtureProvider, agentId?: string): ChatEvent[] {
  const f = begin(p, agentId);
  const t = 'turn-1';
  f.prompt(t, 'Summarize the open issues labelled chat.');
  f.say(t, 'm-1', 'Let me look at the issue list', { final: false });
  f.emit('error', { code: 'rate_limited', message: 'Usage limit reached for the 5-hour window. Try again after 8:00 PM.', fatal: false }, { turnId: t });
  f.end(t, { stopReason: 'error', durationMs: 4000 });
  return f.events;
}

function protocolDrift(p: FixtureProvider, agentId?: string): ChatEvent[] {
  const prof = PROFILES[p];
  const f = begin(p, agentId);
  const t = 'turn-1';
  f.prompt(t, 'Hello');
  f.emit('protocol_unknown', { driver: prof.driver, kind: 'notification', name: p === 'codex' ? 'item/reasoning/summaryPartAdded' : p === 'claude' ? 'system/compact_boundary' : 'session/update:agent_status' }, { turnId: t });
  f.emit('protocol_unknown', { driver: prof.driver, kind: 'field', name: 'usage.premiumRequests' }, { turnId: t });
  f.say(t, 'm-1', 'Hi! What would you like to work on?');
  f.end(t, { stopReason: 'end_turn', durationMs: 2000 });
  f.emit('error', { code: 'process_exited', message: 'The CLI exited unexpectedly (code 1).', fatal: true });
  f.emit('session_ended', { reason: 'error', exitCode: 1, message: 'The CLI exited unexpectedly (code 1).' });
  return f.events;
}

const BUILDERS: Record<FixtureScenario, (p: FixtureProvider, agentId?: string) => ChatEvent[]> = {
  conversation,
  approval,
  plan,
  steer,
  subagents,
  agent_map: agentMap,
  turn_error: turnError,
  protocol_drift: protocolDrift,
};

export function chatFixture(provider: FixtureProvider, scenario: FixtureScenario, agentId?: string): ChatEvent[] {
  return BUILDERS[scenario](provider, agentId);
}
