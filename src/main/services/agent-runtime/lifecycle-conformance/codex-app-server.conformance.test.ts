/**
 * The real CodexChatDriver through the lifecycle conformance suite, over the
 * scripted app-server in codex-app-server-fake.ts.
 */
import { vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('child_process')>(), spawn: vi.fn() }));
vi.mock('../chat-transcript', () => ({ appendChatEvent: vi.fn(async () => undefined), readChatTranscript: vi.fn(async () => []) }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import { spawn } from 'child_process';
import { describeChatLifecycleConformance } from './conformance-suite';
import { codexConformanceSubject } from './codex-app-server-fake';

describeChatLifecycleConformance(codexConformanceSubject(vi.mocked(spawn)), {
  prompt_settles_once: 'run',
  between_turns_prompt: 'run',
  steer_joins_running_turn: 'run',
  merged_submissions_leave_no_debt: 'run',
  client_queue_drains_once: 'run',
  interrupt_settles_as_reported: 'run',
  interrupt_unreported_stays_open: 'skipped: provider reports interrupts',
  permission_answered_once: 'run',
  permission_closed_by_provider: 'run',
  question_answered_once: 'run',
  question_closed_by_provider: 'run',
  disconnect_outcome_unknown: 'run',
  disconnect_held_input_stays_unsent: 'blocked: the driver\'s turn_ended on process exit drains held input into the exited process (lifecycle-gaps.test.ts)',
  disconnect_with_open_requests: 'run',
  send_failure_not_retried: 'run',
  replaced_session_ignored: 'run',
});
