import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { performance } from 'node:perf_hooks';
import { foldChatEvents, type ChatViewState } from '../../../stores/chatStore';
import { ChatStream } from './ChatStream';
import { ChatFixture, FIXTURE_AGENT_ID, PROFILES } from './fixtures';

const FILE_LINES = 200;

/** A busy Dispatcher-style transcript: each turn is a helper's message, a stack of tool calls, then a reply. */
function busyTranscript(turns: number): ChatViewState {
  const prof = PROFILES.claude;
  const f = new ChatFixture();
  f.start(prof.driver, prof.provider, prof.capabilities);
  const oldText = Array.from({ length: FILE_LINES }, (_, i) => `line ${i}`).join('\n');
  const newText = Array.from({ length: FILE_LINES }, (_, i) => (i % 7 === 0 ? `changed ${i}` : `line ${i}`)).join('\n');
  for (let t = 1; t <= turns; t++) {
    const turn = `turn-${t}`;
    const text = `[FROM:helper-${t % 3}@project] Progress update ${t}.\n${'Details of the update. '.repeat(20)}`;
    f.emit('user_message', { messageId: `u-${t}`, content: [{ type: 'text', text }], source: 'mcp', delivery: 'prompt' }, { turnId: turn });
    f.emit('turn_started', { trigger: 'prompt' }, { turnId: turn });
    for (let c = 0; c < 4; c++) {
      f.tool(turn, { toolCallId: `mcp-${t}-${c}`, kind: 'other', title: 'send_message', status: 'completed', rawInput: { message: `to helper ${c}` }, content: [] });
      f.tool(turn, { toolCallId: `cmd-${t}-${c}`, kind: 'execute', title: 'rg', status: 'completed', content: [{ type: 'terminal', command: `rg needle-${c}`, output: 'match\n'.repeat(30), exitCode: 0 }] });
    }
    f.tool(turn, { toolCallId: `edit-${t}`, kind: 'edit', title: 'Edit', status: 'completed', content: [{ type: 'diff', path: `src/file-${t}.ts`, oldText, newText }] });
    f.say(turn, `m-${t}`, `Finished step ${t}. Everything **passes**.`);
    f.end(turn, { stopReason: 'end_turn', durationMs: 5000 });
  }
  return foldChatEvents(undefined, FIXTURE_AGENT_ID, f.events);
}

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

describe('ChatStream on a busy transcript', () => {
  it('keeps collapsed detail out of the mounted tree', () => {
    const state = busyTranscript(400);
    const mounts: number[] = [];
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      render(<ChatStream state={state} />);
      mounts.push(performance.now() - started);
      if (run < 2) cleanup();
    }
    const elements = screen.getByTestId('chat-stream').querySelectorAll('*').length;
    const blocks = screen.getAllByTestId('chat-stream-block').length;
    const diffs = screen.queryAllByTestId('chat-diff-card').length;
    const turnsShown = screen.getAllByTestId('chat-agent-message').length;
    console.info(`[2664] items=${state.items.length} mountMs=${median(mounts).toFixed(0)} elements=${elements} blocks=${blocks} diffCards=${diffs} turnsShown=${turnsShown}`);
    // Before #2664 this window held 21 turns, 2,333 elements and 21 built diffs.
    expect(diffs).toBe(0);
    expect(screen.queryAllByTestId('chat-command-card')).toHaveLength(0);
    expect(screen.queryAllByTestId('chat-sent-body')).toHaveLength(0);
    expect(elements / turnsShown).toBeLessThan(25);
  }, 120_000);
});
