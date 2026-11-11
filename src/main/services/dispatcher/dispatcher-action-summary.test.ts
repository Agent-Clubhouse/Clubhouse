import { beforeEach, expect, it, vi } from 'vitest';
import type { ActionView } from '../../../shared/actions';

const h = vi.hoisted(() => ({ running: true, addNotice: vi.fn(async () => undefined) }));
vi.mock('./dispatcher-service', () => ({ getDispatcherChatAgentId: () => 'conversation' }));
vi.mock('../agent-runtime', () => ({ getAgentRuntime: () => ({ isRunning: () => h.running, addNotice: h.addNotice }) }));
vi.mock('../agent-runtime/stale-session', () => ({ noteNextStartNotice: vi.fn() }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
import { showDispatcherActionSummary } from './dispatcher-action-summary';
import { noteNextStartNotice } from '../agent-runtime/stale-session';

const action: ActionView = {
  id: 'a1', name: 'Morning', owner: { kind: 'dispatcher' }, enabled: true, running: false,
  trigger: { kind: 'schedule', preset: 'daily', cron: '0 9 * * *', missed: 'skip' },
  steps: [{ kind: 'notify', text: 'Ready' }], overlap: 'skip', createdAt: 1, updatedAt: 1,
};
const names = { agent: () => undefined, project: () => undefined };

beforeEach(() => { vi.clearAllMocks(); h.running = true; });

it('writes the coordinator change into the separate conversation transcript without a prompt', async () => {
  await showDispatcherActionSummary(action, names);
  expect(h.addNotice).toHaveBeenCalledWith(expect.objectContaining({
    code: 'action_changed',
    actionSummary: { id: 'a1', name: 'Morning', trigger: 'Every day at 9:00 AM', steps: 'Notify you', enabled: true },
  }));
  expect(noteNextStartNotice).not.toHaveBeenCalled();
});

it('keeps the receipt for the conversation start when it is asleep', async () => {
  h.running = false;
  await showDispatcherActionSummary({ ...action, enabled: false }, names);
  expect(h.addNotice).not.toHaveBeenCalled();
  expect(noteNextStartNotice).toHaveBeenCalledWith('conversation', expect.objectContaining({ actionSummary: expect.objectContaining({ enabled: false }) }));
});
