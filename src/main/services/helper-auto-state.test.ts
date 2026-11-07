import { beforeEach, describe, expect, it, vi } from 'vitest';

const W = vi.hoisted(() => ({
  value: { version: 1, cursors: {} } as { version: 1; cursors: Record<string, { key: string; at: number }> },
  saveFails: false,
  saves: 0,
  log: vi.fn(),
}));

vi.mock('./settings-store', () => ({
  createSettingsStore: () => ({
    get: () => W.value,
    save: async (next: typeof W.value) => {
      // Like the real store: in memory first, then the write.
      W.value = next;
      W.saves++;
      if (W.saveFails) throw new Error('disk full');
    },
    update: async () => W.value,
  }),
}));
vi.mock('./log-service', () => ({ appLog: W.log }));

import {
  AUTO_MAX_ROTATION_CURSORS,
  _resetHelperAutoStateForTesting,
  autoDecisionFor,
  commitAutoDecision,
  reservationSummary,
  reservedLoad,
  reserveAutoDecision,
  rotationCursors,
  settleAutoDecision,
} from './helper-auto-state';

const none = new Set<string>();

beforeEach(() => {
  _resetHelperAutoStateForTesting();
  W.value = { version: 1, cursors: {} };
  W.saveFails = false;
  W.saves = 0;
  W.log.mockClear();
});

describe('reservations', () => {
  it('count once through creation, start and the first count that sees the helper live', () => {
    reserveAutoDecision('d1', { provider: 'claude-code', key: 'claude-code:default' });
    // Before the row exists.
    expect(reservedLoad(none)).toEqual({ 'claude-code': 1 });
    commitAutoDecision('d1', 'h1');
    expect(autoDecisionFor('h1')).toBe('d1');
    // The row counts it now, so the reservation doesn't.
    expect(reservedLoad(new Set(['h1']))).toEqual({});
    // A count that didn't see the row live (between status reads) still has it.
    expect(reservedLoad(none)).toEqual({ 'claude-code': 1 });
    settleAutoDecision('d1', 'started');
    // Started: dropped by the next count either way, never counted on top of the row.
    expect(reservedLoad(new Set(['h1']))).toEqual({});
    expect(reservedLoad(none)).toEqual({});
    expect(autoDecisionFor('h1')).toBeUndefined();
  });

  it.each(['creation_refused', 'cancelled', 'spawn_failed', 'left_asleep'] as const)('%s releases at once', (result) => {
    reserveAutoDecision('d1', { provider: 'codex-cli', key: 'codex-cli:default' });
    if (result !== 'creation_refused') commitAutoDecision('d1', 'h1');
    settleAutoDecision('d1', result);
    expect(reservedLoad(none)).toEqual({});
  });

  it('started before it was committed is a refusal, not a held reservation', () => {
    reserveAutoDecision('d1', { provider: 'codex-cli', key: 'codex-cli:default' });
    settleAutoDecision('d1', 'started');
    expect(reservedLoad(none)).toEqual({});
  });

  it('never expire: an unsettled one is kept and its age reported', () => {
    reserveAutoDecision('d1', { provider: 'codex-cli', key: 'codex-cli:default' }, 1_000);
    expect(reservationSummary(1_000 + 3_600_000)).toEqual({ held: 1, oldestAgeMs: 3_600_000 });
    expect(reservedLoad(none)).toEqual({ 'codex-cli': 1 });
  });

  it('settle twice, commit twice: nothing changes the second time', () => {
    reserveAutoDecision('d1', { provider: 'codex-cli', key: 'codex-cli:default', rotation: { cursorKey: 's', key: 'codex-cli:default' } });
    commitAutoDecision('d1', 'h1');
    commitAutoDecision('d1', 'h2');
    expect(autoDecisionFor('h1')).toBe('d1');
    expect(W.saves).toBe(1);
    settleAutoDecision('d1', 'spawn_failed');
    settleAutoDecision('d1', 'started');
    expect(reservedLoad(none)).toEqual({});
  });
});

describe('rotation', () => {
  it('moves only when a decision commits', () => {
    reserveAutoDecision('d1', { provider: 'codex-cli', key: 'codex-cli:default', rotation: { cursorKey: 's', key: 'codex-cli:default' } });
    expect(rotationCursors()).toEqual({});
    settleAutoDecision('d1', 'creation_refused');
    expect(rotationCursors()).toEqual({});
    expect(W.saves).toBe(0);

    reserveAutoDecision('d2', { provider: 'codex-cli', key: 'codex-cli:default', rotation: { cursorKey: 's', key: 'codex-cli:default' } });
    commitAutoDecision('d2', 'h2');
    expect(rotationCursors()).toEqual({ s: 'codex-cli:default' });
  });

  it('a failed save keeps this run rotating from memory, and says so', async () => {
    W.saveFails = true;
    reserveAutoDecision('d1', { provider: 'codex-cli', key: 'codex-cli:default', rotation: { cursorKey: 's', key: 'codex-cli:default' } });
    commitAutoDecision('d1', 'h1');
    await vi.waitFor(() => expect(W.log).toHaveBeenCalledWith('core:mcp', 'warn', 'Auto: could not save the rotation', expect.anything()));
    expect(rotationCursors()).toEqual({ s: 'codex-cli:default' });
  });

  it('keeps the most recent sets when there are too many', () => {
    for (let i = 0; i <= AUTO_MAX_ROTATION_CURSORS; i++) {
      reserveAutoDecision(`d${i}`, { provider: 'codex-cli', key: 'k', rotation: { cursorKey: `s${i}`, key: 'k' } });
      commitAutoDecision(`d${i}`, `h${i}`, 1_000 + i);
    }
    const kept = Object.keys(rotationCursors());
    expect(kept).toHaveLength(AUTO_MAX_ROTATION_CURSORS);
    expect(kept).not.toContain('s0');
  });
});
