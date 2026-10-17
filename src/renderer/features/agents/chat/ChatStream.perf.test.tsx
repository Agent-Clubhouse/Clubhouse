/**
 * Long-stream check (docs/structured-chat-research.md §8, "Long streams"):
 * render about 500 blocks, then stream into the last message and confirm only
 * that block re-renders. Timings are printed for the record, and the bound is
 * loose so a slow CI machine doesn't flake it.
 */
import { describe, it, expect } from 'vitest';
import { Profiler, type ProfilerOnRenderCallback } from 'react';
import { act, render, screen } from '@testing-library/react';
import { foldChatEvents, reduceChatEvent, type ChatViewState } from '../../../stores/chatStore';
import { ChatStream } from './ChatStream';
import { ChatFixture, FIXTURE_AGENT_ID, PROFILES } from './fixtures';

function longStream(turns: number): { state: ChatViewState; fixture: ChatFixture } {
  const prof = PROFILES.claude;
  const f = new ChatFixture();
  f.start(prof.driver, prof.provider, prof.capabilities);
  for (let t = 1; t <= turns; t++) {
    const turn = `turn-${t}`;
    f.prompt(turn, `Step ${t}: tidy the next component.`);
    f.tool(turn, { toolCallId: `edit-${t}`, kind: 'edit', title: 'Edit', status: 'in_progress', content: [prof.editContent] });
    f.tool(turn, { toolCallId: `cmd-${t}`, kind: 'execute', title: 'npm test', status: 'in_progress', content: [{ type: 'terminal', command: 'npm test', output: 'ok\n', exitCode: 0 }] });
    f.say(turn, `m-${t}`, `Done with step ${t}. Everything **passes** and \`npm test\` is green.`);
    f.end(turn, { stopReason: 'end_turn', durationMs: 5000 });
  }
  return { state: foldChatEvents(undefined, FIXTURE_AGENT_ID, f.events), fixture: f };
}

describe('ChatStream with a long transcript', () => {
  it('renders ~500 blocks and re-renders only the streaming message on a chunk', () => {
    const { state, fixture } = longStream(100);
    let commits: Array<{ phase: string; duration: number }> = [];
    const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => { commits.push({ phase, duration: actualDuration }); };

    const t0 = performance.now();
    const { rerender } = render(<Profiler id="stream" onRender={onRender}><ChatStream state={state} /></Profiler>);
    const mountMs = performance.now() - t0;
    const mount = commits.reduce((n, c) => n + c.duration, 0);
    expect(screen.getAllByTestId('chat-agent-message')).toHaveLength(100);
    expect(screen.getAllByTestId('chat-diff-card')).toHaveLength(100);

    // Open a new turn and stream into it.
    fixture.prompt('turn-x', 'One more thing');
    fixture.emit('agent_message_chunk', { messageId: 'm-x', text: 'Working on' }, { turnId: 'turn-x' });
    let next = state;
    for (const e of fixture.events.slice(-5)) next = reduceChatEvent(next, e);
    act(() => { rerender(<Profiler id="stream" onRender={onRender}><ChatStream state={next} /></Profiler>); });

    commits = [];
    fixture.emit('agent_message_chunk', { messageId: 'm-x', text: ' it now' }, { turnId: 'turn-x' });
    const chunked = reduceChatEvent(next, fixture.events[fixture.events.length - 1]);
    const t1 = performance.now();
    act(() => { rerender(<Profiler id="stream" onRender={onRender}><ChatStream state={chunked} /></Profiler>); });
    const chunkMs = performance.now() - t1;
    const chunk = commits.reduce((n, c) => n + c.duration, 0);

    process.stdout.write(`[chat perf] ${state.items.length} items: mount ${mountMs.toFixed(1)}ms (react ${mount.toFixed(1)}ms), one chunk ${chunkMs.toFixed(1)}ms (react ${chunk.toFixed(1)}ms)\n`);
    expect(chunk).toBeLessThan(mount / 2);
  });
});
