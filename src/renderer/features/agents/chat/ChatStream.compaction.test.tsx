import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { foldChatEvents } from '../../../stores/chatStore';
import { COMPACTION_STARTED } from '../../../../shared/chat';
import { ChatStream } from './ChatStream';
import { ChatFixture, FIXTURE_AGENT_ID, PROFILES } from './fixtures';

/** A Codex turn whose tools finished, then a long auto compaction (#2194). */
function compactingTurn(): ChatFixture {
  const prof = PROFILES.codex;
  const f = new ChatFixture();
  f.start(prof.driver, prof.provider, prof.capabilities);
  f.prompt('t1', 'Keep going with the refactor.');
  f.emit('turn_started', { trigger: 'prompt' }, { turnId: 't1' });
  f.tool('t1', { toolCallId: 'cmd-1', kind: 'execute', title: 'npm test', status: 'in_progress' });
  f.emit('notice', { level: 'info', code: COMPACTION_STARTED, message: 'Compacting context…' }, { turnId: 't1' });
  return f;
}

describe('ChatStream: context compaction', () => {
  it('shows a running row while compaction runs', () => {
    const state = foldChatEvents(undefined, FIXTURE_AGENT_ID, compactingTurn().events);
    render(<ChatStream state={state} announce={false} />);
    const row = screen.getByTestId('chat-notice');
    expect(row).toHaveAttribute('data-running', 'true');
    expect(row).toHaveAttribute('role', 'status');
    expect(row).toHaveTextContent('Compacting context…');
  });

  it('settles into the "Context compacted" notice', () => {
    const f = compactingTurn().emit('notice', { level: 'info', code: 'context_compacted', message: 'Context compacted' }, { advanceMs: 85_000 });
    render(<ChatStream state={foldChatEvents(undefined, FIXTURE_AGENT_ID, f.events)} announce={false} />);
    const rows = screen.getAllByTestId('chat-notice');
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveAttribute('data-running');
    expect(rows[0]).toHaveAttribute('data-code', 'context_compacted');
    expect(rows[0]).toHaveTextContent('Context compacted');
  });

  it('removes the row when the turn is cancelled first', () => {
    const f = compactingTurn().end('t1', { stopReason: 'cancelled' });
    render(<ChatStream state={foldChatEvents(undefined, FIXTURE_AGENT_ID, f.events)} announce={false} />);
    expect(screen.queryByTestId('chat-notice')).toBeNull();
  });
});
