import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ChatEvent } from '../../../shared/chat';
import { foldChatEvents, useChatStore } from '../../stores/chatStore';
import { DispatcherWorkRow } from '../../chrome/sidebar/DispatcherRow';
import { DispatcherWorkView } from './DispatcherWorkView';
import { activeRunFailing, activeRunSince } from './work-conversation';

const capabilities = { usage: 'none' };
let seq = 0;
function ev(sessionId: string, ts: number, type: string, data: unknown, turnId?: string): ChatEvent {
  return { agentId: 'work', sessionId, seq: ++seq, ts, type, data, ...(turnId && { turnId }) } as unknown as ChatEvent;
}
const started = (sessionId: string, ts: number, resumed: boolean, nativeSessionId: string) =>
  ev(sessionId, ts, 'session_started', { driver: 'claude_agent_sdk', provider: 'claude-code', cwd: 'work', resumed, nativeSessionId, capabilities });

/** An earlier run that failed and ended, then a resumed run that is active and healthy. */
function resumedAfterFailure(): ChatEvent[] {
  return [
    started('s1', 1_000, false, 'old-native'),
    ev('s1', 1_050, 'turn_started', { trigger: 'immediate' }, 't1'),
    ev('s1', 1_100, 'error', { code: 'protocol_error', message: 'Request failed', fatal: false }, 't1'),
    ev('s1', 1_200, 'turn_ended', { stopReason: 'error' }, 't1'),
    ev('s1', 1_300, 'session_ended', { reason: 'idle_timeout' }),
    started('s1', 2_000, true, 'old-native'),
    ev('s1', 2_050, 'turn_started', { trigger: 'immediate' }, 't2'),
    ev('s1', 2_100, 'agent_message', { messageId: 'a1', text: 'Checked the agents.' }, 't2'),
    ev('s1', 2_200, 'turn_ended', { stopReason: 'end_turn' }, 't2'),
  ];
}

function seed(events: ChatEvent[]): void {
  useChatStore.setState({ agents: { work: foldChatEvents(undefined, 'work', events) }, loading: {}, partial: {}, loaded: { work: true } });
}

beforeEach(() => {
  seq = 0;
  useChatStore.setState({ agents: {}, loading: {}, partial: {}, loaded: {} });
});

describe('Dispatcher work view boundaries (#3242)', () => {
  it('marks each run active or ended, and an ended run\'s error as history with its time', () => {
    seed(resumedAfterFailure());
    render(<DispatcherWorkView agentId="work" />);
    const boundaries = screen.getAllByTestId('chat-run-boundary');
    expect(boundaries.map((b) => b.getAttribute('data-active'))).toEqual(['false', 'true']);
    expect(boundaries[0].textContent).toMatch(/^Started .*, ended /);
    expect(boundaries[1].textContent).toMatch(/^Resumed .*, active$/);
    const error = screen.getByTestId('chat-error');
    expect(error.getAttribute('data-earlier')).toBe('true');
    expect(error.getAttribute('role')).toBeNull();
    expect(screen.getByTestId('chat-error-time').textContent).toContain('From a run that has ended.');
    const conversation = screen.getByTestId('dispatcher-work-conversation');
    expect(conversation.getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('dispatcher-work-native-id').textContent).toBe('old-native');
    expect(conversation.textContent).toMatch(/started .*, active\.$/);
  });

  it('shows a current error as current', () => {
    seed([
      started('s1', 1_000, false, 'n1'),
      ev('s1', 1_050, 'turn_started', { trigger: 'immediate' }, 't1'),
      ev('s1', 1_100, 'error', { code: 'protocol_error', message: 'Request failed', fatal: false }, 't1'),
      ev('s1', 1_200, 'turn_ended', { stopReason: 'error' }, 't1'),
    ]);
    render(<DispatcherWorkView agentId="work" />);
    const error = screen.getByTestId('chat-error');
    expect(error.getAttribute('data-earlier')).toBe('false');
    expect(error.getAttribute('role')).toBe('alert');
  });

  it('calls the conversation ended once it sleeps', () => {
    seed([...resumedAfterFailure(), ev('s1', 3_000, 'session_ended', { reason: 'idle_timeout' })]);
    render(<DispatcherWorkView agentId="work" />);
    expect(screen.getByTestId('dispatcher-work-conversation').getAttribute('data-active')).toBe('false');
    expect(screen.getAllByTestId('chat-run-boundary').every((b) => b.getAttribute('data-active') === 'false')).toBe(true);
  });

  it('after a fresh start, shows the new conversation, its id and a started fresh event, without the old errors', () => {
    seed([
      ...resumedAfterFailure(),
      started('s2', 5_000, false, 'new-native'),
      ev('s2', 5_001, 'notice', { level: 'warn', code: 'started_fresh', message: 'Started fresh. The previous work conversation failed every turn, so Clubhouse stopped resuming it.' }),
    ]);
    render(<DispatcherWorkView agentId="work" />);
    expect(screen.getByTestId('dispatcher-work-native-id').textContent).toBe('new-native');
    expect(screen.getByTestId('dispatcher-work-started-fresh').textContent).toMatch(/^Started fresh /);
    expect(screen.getByText(/failed every turn, so Clubhouse stopped resuming it/)).toBeTruthy();
    expect(screen.queryByTestId('chat-error')).toBeNull();
  });
});

describe('Dispatcher work health (#3242)', () => {
  it('comes from the active run only', () => {
    const recovered = foldChatEvents(undefined, 'work', resumedAfterFailure());
    expect(activeRunSince(recovered)).toBe(2_000);
    expect(activeRunFailing(recovered)).toBe(false);

    seq = 0;
    const failingNow = foldChatEvents(undefined, 'work', [
      ...resumedAfterFailure(),
      ev('s1', 2_300, 'turn_started', { trigger: 'immediate' }, 't3'),
      ev('s1', 2_400, 'turn_ended', { stopReason: 'error' }, 't3'),
    ]);
    expect(activeRunFailing(failingNow)).toBe(true);

    seq = 0;
    const endedAfterFailing = foldChatEvents(undefined, 'work', [
      started('s1', 1_000, false, 'n1'),
      ev('s1', 1_200, 'turn_ended', { stopReason: 'error' }, 't1'),
      ev('s1', 1_300, 'session_ended', { reason: 'idle_timeout' }),
    ]);
    expect(activeRunSince(endedAfterFailing)).toBeNull();
    expect(activeRunFailing(endedAfterFailing)).toBe(false);
  });

  it('the work row shows an error only while the active run is failing', () => {
    seed(resumedAfterFailure());
    const { rerender } = render(<DispatcherWorkRow agentId="work" running active={false} onSelect={() => {}} />);
    expect(screen.getByRole('img').getAttribute('data-dot')).toBe('idle');
    seq = 100;
    seed([
      ...resumedAfterFailure(),
      ev('s1', 2_300, 'turn_started', { trigger: 'immediate' }, 't3'),
      ev('s1', 2_400, 'turn_ended', { stopReason: 'error' }, 't3'),
    ]);
    rerender(<DispatcherWorkRow agentId="work" running active={false} onSelect={() => {}} />);
    expect(screen.getByRole('img').getAttribute('data-dot')).toBe('error');
  });
});
