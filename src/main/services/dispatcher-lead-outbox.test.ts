/** Messages typed while the lead Dispatcher's computer is offline (#3353). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LEAD_OUTBOX_EXPIRY_MS, LEAD_OUTBOX_MAX } from '../../shared/dispatcher-lead';

const files = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./settings-store', () => ({
  createSettingsStore: <T>(file: string, defaults: T) => ({
    get: () => (files.get(file) as T | undefined) ?? defaults,
    save: async (value: T) => { files.set(file, structuredClone(value)); },
  }),
}));

import {
  _resetLeadOutboxForTesting, dismissLeadOutboxNotice, flushLeadOutbox, leadOutboxState, queueForLead, startLeadOutbox,
} from './dispatcher-lead-outbox';

let connected = false;
let agentId: string | undefined = 'lead-chat';
let reply: (command: Record<string, unknown>) => unknown;
const sent: Array<{ text: unknown; commandId: string }> = [];
let connect: ((machine: string) => void) | undefined;
let live = true;
const woken: Array<{ text: unknown; commandId: string }> = [];
let wakeReply: () => unknown = () => ({ status: 'completed', result: { started: true } });
const receipts = new Map<string, { payload: string; receipt: unknown }>();
function leadReceipt(commandId: string, command: Record<string, unknown>, run: () => unknown): unknown {
  const payload = JSON.stringify(command);
  const kept = receipts.get(commandId);
  if (kept) return kept.payload === payload ? kept.receipt : { status: 'rejected', error: { code: 'command_conflict' } };
  const receipt = run();
  receipts.set(commandId, { payload, receipt });
  return receipt;
}

beforeEach(() => {
  files.clear(); sent.length = 0; woken.length = 0; live = true; receipts.clear();
  wakeReply = () => ({ status: 'completed', result: { started: true } });
  connected = false; agentId = 'lead-chat';
  reply = () => ({ status: 'completed', result: { delivery: 'prompt' } });
  _resetLeadOutboxForTesting();
  startLeadOutbox({
    connected: () => connected,
    dispatcherAgentId: () => agentId,
    chatSession: async () => ({ sessionId: 'sess', live }),
    // Like the lead's MobileCommandService: a command id's receipt is kept, refusals included,
    // and the same id with other content is command_conflict.
    send: async (_machine, command, commandId) => leadReceipt(commandId, command, () => { sent.push({ text: command.text, commandId }); return reply(command); }),
    wake: async (_machine, agentId, message, commandId) => leadReceipt(commandId, { type: 'agent.start', agentId, message }, () => { woken.push({ text: message, commandId }); return wakeReply(); }),
    onConnected: (listener) => { connect = listener; return () => { connect = undefined; }; },
  });
});

const NOW = Date.parse('2026-11-13T10:00:00Z');

describe('the lead outbox (#3353)', () => {
  it('keeps messages while the lead is offline and sends them in order, once each, when it is back', async () => {
    await queueForLead('LAPTOP', 'first', NOW);
    await queueForLead('laptop', 'second', NOW + 1);
    expect(sent).toEqual([]);
    expect(leadOutboxState('laptop', NOW + 2)).toMatchObject({ waiting: 2, oldestAt: new Date(NOW).toISOString() });
    connected = true;
    connect!('laptop');
    await vi.waitFor(() => expect(sent.map((s) => s.text)).toEqual(['first', 'second']));
    expect(leadOutboxState('laptop').waiting).toBe(0);
    await flushLeadOutbox('laptop');
    expect(sent).toHaveLength(2);
  });

  it('keeps one command id across tries, so the lead takes a message once', async () => {
    await queueForLead('laptop', 'hello', NOW);
    connected = true;
    reply = () => { throw new Error('socket closed'); };
    await flushLeadOutbox('laptop', NOW);
    reply = () => ({ status: 'completed' });
    await flushLeadOutbox('laptop', NOW);
    expect(sent).toHaveLength(2);
    expect(sent[0].commandId).toBe(sent[1].commandId);
    expect(leadOutboxState('laptop').waiting).toBe(0);
  });

  it('waits while the lead’s Dispatcher is off there', async () => {
    await queueForLead('laptop', 'hello', NOW);
    connected = true; agentId = undefined;
    await flushLeadOutbox('laptop', NOW);
    expect(sent).toEqual([]);
    expect(leadOutboxState('laptop').waiting).toBe(1);
  });

  it('drops a refused message and says why, then sends the next', async () => {
    await queueForLead('laptop', 'bad', NOW);
    await queueForLead('laptop', 'good', NOW);
    connected = true;
    reply = (command) => (command.text === 'bad'
      ? { status: 'rejected', error: { code: 'invalid_command', message: 'The lead refused it.' } }
      : { status: 'completed' });
    await flushLeadOutbox('laptop', NOW);
    expect(sent.map((s) => s.text)).toEqual(['bad', 'good']);
    expect(leadOutboxState('laptop')).toMatchObject({ waiting: 0, failed: 'The lead refused it.' });
    await dismissLeadOutboxNotice();
    expect(leadOutboxState('laptop').failed).toBeNull();
  });

  it('drops what waited more than a day, counting it, without sending it', async () => {
    await queueForLead('laptop', 'old', NOW);
    connected = true;
    await flushLeadOutbox('laptop', NOW + LEAD_OUTBOX_EXPIRY_MS);
    expect(sent).toEqual([]);
    expect(leadOutboxState('laptop')).toMatchObject({ waiting: 0, expired: 1 });
  });

  it('is bounded', async () => {
    for (let i = 0; i < LEAD_OUTBOX_MAX; i++) await queueForLead('laptop', `m${i}`, NOW);
    await expect(queueForLead('laptop', 'one more', NOW)).rejects.toThrow(`${LEAD_OUTBOX_MAX} messages are already waiting`);
    await expect(queueForLead('laptop', '   ', NOW)).rejects.toThrow('nothing to send');
    await expect(queueForLead('laptop', 'x'.repeat(40_000), NOW)).rejects.toThrow('too long');
  });

  it('sends each message to the computer it was written for', async () => {
    await queueForLead('laptop', 'for laptop', NOW);
    await queueForLead('desk', 'for desk', NOW);
    connected = true;
    await flushLeadOutbox('desk', NOW);
    expect(sent.map((s) => s.text)).toEqual(['for desk']);
    expect(leadOutboxState('laptop').waiting).toBe(1);
  });

  it('wakes a lead chat that is asleep there with the waiting message as its first', async () => {
    await queueForLead('laptop', 'wake up', NOW);
    connected = true; live = false;
    await flushLeadOutbox('laptop', NOW);
    expect(sent).toEqual([]);
    expect(woken.map((w) => w.text)).toEqual(['wake up']);
    expect(leadOutboxState('laptop').waiting).toBe(0);
  });

  it('keeps a message the lead answered “not now”, and tries again shortly', async () => {
    vi.useFakeTimers();
    try {
      await queueForLead('laptop', 'later', NOW);
      connected = true;
      reply = () => ({ status: 'rejected', error: { code: 'session_mismatch' } });
      await flushLeadOutbox('laptop', NOW);
      expect(leadOutboxState('laptop', NOW)).toMatchObject({ waiting: 1, failed: null });
      reply = () => ({ status: 'completed' });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent.map((s) => s.text)).toEqual(['later', 'later']);
      // A new command, so the lead doesn't answer with the kept refusal.
      expect(sent[1].commandId).not.toBe(sent[0].commandId);
      expect(leadOutboxState('laptop', NOW).waiting).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wakes again with a new command after the lead said its chat was already starting', async () => {
    vi.useFakeTimers();
    try {
      await queueForLead('laptop', 'hello', NOW);
      connected = true; live = false;
      wakeReply = () => ({ status: 'rejected', error: { code: 'agent_already_running' } });
      await flushLeadOutbox('laptop', NOW);
      expect(leadOutboxState('laptop', NOW)).toMatchObject({ waiting: 1, failed: null });
      live = true;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent.map((s) => s.text)).toEqual(['hello']);
      expect(sent[0].commandId).not.toBe(woken[0].commandId);
      expect(leadOutboxState('laptop', NOW)).toMatchObject({ waiting: 0, failed: null });
    } finally {
      vi.useRealTimers();
    }
  });
});
